import { DuckDBInstance } from '@duckdb/node-api'
import { z } from 'zod'
import type { Property, PropertyKind } from '../../shared/property.ts'

const Row = z
  .object({
    id: z.string(),
    kind: z.enum(['commercial', 'residential'] satisfies PropertyKind[]),
    costar_id: z.string(),
    name: z.string(),
    address: z.string(),
    lat: z.number(),
    lon: z.number(),
    type_label: z.string(),
    photo_url: z.string().nullable(),
    facts: z.array(z.object({ label: z.string(), value: z.string() })),
    scans: z.array(z.object({ model_id: z.string(), name: z.string() })),
  })
  .transform(
    (row): Property => ({
      id: row.id,
      kind: row.kind,
      costarId: row.costar_id,
      name: row.name,
      address: row.address,
      lat: row.lat,
      lon: row.lon,
      typeLabel: row.type_label,
      facts: row.facts,
      photoUrl: row.photo_url,
      scans: row.scans.map((s) => ({ modelId: s.model_id, name: s.name })),
    }),
  )

// Reads every curated property, ordered by id, and closes the database so `pnpm build:data` can
// rewrite it. The server holds the result for its lifetime; restart it after a rebuild.
export async function loadProperties(dbPath: string) {
  const db = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' })
  try {
    const connection = await db.connect()
    try {
      const reader = await connection.runAndReadAll(
        'SELECT id, kind, costar_id, name, address, lat, lon, type_label, photo_url, facts, scans FROM properties ORDER BY id',
      )
      return z.array(Row).parse(reader.getRowObjectsJS())
    } finally {
      connection.closeSync()
    }
  } finally {
    db.closeSync()
  }
}
