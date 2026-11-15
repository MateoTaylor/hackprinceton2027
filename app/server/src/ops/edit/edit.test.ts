import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { Property } from '../../../../shared/property.ts'
import { createDiskCache } from '../../cache.ts'
import { createVexcel } from '../../vexcel.ts'
import { type OpContext, runOp } from '../op.ts'
import { matchCommand, picturePath, readDrop, type PreparedEdit } from './drop.ts'
import { pictureEditApply, pictureEditList } from './index.ts'
import { PICTURE_ROUTE, servePicture } from './pictures.ts'

const DEMO = 'residential-1'
const OTHER = 'residential-2'

const edits: PreparedEdit[] = [
  { id: 'lamp', tool: 'erase', command: 'Remove the floor lamp', before: 'lamp-before.png', after: 'lamp-after.png' },
  { id: 'counter', tool: 'remodel', command: 'Make the countertop white marble', before: 'c-before.png', after: 'c-after.png' },
  { id: 'floor', tool: 'remodel', command: 'Change the floor to light oak', before: 'f-before.png', after: 'f-after.png' },
]

const property = (id: string): Property => ({ id, kind: 'residential', costarId: id, name: 'A', address: 'A', lat: 34, lon: -118, typeLabel: 'House', facts: [], photoUrl: null, scans: [] })

// A data folder whose demo property has a drop folder holding `manifest` and every picture it names.
async function dataDir(manifest: unknown = { edits }) {
  const dir = await mkdtemp(join(tmpdir(), 'propstar-edit-test-'))
  const folder = join(dir, 'edits', DEMO)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest))
  await Promise.all(edits.flatMap(({ before, after }) => [before, after]).map((name) => writeFile(join(folder, name), 'png')))
  return dir
}

async function context(dir: string): Promise<OpContext> {
  return {
    properties: new Map([DEMO, OTHER].map((id) => [id, property(id)])),
    vexcel: createVexcel({ apiKey: 'k', cache: createDiskCache(join(dir, 'cache')) }),
    matterport: null,
    buildingFacts: new Map(),
    dataDir: dir,
    edit: async () => {
      throw new Error('picture ops never call the edit API')
    },
    call: async () => {
      throw new Error('picture ops never call another op')
    },
  }
}

test('the manifest parses, and a bad one, a duplicate id or a missing picture is reported', async () => {
  const drop = await readDrop(await dataDir(), DEMO)
  assert.ok('edits' in drop)
  assert.equal(drop.edits.length, 3)
  assert.deepEqual(await readDrop(await dataDir(), OTHER), { problem: 'missing' })
  assert.deepEqual(await readDrop(await dataDir({ edits: [{ ...edits[0], before: '../x.png' }] }), DEMO), { problem: 'invalid' })
  assert.deepEqual(await readDrop(await dataDir({ edits: [edits[0], edits[0]] }), DEMO), { problem: 'invalid' })
  assert.deepEqual(await readDrop(await dataDir({ edits: [{ ...edits[0], after: 'gone.png' }] }), DEMO), { problem: 'incomplete' })
})

test('a command matches on its meaningful words, within the tool asked for', () => {
  const id = (tool: 'erase' | 'remodel', command: string) => matchCommand(edits, tool, command)?.id ?? null
  assert.equal(id('erase', 'Remove the floor lamp'), 'lamp')
  assert.equal(id('erase', 'erase the lamp please'), 'lamp')
  assert.equal(id('erase', 'get rid of the floor lamps'), 'lamp')
  assert.equal(id('remodel', 'make the countertops marble'), 'counter')
  assert.equal(id('remodel', 'change the floor to light oak'), 'floor')
  assert.equal(id('remodel', 'remove the floor lamp'), null)
  assert.equal(id('erase', 'remove the sofa'), null)
  assert.equal(id('erase', 'remove the'), null)
})

test('picture_edit_apply answers the prepared pictures, and an unknown command names the ones that exist', async () => {
  const ctx = await context(await dataDir())
  const applied = await runOp(pictureEditApply, ctx, { propertyId: DEMO, tool: 'erase', command: 'erase the lamp' })
  assert.ok(applied.ok)
  assert.deepEqual([applied.result.editId, applied.result.afterUrl], ['lamp', `/api/edits/${DEMO}/lamp-after.png`])
  assert.match(applied.result.assumptions[0], /prepared demo edit/)

  const unknown = await runOp(pictureEditApply, ctx, { propertyId: DEMO, tool: 'remodel', command: 'paint the walls green' })
  assert.ok(!unknown.ok)
  assert.equal(unknown.error.code, 'no_data')
  assert.match(unknown.error.hint, /"Make the countertop white marble", "Change the floor to light oak"/)

  const elsewhere = await runOp(pictureEditList, ctx, { propertyId: OTHER })
  assert.ok(!elsewhere.ok)
  assert.equal(elsewhere.error.code, 'no_data')
  assert.match(elsewhere.error.hint, new RegExp(DEMO))

  const listed = await runOp(pictureEditList, ctx, { propertyId: DEMO, tool: 'remodel' })
  assert.ok(listed.ok)
  assert.deepEqual(listed.result.edits.map(({ editId }) => editId), ['counter', 'floor'])
})

test('the picture route serves drop-folder pictures and refuses names that leave the folder', async () => {
  const dir = await dataDir()
  assert.equal(picturePath(dir, DEMO, '../manifest.json'), null)
  assert.equal(picturePath(dir, '..', 'lamp-after.png'), null)
  assert.equal(picturePath(dir, DEMO, '.env.png'), null)
  assert.equal(picturePath(dir, DEMO, 'manifest.json'), null)

  const app = new Hono().get(PICTURE_ROUTE, servePicture(dir))
  const ok = await app.request(`/api/edits/${DEMO}/lamp-after.png`)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/png')
  assert.equal((await app.request(`/api/edits/${DEMO}/%2e%2e%2fsecret.png`)).status, 400)
  assert.equal((await app.request(`/api/edits/${DEMO}/missing.png`)).status, 404)
})
