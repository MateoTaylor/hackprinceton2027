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

const FactsRow = z
  .object({
    property_id: z.string(),
    stories: z.number().nullable(),
    slab_to_slab_ft: z.number().nullable(),
    building_sf: z.number().nullable(),
    floors: z.array(z.object({ code: z.number(), size_sf: z.number().nullable() })),
  })
  .transform((row) => ({
    propertyId: row.property_id,
    stories: row.stories,
    slabToSlabFt: row.slab_to_slab_ft,
    buildingSf: row.building_sf,
    floors: row.floors.map((f) => ({ code: f.code, sizeSf: f.size_sf })),
  }))

// The CoStar fields a building model needs. `floors` lists CoStar FloorName codes with each floor's
// gross area, which is null when CoStar has none.
export type BuildingFacts = z.output<typeof FactsRow>

// Closes the database after the query, so `pnpm build:data` can rewrite it while the server holds
// the result.
async function readAll(dbPath: string, sql: string) {
  const db = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' })
  try {
    const connection = await db.connect()
    try {
      return (await connection.runAndReadAll(sql)).getRowObjectsJS()
    } finally {
      connection.closeSync()
    }
  } finally {
    db.closeSync()
  }
}

// Reads every curated property, ordered by id. The server holds the result for its lifetime;
// restart it after a rebuild.
export async function loadProperties(dbPath: string) {
  const rows = await readAll(
    dbPath,
    'SELECT id, kind, costar_id, name, address, lat, lon, type_label, photo_url, facts, scans FROM properties ORDER BY id',
  )
  return z.array(Row).parse(rows)
}

export async function loadBuildingFacts(dbPath: string): Promise<ReadonlyMap<string, BuildingFacts>> {
  const rows = await readAll(dbPath, 'SELECT property_id, stories, slab_to_slab_ft, building_sf, floors FROM building_facts')
  return new Map(z.array(FactsRow).parse(rows).map((facts) => [facts.propertyId, facts]))
}
