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
  await connection.run('CREATE TABLE hidden AS SELECT 42 AS secret')
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
  await rejects("SELECT * FROM read_text('../../.env')", /`read_text\(\)`/)
  await rejects("SELECT * FROM read_csv('/etc/hosts')", /`read_csv\(\)`/)
  await rejects("SELECT * FROM 'search.duckdb.wal'", /`search\.duckdb\.wal`/)
})

test('catalog functions and views that reveal paths are refused', async () => {
  await rejects('SELECT * FROM duckdb_databases()', /`duckdb_databases/)
  await rejects('SELECT path FROM main.duckdb_databases()', /`duckdb_databases/)
  await rejects('SELECT * FROM duckdb_settings()', /`duckdb_settings/)
  await rejects('SELECT * FROM pragma_database_list', /`pragma_database_list`/)
  await rejects('SELECT * FROM pragma_table_info(\'search\')', /`pragma_table_info/)
  await rejects('SELECT * FROM pg_settings', /`pg_settings`/)
  await rejects('SELECT * FROM sqlite_master', /`sqlite_master`/)
  await rejects('SELECT * FROM information_schema.tables', /`tables`/)
  await rejects('SELECT (SELECT count(*) FROM duckdb_tables()) FROM search', /`duckdb_tables/)
})

test('settings functions are refused', async () => {
  await rejects("SELECT current_setting('temp_directory')", /`current_setting`/)
  await rejects("SELECT id FROM search WHERE current_setting('home_directory') IS NOT NULL", /`current_setting`/)
  await rejects("SELECT getvariable('x')", /`getvariable`/)
})

test('SQL run from a string, SHOW and DESCRIBE are refused', async () => {
  await rejects("SELECT * FROM query('SELECT * FROM duckdb_databases()')", /`query\(\)`/)
  await rejects("SELECT * FROM query_table('pg_settings')", /`query_table\(\)`/)
  await rejects('SELECT * FROM (SHOW DATABASES)', /show statement/)
  await rejects('SELECT * FROM (DESCRIBE search)', /show statement/)
})

test('settings folded at bind time never reach an error message', async () => {
  await rejects("SELECT struct_extract({'a': 1}, current_setting('temp_directory'))", /^The query reads `current_setting`, which is not allowed\.$/)
  await rejects("SELECT * FROM query_table(current_setting('temp_directory'))", /^The query reads `query_table\(\)`, which is not allowed\.$/)
})

test('a quotable error that holds an absolute path gets the fixed message', async () => {
  await rejects("SELECT struct_extract({'a': 1}, '/Users/someone/tmp')", /^The query failed while it ran\.$/)
  await rejects("SELECT struct_extract({'a': 1}, 'C:\\Users\\someone')", /^The query failed while it ran\.$/)
})

test('a CTE counts only in the scope that can see it', async () => {
  await rejects('SELECT * FROM (WITH hidden AS (SELECT 2) SELECT 1 AS y) t, hidden', /`hidden`/)
  await rejects('WITH a AS (SELECT * FROM hidden), hidden AS (SELECT 1) SELECT * FROM a', /`hidden`/)
  const nested = await search.query('WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT (SELECT x FROM b) AS x')
  assert.deepEqual(nested.rows, [[1]])
})

test('a CTE cannot shadow a catalog name, and CTEs, range and unnest still work', async () => {
  await rejects('WITH pragma_database_list AS (SELECT 1) SELECT * FROM pragma_database_list', /CTE named/)
  const result = await search.query('WITH t AS (SELECT id FROM search WHERE stories < 2) SELECT t.id, r.range FROM t, range(1) r ORDER BY t.id')
  assert.deepEqual(result.rows, [['commercial-0', 0], ['commercial-1', 0]])
  assert.deepEqual((await search.query('SELECT unnest([1, 2]) AS n')).rows, [[1], [2]])
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
