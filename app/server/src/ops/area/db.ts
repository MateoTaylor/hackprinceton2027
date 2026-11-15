import { type DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { OpError } from '../op.ts'

const BUILD_HINT = 'Run `pnpm --dir app/server build:area`'
const instances = new Map<string, Promise<DuckDBInstance>>()

async function open(path: string) {
  try {
    await access(path)
  } catch {
    throw new OpError('not_ready', 'The area data is not built yet.', BUILD_HINT)
  }
  return DuckDBInstance.create(path, { access_mode: 'READ_ONLY', autoinstall_known_extensions: 'false' })
}

// Runs `use` on a fresh read-only connection to `<dataDir>/area.duckdb` with `spatial` loaded, and
// closes the connection after. The database stays open for the life of the process. A missing
// file throws `not_ready`, and the next call looks for it again.
//   const rows = await withArea(ctx.dataDir, (db) => db.runAndReadAll('SELECT count(*) FROM places'))
export async function withArea<T>(dataDir: string, use: (db: DuckDBConnection) => Promise<T>): Promise<T> {
  const path = join(dataDir, 'area.duckdb')
  let instance = instances.get(path)
  if (!instance) {
    instance = open(path)
    instance.catch(() => instances.delete(path))
    instances.set(path, instance)
  }
  const connection = await (await instance).connect()
  try {
    await connection.run('LOAD spatial')
    return await use(connection)
  } finally {
    connection.closeSync()
  }
}
