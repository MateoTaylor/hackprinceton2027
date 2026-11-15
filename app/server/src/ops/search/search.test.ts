import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { DuckDBInstance } from '@duckdb/node-api'
import { OpError, RESULT_MAX_CHARS } from '../op.ts'
import { openSearch, type Search } from './query.ts'

let search: Search
let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'propstar-search-test-'))
  const db = await DuckDBInstance.create(join(dir, 'search.duckdb'))
  const connection = await db.connect()
  await connection.run(`
    CREATE TABLE search AS SELECT 'commercial-' || i AS id, 'Invented ' || i AS name, 'xyz' || repeat('x', 200) AS blurb, i AS stories, 'abc' AS code
    FROM range(150) t(i)`)
  connection.closeSync()
  db.closeSync()
  search = await openSearch(join(dir, 'search.duckdb'), 300)
})

after(() => search.close())

const rejects = (sql: string, message: RegExp) =>
  assert.rejects(search.query(sql), (error) => error instanceof OpError && error.code === 'invalid_input' && message.test(error.message))

test('a SELECT returns columns and rows as arrays', async () => {
  const result = await search.query('SELECT id, stories FROM search WHERE stories < 3 ORDER BY stories')
  assert.deepEqual(result.columns, ['id', 'stories'])
  assert.deepEqual(result.rows, [['commercial-0', 0], ['commercial-1', 1], ['commercial-2', 2]])
  assert.equal(result.rowCount, 3)
  assert.equal(result.truncated, false)
})

test('a trailing comment and semicolon pass', async () => {
  const result = await search.query('SELECT count(*) AS n FROM search; -- every row')
  assert.deepEqual(result.rows, [[150]])
})

test('more than 100 rows truncates', async () => {
  const result = await search.query('SELECT id FROM search')
  assert.equal(result.rowCount, 100)
  assert.equal(result.truncated, true)
})

test('rows drop from the end until the result fits the size cap', async () => {
  const result = await search.query('SELECT blurb FROM search', 500)
  assert.ok(result.rowCount < 100)
  assert.equal(result.truncated, true)
  assert.ok(JSON.stringify(result).length + 500 <= RESULT_MAX_CHARS)
})

test('writes, two statements and settings are refused', async () => {
  await rejects('DELETE FROM search', /Only one SELECT/)
  await rejects('SELECT 1; SELECT 2', /Only one SELECT/)
  await rejects("SET enable_external_access = 'true'", /Only one SELECT/)
  await rejects("ATTACH '/tmp/x.duckdb' AS x", /Only one SELECT/)
})

test('files stay out of reach', async () => {
  await rejects("SELECT * FROM read_text('../../.env')", /^The query failed while it ran\.$/)
  await rejects("SELECT * FROM read_csv('/etc/hosts')", /^The query failed while it ran\.$/)
  await rejects("SELECT * FROM 'search.duckdb.wal'", /^The query failed while it ran\.$|^Catalog Error/)
})

test('an unbalanced bracket fails with the parser line', async () => {
  await rejects('SELECT (id FROM search', /^Parser Error: /)
})

test('an unknown column quotes the binder line only', async () => {
  await rejects('SELECT nope FROM search', /^Binder Error: [^\n]*nope/)
})

test('a runtime error gets a fixed message that quotes no cell', async () => {
  await rejects('SELECT CAST(code AS INTEGER) FROM search', /^The query failed while it ran\.$/)
})

test('a slow query is interrupted', async () => {
  await rejects('SELECT count(*) FROM range(1000000000000) a', /longer than/)
})

test('a missing file is not_ready', async () => {
  await assert.rejects(openSearch(join(dir, 'missing.duckdb')), (error) => error instanceof OpError && error.code === 'not_ready')
})
