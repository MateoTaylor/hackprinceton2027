import { DuckDBInstance, DuckDBTypeId, StatementType, type DuckDBResultReader } from '@duckdb/node-api'
import { OpError, RESULT_MAX_CHARS } from '../op.ts'

export const MAX_ROWS = 100
export const TIMEOUT_MS = 2000

// Error classes whose first line quotes only the query text and table or column names. Every other
// error (a conversion error, say) can quote a cell, so it gets a fixed message.
const QUOTABLE = /(Parser|Binder|Catalog) Error: .*/
const WIDE_INTEGERS = new Set([DuckDBTypeId.BIGINT, DuckDBTypeId.UBIGINT, DuckDBTypeId.HUGEINT, DuckDBTypeId.UHUGEINT])

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
      const extracted = await connection.extractStatements(sql)
      const prepared = extracted.count === 1 ? await extracted.prepare(0) : null
      if (prepared?.statementType !== StatementType.SELECT) {
        throw new OpError('invalid_input', 'Only one SELECT or WITH statement is allowed.', 'Send a single read-only SELECT.')
      }
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
      const quotable = error instanceof Error ? error.message.split('\n')[0].match(QUOTABLE)?.[0] : undefined
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
