// Builds data/propstar/propstar.duckdb, the curated property set the server and the agent read.
// Run it with `pnpm build:data`. It is deterministic, and reruns hit the Matterport cache only.
//
// Tables:
//   properties  one row per Property (app/shared/property.ts)
//     id, kind, costar_id, name, address, lat, lon, type_label, photo_url  display fields
//     facts  STRUCT(label VARCHAR, value VARCHAR)[]                         formatted display facts
//     scans  STRUCT(model_id VARCHAR, name VARCHAR)[]                       readable Matterport models
//     year_built, building_sf, units, stories, beds, baths,                 raw numbers for SQL,
//     price_usd, rent_usd_month                                             null when missing
//   scans  property_id, model_id, name                                      one row per readable model
//   building_facts  one row per property, the CoStar fields a building model needs
//     property_id, stories, slab_to_slab_ft, building_sf                   null when missing
//     floors  STRUCT(code INTEGER, size_sf DOUBLE)[]                        CoStar FloorName codes
import { DuckDBInstance } from '@duckdb/node-api'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { Property } from '../../shared/property.ts'

const KIT = new URL('../../../kit/costar-hackathon-kit/', import.meta.url)
const OUT = new URL('../../../data/propstar/', import.meta.url)
const CACHE = new URL('cache/matterport/', OUT)
const DB_PATH = fileURLToPath(new URL('propstar.duckdb', OUT))
const LOS_ANGELES_CITY = 'los angeles'
const LOS_ANGELES_MARKET = 20
const MAX_SCANS = 4

// How many properties of each type to keep, in display order. Land has no building to scan.
const COMMERCIAL_QUOTA: Record<string, { label: string; count: number }> = {
  Multifamily: { label: 'Multi-Family', count: 48 },
  Office: { label: 'Office', count: 40 },
  Industrial: { label: 'Industrial', count: 16 },
  GeneralRetail: { label: 'Retail', count: 16 },
  Flex: { label: 'Flex', count: 8 },
  Hospitality: { label: 'Hotel', count: 4 },
  Specialty: { label: 'Specialty', count: 4 },
  Healthcare: { label: 'Healthcare', count: 4 },
}
const RESIDENTIAL_QUOTA: Record<string, { label: string; count: number }> = {
  Detached: { label: 'Single Family', count: 36 },
  Condo: { label: 'Condo', count: 16 },
  Townhouse: { label: 'Townhouse', count: 8 },
}

const env = (name: string) => process.env[name] ?? fail(`${name} is missing from .env`)
function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

// ---------------------------------------------------------------- kit inputs

type CommercialRecord = {
  id: number
  buildingName?: string | null
  propertyType: number
  buildingClass?: number | null
  buildingRating?: number | null
  grossBuildingAreaSquareFeet?: number | null
  rentableBuildingAreaSquareFeet?: number | null
  numStoriesAboveGrade?: number | null
  floors?: { floorName: number; floorSize?: { squareFeet?: number | null } | null }[] | null
  propertyOffice?: Structural
  propertyRetail?: (Structural & { grossLeasableAreaSquareFeet?: number | null }) | null
  propertyIndustrial?: Structural
  propertyFlex?: Structural
  constructionEvents?: { eventType: number; year?: number | null }[] | null
  buildingConstructionMaterial?: number | null
  lotSize?: number | null
  lotSizeMeasurementType?: number | null
  parkingRatio?: number | null
  primaryPhoto?: { attachmentUri?: string | null } | null
  propertyApartment?: { totalNumUnits?: number | null; apartmentStyleType?: number | null } | null
  propertyHospitality?: { numUnits?: number | null } | null
  primaryAddress?: {
    streetNumber?: string | null
    streetDirection?: string | null
    streetName?: string | null
    streetType?: string | null
    streetSuffix?: string | null
    city?: string | null
    state?: string | null
    postcode?: string | null
    latitude?: number | null
    longitude?: number | null
    researchMarketId?: number | null
  } | null
}

type Structural = { structural?: { slabToSlabHeightFeet?: number | null } | null } | null

type ResidentialRecord = {
  id: number
  propertyId?: number | null
  transactionType?: number | null
  listingStatus?: number | null
  currentPrice?: number | null
  closePrice?: number | null
  isPrimaryForThisListingInstance?: boolean | null
  permissionLevels?: { homes?: number | null } | null
  media?: { type?: number | null; uri?: string | null; displayOrder?: number | null }[] | null
  property?: {
    address?: {
      fullStreetAddress?: string | null
      unitNumber?: string | null
      city?: string | null
      state?: string | null
      zip?: string | null
      latitude?: number | null
      longitude?: number | null
      buildingName?: string | null
    } | null
    propertyType?: number | null
    bedsMin?: number | null
    bathsMin?: number | null
    sqftMin?: number | null
    lotSizeAcresMin?: number | null
    yearBuilt?: number | null
    stories?: number | null
    totalParkingSpaces?: number | null
  } | null
}

// Streams one dataset from costar-hackathon-kit/data, one parsed record per line.
async function* records<T>(dataset: string): AsyncGenerator<T> {
  const lines = createInterface({ input: createReadStream(new URL(`data/${dataset}.jsonl`, KIT)) })
  for await (const line of lines) if (line) yield JSON.parse(line)
}

// Maps an enum-coded field to its schema name, because enums.json disagrees with the records.
type EnumSchema = { $defs: Record<string, { enum?: number[]; 'x-enum-varnames'?: string[] }> }

async function enumNames(schemaFile: string) {
  const { $defs }: EnumSchema = JSON.parse(await readFile(new URL(`schemas/${schemaFile}`, KIT), 'utf8'))
  return (def: string, value: number | null | undefined) => {
    const { enum: ids, 'x-enum-varnames': names } = $defs[def] ?? fail(`${schemaFile} has no enum ${def}`)
    if (!ids || !names) fail(`${schemaFile} enum ${def} has no names`)
    const name = value == null ? undefined : names[ids.indexOf(value)]
    return name === 'Unknown' || name === 'None' ? undefined : name
  }
}

// Reads a kit CSV of `<id>,...,<MatterportModelId>,...` rows into id -> model ids, in file order.
async function modelIdsByKey(file: string, keyColumn: string) {
  const [header, ...rows] = (await readFile(new URL(file, KIT), 'utf8')).trim().split(/\r?\n/)
  const columns = header.split(',')
  const key = columns.indexOf(keyColumn)
  const model = columns.indexOf('MatterportModelId')
  const byKey = new Map<string, string[]>()
  for (const row of rows) {
    const cells = row.split(',')
    if (!cells[model]) continue
    byKey.set(cells[key], [...(byKey.get(cells[key]) ?? []), cells[model]])
  }
  return byKey
}

// ---------------------------------------------------------------- formatting

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const present = (n: number | null | undefined): n is number => n != null && n > 0
const plural = (n: number, unit: string) => `${decimal.format(n)} ${unit}${n === 1 ? '' : 's'}`
const words = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/ (\w)/g, (_, c: string) => ` ${c.toLowerCase()}`)

type FactInput = [label: string, value: string | undefined]
const facts = (inputs: FactInput[]) =>
  inputs.filter((f): f is [string, string] => f[1] !== undefined).slice(0, 8).map(([label, value]) => ({ label, value }))

// A candidate before Matterport verification. `rank` orders candidates within their type; higher wins.
type Candidate = {
  property: Omit<Property, 'scans'>
  group: string
  rank: number
  modelIds: string[]
  raw: {
    year_built: number | null
    building_sf: number | null
    units: number | null
    stories: number | null
    beds: number | null
    baths: number | null
    price_usd: number | null
    rent_usd_month: number | null
  }
  building: {
    stories: number | null
    slab_to_slab_ft: number | null
    building_sf: number | null
    floors: { code: number; size_sf: number | null }[]
  }
}

// Points for each display field a property fills, so the curated set shows well on the map and in the
// evidence panel. More scans rank higher because the agent and the fly-through both need them.
const rank = (property: Omit<Property, 'scans'>, modelIds: string[]) =>
  (property.photoUrl ? 3 : 0) + property.facts.length + Math.min(modelIds.length, MAX_SCANS)

// ---------------------------------------------------------------- candidates

async function commercialCandidates() {
  const name = await enumNames('commercial-property.schema.json')
  const scans = await modelIdsByKey('commercial-properties.csv', 'PropertyId')
  const out: Candidate[] = []
  for await (const r of records<CommercialRecord>('commercial-property')) {
    const a = r.primaryAddress
    const type = name('PropertyType', r.propertyType)
    const modelIds = scans.get(String(r.id)) ?? []
    if (a?.researchMarketId !== LOS_ANGELES_MARKET || !type || !(type in COMMERCIAL_QUOTA)) continue
    if (a.latitude == null || a.longitude == null || !a.streetName || modelIds.length === 0) continue

    const street = [a.streetNumber, a.streetDirection, a.streetName, a.streetType, a.streetSuffix].filter(Boolean).join(' ')
    const built = r.constructionEvents?.find((e) => e.eventType === 2)?.year ?? null
    const renovated = Math.max(0, ...(r.constructionEvents ?? []).filter((e) => e.eventType === 4).map((e) => e.year ?? 0))
    const size = [type === 'GeneralRetail' ? r.propertyRetail?.grossLeasableAreaSquareFeet : null, r.rentableBuildingAreaSquareFeet, r.grossBuildingAreaSquareFeet].find(present) ?? null
    const units = (type === 'Hospitality' ? r.propertyHospitality?.numUnits : r.propertyApartment?.totalNumUnits) ?? null
    const lotUnit = name('MeasurementUnit', r.lotSizeMeasurementType)
    const buildingClass = name('BuildingClass', r.buildingClass)
    const style = name('ApartmentStyleType', r.propertyApartment?.apartmentStyleType)
    const material = name('BuildingConstructionMaterialType', r.buildingConstructionMaterial)

    const property: Omit<Property, 'scans'> = {
      id: `commercial-${r.id}`,
      kind: 'commercial',
      costarId: String(r.id),
      name: r.buildingName?.trim() || street,
      address: `${street}, ${a.city}, ${a.state} ${a.postcode?.slice(0, 5) ?? ''}`.trim(),
      lat: a.latitude,
      lon: a.longitude,
      typeLabel: COMMERCIAL_QUOTA[type].label,
      facts: facts([
        ['Year built', built ? (renovated > built ? `${built}, renovated ${renovated}` : String(built)) : undefined],
        ['Size', present(size) ? `${integer.format(size)} SF` : undefined],
        [type === 'Hospitality' ? 'Rooms' : 'Units', present(units) ? integer.format(units) : undefined],
        ['Stories', present(r.numStoriesAboveGrade) ? String(r.numStoriesAboveGrade) : undefined],
        ['Class', buildingClass && buildingClass !== 'F' ? buildingClass : undefined],
        ['Rating', present(r.buildingRating) ? plural(r.buildingRating, 'star') : undefined],
        ['Style', style ? words(style) : undefined],
        ['Construction', material ? words(material) : undefined],
        ['Lot', present(r.lotSize) && lotUnit ? `${decimal.format(r.lotSize)} ${lotUnit === 'Acres' ? 'acres' : 'SF'}` : undefined],
        ['Parking', present(r.parkingRatio) ? `${decimal.format(r.parkingRatio)} per 1,000 SF` : undefined],
      ]),
      photoUrl: r.primaryPhoto?.attachmentUri?.replace('/112/', '/113/') ?? null,
    }
    out.push({
      property,
      group: type,
      rank: rank(property, modelIds),
      modelIds,
      raw: {
        year_built: built,
        building_sf: size,
        units: present(units) ? units : null,
        stories: present(r.numStoriesAboveGrade) ? r.numStoriesAboveGrade : null,
        beds: null,
        baths: null,
        price_usd: null,
        rent_usd_month: null,
      },
      building: {
        stories: present(r.numStoriesAboveGrade) ? r.numStoriesAboveGrade : null,
        slab_to_slab_ft:
          [r.propertyOffice, r.propertyRetail, r.propertyIndustrial, r.propertyFlex].map((t) => t?.structural?.slabToSlabHeightFeet).find(present) ?? null,
        building_sf: present(r.grossBuildingAreaSquareFeet) ? r.grossBuildingAreaSquareFeet : null,
        floors: (r.floors ?? []).map((f) => ({ code: f.floorName, size_sf: f.floorSize?.squareFeet || null })),
      },
    })
  }
  return out
}

// The price fact's label by ListingStatus2 name, for a sale and for a rental.
const PRICE_LABEL: Record<string, { sale: string; rental: string }> = {
  Active: { sale: 'Asking', rental: 'Rent' },
  Contract: { sale: 'Under contract at', rental: 'Rent pending' },
  Sold: { sale: 'Sold for', rental: 'Leased for' },
  Inactive: { sale: 'Last asking', rental: 'Last rent' },
  Removed: { sale: 'Last asking', rental: 'Last rent' },
}
const PUBLIC = 10
const PHOTO = 4
const RENTAL = 2

async function residentialCandidates() {
  const name = await enumNames('residential-listings.schema.json')
  const scans = await modelIdsByKey('residential-listings.csv', 'ListingId')
  const byHome = new Map<string, Candidate & { primary: boolean }>()
  for await (const r of records<ResidentialRecord>('residential-listings')) {
    const p = r.property
    const a = p?.address
    const type = name('ListingPropertyType', p?.propertyType)
    const modelIds = scans.get(String(r.id)) ?? []
    if (!p || !a?.fullStreetAddress || a.state !== 'CA' || a.city?.trim().toLowerCase() !== LOS_ANGELES_CITY || r.permissionLevels?.homes !== PUBLIC) continue
    if (a.latitude == null || a.longitude == null || !type || !(type in RESIDENTIAL_QUOTA) || modelIds.length === 0) continue

    const street = a.unitNumber ? `${a.fullStreetAddress} Unit ${a.unitNumber}` : a.fullStreetAddress
    const rental = r.transactionType === RENTAL
    const status = name('ListingStatus2', r.listingStatus)
    const sold = status === 'Sold'
    const priceLabel = PRICE_LABEL[status ?? 'Inactive'] ?? PRICE_LABEL.Inactive
    const price = (sold ? r.closePrice : null) ?? r.currentPrice ?? null
    const photo = (r.media ?? []).filter((m) => m.type === PHOTO && m.uri).sort((x, y) => (x.displayOrder ?? 0) - (y.displayOrder ?? 0))[0]

    const property: Omit<Property, 'scans'> = {
      id: `residential-${r.id}`,
      kind: 'residential',
      costarId: String(r.id),
      name: a.buildingName?.trim() || street,
      address: `${street}, ${a.city}, ${a.state} ${a.zip?.slice(0, 5) ?? ''}`.trim(),
      lat: a.latitude,
      lon: a.longitude,
      typeLabel: RESIDENTIAL_QUOTA[type].label,
      facts: facts([
        [rental ? priceLabel.rental : priceLabel.sale, present(price) ? `${usd.format(price)}${rental ? '/mo' : ''}` : undefined],
        ['Beds', p.bedsMin != null ? String(p.bedsMin) : undefined],
        ['Baths', present(p.bathsMin) ? decimal.format(p.bathsMin) : undefined],
        ['Living area', present(p.sqftMin) ? `${integer.format(p.sqftMin)} SF` : undefined],
        // A condo's lot is the whole complex, not the home.
        ['Lot', type !== 'Condo' && present(p.lotSizeAcresMin) ? `${decimal.format(p.lotSizeAcresMin)} acres` : undefined],
        ['Year built', present(p.yearBuilt) ? String(p.yearBuilt) : undefined],
        ['Stories', present(p.stories) ? String(p.stories) : undefined],
        ['Parking', present(p.totalParkingSpaces) ? plural(p.totalParkingSpaces, 'space') : undefined],
      ]),
      photoUrl: photo?.uri?.replace('/112/', '/102/') ?? null,
    }
    const candidate = {
      property,
      group: type,
      rank: rank(property, modelIds),
      modelIds,
      primary: r.isPrimaryForThisListingInstance === true,
      raw: {
        year_built: present(p.yearBuilt) ? p.yearBuilt : null,
        building_sf: present(p.sqftMin) ? p.sqftMin : null,
        units: null,
        stories: present(p.stories) ? p.stories : null,
        beds: p.bedsMin ?? null,
        baths: present(p.bathsMin) ? p.bathsMin : null,
        price_usd: !rental && present(price) ? price : null,
        rent_usd_month: rental && present(price) ? price : null,
      },
      building: {
        stories: present(p.stories) ? p.stories : null,
        slab_to_slab_ft: null,
        building_sf: present(p.sqftMin) ? p.sqftMin : null,
        floors: [],
      },
    }
    // One listing per home: the primary listing wins, then the better-ranked one, then the lower id.
    const home = String(r.propertyId ?? `listing-${r.id}`)
    const held = byHome.get(home)
    if (!held || compareCandidates(candidate, held) < 0) byHome.set(home, candidate)
  }
  return [...byHome.values()]
}

const compareCandidates = (x: Candidate & { primary?: boolean }, y: Candidate & { primary?: boolean }) =>
  Number(y.primary ?? false) - Number(x.primary ?? false) ||
  y.rank - x.rank ||
  Number(x.property.costarId) - Number(y.property.costarId)

// ---------------------------------------------------------------- Matterport

type ModelResponse = { data?: { model?: { id: string; name?: string | null } | null }; errors?: { extensions?: { code?: string; retry?: string } }[] }

let calls = 0
let lastCall = 0

// Error codes that say this one model is unreadable for good, so caching the answer is safe.
const FINAL_CODES = new Set(['not.found', 'forbidden'])

// Returns the model when our token can read it, reading the per-model cache first. Only a model or
// a not-found/forbidden answer is cached; anything else stops the run uncached so a rerun retries.
async function readableModel(id: string) {
  if (!/^[A-Za-z0-9]+$/.test(id)) return null
  const file = new URL(`${id}.json`, CACHE)
  const cached = await readFile(file, 'utf8').catch(() => null)
  if (cached) {
    const body: ModelResponse = JSON.parse(cached)
    return body.data?.model ?? null
  }
  const body = await fetchModel(id)
  const temp = new URL(`${id}.json.tmp`, CACHE)
  await writeFile(temp, JSON.stringify(body))
  await rename(temp, file)
  return body.data?.model ?? null
}

async function fetchModel(id: string): Promise<ModelResponse> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, lastCall + 110 - Date.now())))
  lastCall = Date.now()
  calls++
  const auth = Buffer.from(`${env('MP_TOKEN_ID')}:${env('MP_TOKEN_SECRET')}`).toString('base64')
  const res = await fetch('https://api.matterport.com/api/models/graph', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query($id: ID!) { model(id: $id) { id name } }', variables: { id } }),
  })
  const body: ModelResponse = await res.json().catch(() => ({}))
  const final = body.data?.model != null || (body.errors?.length && body.errors.every((e) => FINAL_CODES.has(e.extensions?.code ?? '')))
  if (!res.ok || !final) fail(`Matterport ${res.status} for model ${id} (${body.errors?.map((e) => e.extensions?.code).join(', ') ?? 'no data'}); rerun later`)
  return body
}

// ---------------------------------------------------------------- selection

type Skip = { id: string; reason: string }

// Yields the candidates in `ranked` that Propstar can show, in order, each with up to MAX_SCANS
// readable scans. Records each one it passes over in `skipped` as it goes.
async function* usable(ranked: Candidate[], skipped: Skip[]) {
  for (const candidate of ranked) {
    if (candidate.property.facts.length < 4) {
      skipped.push({ id: candidate.property.id, reason: `only ${candidate.property.facts.length} facts` })
      continue
    }
    const scans: Property['scans'] = []
    for (const modelId of candidate.modelIds) {
      if (scans.length === MAX_SCANS) break
      const model = await readableModel(modelId)
      if (model) scans.push({ modelId: model.id, name: model.name?.trim() || model.id })
    }
    if (scans.length === 0) {
      skipped.push({ id: candidate.property.id, reason: `none of ${candidate.modelIds.length} Matterport models readable` })
      continue
    }
    yield { candidate, scans }
  }
}

// Keeps each type's count of usable candidates. When a type runs short, a second pass fills the
// shortfall from the types in quota order, so the set reaches the sum of the counts when it can.
async function select(candidates: Candidate[], quota: Record<string, { count: number }>, skipped: Skip[]) {
  const chosen: { candidate: Candidate; scans: Property['scans'] }[] = []
  const groups = Object.entries(quota).map(([group, { count }]) => ({
    group,
    count,
    next: usable(candidates.filter((c) => c.group === group).sort(compareCandidates), skipped),
  }))
  const take = async (next: ReturnType<typeof usable>, n: number) => {
    let kept = 0
    for (; kept < n; kept++) {
      const step = await next.next()
      if (step.done) break
      chosen.push(step.value)
    }
    return kept
  }
  for (const { group, count, next } of groups) {
    const kept = await take(next, count)
    if (kept < count) skipped.push({ id: group, reason: `quota short: kept ${kept} of ${count}` })
  }
  const target = groups.reduce((n, g) => n + g.count, 0)
  for (const { next } of groups) await take(next, target - chosen.length)
  return chosen
}

// ---------------------------------------------------------------- output

await mkdir(CACHE, { recursive: true })
const skipped: Skip[] = []
const chosen = await select(
  [...(await commercialCandidates()), ...(await residentialCandidates())],
  { ...COMMERCIAL_QUOTA, ...RESIDENTIAL_QUOTA },
  skipped,
)

// Build beside the live file and rename over it, so a server holding the old file keeps reading it.
const TEMP_PATH = `${DB_PATH}.tmp`
await rm(TEMP_PATH, { force: true })
await rm(`${TEMP_PATH}.wal`, { force: true })
const db = await DuckDBInstance.create(TEMP_PATH)
const connection = await db.connect()
await connection.run('BEGIN TRANSACTION')
await connection.run(`
  CREATE TABLE properties (
    id VARCHAR PRIMARY KEY, kind VARCHAR NOT NULL, costar_id VARCHAR NOT NULL, name VARCHAR NOT NULL,
    address VARCHAR NOT NULL, lat DOUBLE NOT NULL, lon DOUBLE NOT NULL, type_label VARCHAR NOT NULL,
    photo_url VARCHAR, facts STRUCT(label VARCHAR, value VARCHAR)[] NOT NULL,
    scans STRUCT(model_id VARCHAR, name VARCHAR)[] NOT NULL,
    year_built INTEGER, building_sf DOUBLE, units INTEGER, stories INTEGER, beds INTEGER, baths DOUBLE,
    price_usd DOUBLE, rent_usd_month DOUBLE
  )`)
await connection.run(`CREATE TABLE scans (property_id VARCHAR NOT NULL, model_id VARCHAR NOT NULL, name VARCHAR NOT NULL)`)
await connection.run(`
  CREATE TABLE building_facts (
    property_id VARCHAR PRIMARY KEY, stories INTEGER, slab_to_slab_ft DOUBLE, building_sf DOUBLE,
    floors STRUCT(code INTEGER, size_sf DOUBLE)[] NOT NULL
  )`)

for (const { candidate: { property: p, raw, building }, scans } of chosen) {
  await connection.run(
    `INSERT INTO properties VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
      CAST($10::JSON AS STRUCT(label VARCHAR, value VARCHAR)[]), CAST($11::JSON AS STRUCT(model_id VARCHAR, name VARCHAR)[]),
      $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      p.id, p.kind, p.costarId, p.name, p.address, p.lat, p.lon, p.typeLabel, p.photoUrl,
      JSON.stringify(p.facts), JSON.stringify(scans.map((s) => ({ model_id: s.modelId, name: s.name }))),
      raw.year_built, raw.building_sf, raw.units, raw.stories, raw.beds, raw.baths, raw.price_usd, raw.rent_usd_month,
    ],
  )
  for (const scan of scans) await connection.run(`INSERT INTO scans VALUES ($1, $2, $3)`, [p.id, scan.modelId, scan.name])
  await connection.run(
    `INSERT INTO building_facts VALUES ($1, $2, $3, $4, CAST($5::JSON AS STRUCT(code INTEGER, size_sf DOUBLE)[]))`,
    [p.id, building.stories, building.slab_to_slab_ft, building.building_sf, JSON.stringify(building.floors)],
  )
}
await connection.run('COMMIT')
await connection.run('CHECKPOINT')
connection.closeSync()
db.closeSync()
await rename(TEMP_PATH, DB_PATH)

const tally = new Map<string, number>()
for (const { candidate: { property: p } } of chosen) tally.set(`${p.kind} ${p.typeLabel}`, (tally.get(`${p.kind} ${p.typeLabel}`) ?? 0) + 1)
const byKind = (kind: string) => chosen.filter((c) => c.candidate.property.kind === kind).length
console.log(`Wrote ${chosen.length} properties to ${DB_PATH}`)
console.log(`  commercial ${byKind('commercial')}, residential ${byKind('residential')}`)
for (const [label, n] of tally) console.log(`  ${label}: ${n}`)
console.log(`Scans: ${chosen.reduce((n, c) => n + c.scans.length, 0)}`)
console.log(`Building facts: ${chosen.length} rows, ${chosen.filter((c) => c.candidate.building.floors.length > 0).length} with floors`)
console.log(`Matterport calls: ${calls} (the rest came from ${fileURLToPath(CACHE)})`)
console.log(`Skipped ${skipped.length}:`)
for (const s of skipped) console.log(`  ${s.id}: ${s.reason}`)
