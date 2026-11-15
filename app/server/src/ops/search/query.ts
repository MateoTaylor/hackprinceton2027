import { DuckDBInstance, DuckDBTypeId, StatementType, type DuckDBResultReader } from '@duckdb/node-api'
import { OpError, RESULT_MAX_CHARS } from '../op.ts'

export const MAX_ROWS = 100
export const TIMEOUT_MS = 2000

// Error classes whose first line quotes only the query text and table or column names. Every other
// error (a conversion error, say) can quote a cell, so it gets a fixed message. A quotable line that
// still holds something like an absolute path (`/Users/...`, `C:\...`, `~/...`) gets the fixed
// message too, in case a value folded at bind time slipped past the guard.
const QUOTABLE = /(Parser|Binder|Catalog) Error: .*/
const ABSOLUTE_PATH = /\/[^\s/'"]+\/|[A-Za-z]:[\\/]|~[\\/]/
const WIDE_INTEGERS = new Set([DuckDBTypeId.BIGINT, DuckDBTypeId.UBIGINT, DuckDBTypeId.HUGEINT, DuckDBTypeId.UHUGEINT])

// What a query may read. The catalog views and functions (`duckdb_databases()`,
// `pragma_database_list`, `pg_settings`, `current_setting('temp_directory')`, ...) return absolute
// paths and settings, and `query()` runs SQL from a string, so everything outside these lists is
// refused. Every catalog name that resolves without a schema carries one of the CATALOG prefixes.
const TABLES = new Set(['search', 'near_roads'])
const TABLE_FUNCTIONS = new Set(['range', 'generate_series', 'unnest'])
const TABLE_REFS = new Set(['BASE_TABLE', 'TABLE_FUNCTION', 'SUBQUERY', 'JOIN', 'EMPTY', 'EXPRESSION_LIST', 'PIVOT'])
const CATALOG = /^(duckdb_|pragma_|pg_|sqlite_)/
const SETTINGS_FUNCTIONS = new Set(['current_setting', 'getvariable'])

const refuse = (what: string) =>
  new OpError('invalid_input', `The query reads ${what}, which is not allowed.`, 'Read only the search and near_roads tables, with range, generate_series or unnest as the only table functions.')

type Node = { [key: string]: unknown }
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null

// Throws unless the parsed statement (DuckDB's `json_serialize_sql` tree) reads only TABLES, CTEs
// in scope and TABLE_FUNCTIONS, and calls no catalog or settings function. A CTE is in scope in the
// query node that defines it, below it, and in its own and later CTE bodies. Table references are
// the nodes with an `alias` and no expression `class`.
function guardTree(value: unknown, ctes: ReadonlySet<string> = new Set()): void {
  if (Array.isArray(value)) return value.forEach((item) => guardTree(item, ctes))
  if (!isNode(value)) return

  if (typeof value.function_name === 'string') {
    const name = value.function_name.toLowerCase()
    if (CATALOG.test(name) || SETTINGS_FUNCTIONS.has(name)) throw refuse(`\`${name}\``)
  }
  if (typeof value.type === 'string' && 'alias' in value && !('class' in value)) {
    if (!TABLE_REFS.has(value.type)) throw refuse(`a ${value.type.toLowerCase().replace('_ref', '')} statement`)
    if (value.type === 'BASE_TABLE') {
      const name = String(value.table_name).toLowerCase()
      const qualified = value.catalog_name !== '' || !['', 'main'].includes(String(value.schema_name).toLowerCase())
      if (qualified || !(TABLES.has(name) || ctes.has(name)) || CATALOG.test(name)) throw refuse(`\`${name}\``)
    }
    if (value.type === 'TABLE_FUNCTION') {
      const name = isNode(value.function) ? String(value.function.function_name).toLowerCase() : ''
      if (!TABLE_FUNCTIONS.has(name)) throw refuse(`\`${name}()\``)
    }
  }

  const map = isNode(value.cte_map) && Array.isArray(value.cte_map.map) ? value.cte_map.map : []
  let scope = ctes
  for (const entry of map) {
    const name = isNode(entry) ? String(entry.key).toLowerCase() : ''
    if (CATALOG.test(name)) throw refuse(`a CTE named \`${name}\``)
    scope = new Set([...scope, name])
    guardTree(isNode(entry) ? entry.value : undefined, scope)
  }
  for (const [key, child] of Object.entries(value)) if (key !== 'cte_map') guardTree(child, scope)
}

// JSON rows, with the 64- and 128-bit integers that DuckDB serialises as strings (count(*), say)
// turned back into numbers when they fit.
function jsonRows(reader: DuckDBResultReader): unknown[][] {
  const wide = reader.columnTypes().map((type) => WIDE_INTEGERS.has(type.typeId))
  return reader.getRowsJson().map((row) =>
    row.map((value, i) => (wide[i] && typeof value === 'string' && Number.isSafeInteger(Number(value)) ? Number(value) : value)),
  )
}

export type QueryResult = { columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean }

// Opens a search database for guarded queries. External access is off, so `read_text('.env')` and
// friends fail, and the configuration lock stops SQL from turning it back on. A missing file is
// `not_ready`; the caller opens again on the next call.
//   const search = await openSearch(path)
//   const { columns, rows } = await search.query('SELECT id FROM search LIMIT 5', extraChars)
export async function openSearch(path: string, timeoutMs = TIMEOUT_MS) {
  let instance: DuckDBInstance
  try {
    instance = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY', enable_external_access: 'false', lock_configuration: 'true' })
  } catch {
    throw new OpError('not_ready', 'The search tables are not built.', 'Run `node pipeline/search.ts` in app/server.')
  }

  // Runs one SELECT on its own connection and reads at most MAX_ROWS rows. `reservedChars` is the
  // size of the rest of the op's result, so rows are dropped from the end until the whole result
  // fits RESULT_MAX_CHARS.
  async function query(sql: string, reservedChars = 0): Promise<QueryResult> {
    const connection = await instance.connect()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      connection.interrupt()
    }, timeoutMs)
    try {
      // Parse and guard before anything binds: binding folds constant arguments such as
      // `current_setting(...)` and can quote their values in its errors.
      const onlySelect = new OpError('invalid_input', 'Only one SELECT or WITH statement is allowed.', 'Send a single read-only SELECT.')
      const extracted = await connection.extractStatements(sql)
      if (extracted.count !== 1) throw onlySelect
      const serialized = await connection.runAndReadAll('SELECT json_serialize_sql($1::VARCHAR)', [sql])
      const tree: unknown = JSON.parse(String(serialized.getRowsJson()[0][0]))
      if (!isNode(tree) || tree.error !== false) throw onlySelect
      guardTree(tree.statements)
      const prepared = await extracted.prepare(0)
      if (prepared.statementType !== StatementType.SELECT) throw onlySelect
      const reader = await prepared.streamAndReadUntil(MAX_ROWS + 1)
      const all = jsonRows(reader)
      const columns = reader.columnNames()
      const rows = all.slice(0, MAX_ROWS)
      const size = () => JSON.stringify({ columns, rows, rowCount: rows.length, truncated: true }).length + reservedChars
      while (rows.length > 0 && size() > RESULT_MAX_CHARS) rows.pop()
      return { columns, rows, rowCount: rows.length, truncated: rows.length < all.length }
    } catch (error) {
      if (error instanceof OpError) throw error
      if (timedOut) throw new OpError('invalid_input', `The query ran longer than ${timeoutMs / 1000} s.`, 'Add a WHERE clause or a LIMIT.')
      const line = error instanceof Error ? error.message.split('\n')[0] : ''
      const quotable = ABSOLUTE_PATH.test(line) ? undefined : line.match(QUOTABLE)?.[0]
      if (quotable) throw new OpError('invalid_input', quotable.slice(0, 300), 'Fix the query against the tables in the sql field description.')
      throw new OpError('invalid_input', 'The query failed while it ran.', 'Check the column types and functions you used. Files and URLs are off.')
    } finally {
      clearTimeout(timer)
      connection.closeSync()
    }
  }

  return { query, close: () => instance.closeSync() }
}

export type Search = Awaited<ReturnType<typeof openSearch>>
