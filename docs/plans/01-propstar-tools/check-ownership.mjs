#!/usr/bin/env node
// Says who owns each file, from ownership.tsv in this folder, and fails when a file belongs to
// someone else.
//
//   node check-ownership.mjs                          check the table itself
//   node check-ownership.mjs --changed                every changed or untracked file
//   node check-ownership.mjs --staged --lane lane-a   staged files must all belong to lane-a
//   node check-ownership.mjs --files a.ts b.ts        the named files
//
// `--lane` repeats. With it, a file owned by anyone else fails. Without it, only a file under
// `app/` that no row covers fails. The longest matching row wins, and a row that ends in `/`
// covers the folder.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWNERS = ['foundation', 'lane-a', 'lane-b', 'lane-c', 'main']
const here = dirname(fileURLToPath(import.meta.url))
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const repo = git(['rev-parse', '--show-toplevel'], here).trim()

function fail(lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

function kindOnDisk(path) {
  try {
    return statSync(join(repo, path)).isDirectory() ? 'folder' : 'file'
  } catch {
    return null
  }
}

function readTable() {
  const [header, ...lines] = readFileSync(join(here, 'ownership.tsv'), 'utf8').split(/\r?\n/)
  const problems = []
  if (header !== 'path\towner\tnote') problems.push('line 1: the header must be path, owner, note, separated by tabs')
  const rows = new Map()
  lines.forEach((line, i) => {
    if (!line) return
    const at = `line ${i + 2}`
    const columns = line.split('\t')
    if (columns.length !== 3) return problems.push(`${at}: expected 3 tab-separated columns, found ${columns.length}`)
    const [path, owner] = columns
    if (!OWNERS.includes(owner)) problems.push(`${at}: unknown owner "${owner}"`)
    if (!path || /^[./]|\\/.test(path)) problems.push(`${at}: write "${path}" relative to the repo root with forward slashes`)
    if (rows.has(path)) problems.push(`${at}: "${path}" appears twice`)
    const kind = kindOnDisk(path)
    if (kind === 'folder' && !path.endsWith('/')) problems.push(`${at}: "${path}" is a folder, so end it with /`)
    if (kind === 'file' && path.endsWith('/')) problems.push(`${at}: "${path}" is a file, so drop the /`)
    rows.set(path, owner)
  })
  if (problems.length) fail(['ownership.tsv is not valid', ...problems])
  return rows
}

function ownerOf(rows, file) {
  let best = ''
  for (const path of rows.keys()) {
    const covers = path.endsWith('/') ? file.startsWith(path) : file === path
    if (covers && path.length > best.length) best = path
  }
  return rows.get(best) ?? null
}

// `git status --porcelain -z` follows a renamed or copied entry with its old name, which is skipped.
function changedFiles() {
  const fields = git(['status', '--porcelain', '-z', '--untracked-files=all'], repo).split('\0').filter(Boolean)
  const files = []
  for (let i = 0; i < fields.length; i++) {
    files.push(fields[i].slice(3))
    if (/[RC]/.test(fields[i].slice(0, 2))) i++
  }
  return files
}

const stagedFiles = () => git(['diff', '--cached', '--name-only', '-z'], repo).split('\0').filter(Boolean)

const fromRepoRoot = (file) => (isAbsolute(file) ? relative(repo, file) : file).replaceAll('\\', '/').replace(/^\.\//, '')

function parseArgs(argv) {
  const lanes = []
  let files = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--lane') {
      const lane = argv[++i]
      if (!OWNERS.includes(lane)) fail([`--lane takes one of ${OWNERS.join(', ')}`])
      lanes.push(lane)
    } else if (arg === '--changed' || arg === '--staged') {
      files = arg === '--changed' ? changedFiles() : stagedFiles()
    } else if (arg === '--files') {
      files = []
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) files.push(fromRepoRoot(argv[++i]))
    } else {
      fail([`unknown argument "${arg}"`, 'use --changed, --staged or --files <paths>, with any number of --lane <owner>'])
    }
  }
  return { lanes, files }
}

const rows = readTable()
const { lanes, files } = parseArgs(process.argv.slice(2))

if (!files) {
  console.log(`ownership.tsv is valid, ${rows.size} rows`)
  process.exit(0)
}

const owned = [...new Set(files)].sort().map((file) => ({ file, owner: ownerOf(rows, file) }))
for (const { file, owner } of owned) console.log(`${owner ?? '-'}\t${file}`)

const outside = owned.filter(({ file, owner }) => (lanes.length ? !lanes.includes(owner) : !owner && file.startsWith('app/')))
if (outside.length) {
  const want = lanes.length ? `owned by ${lanes.join(' or ')}` : 'covered by a row in ownership.tsv'
  fail([`${outside.length} of ${owned.length} files are not ${want}`, ...outside.map(({ file, owner }) => `  ${owner ?? 'no owner'}\t${file}`)])
}
console.log(`${owned.length} files checked`)
