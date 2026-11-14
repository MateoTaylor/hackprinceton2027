// Smoke-tests CoStar, Matterport and Vexcel against one building: `pnpm smoke [propertyId]`.
// Prints a summary of each layer and saves raw responses + imagery to data/smoke/<propertyId>/.
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

const propertyId = Number(process.argv[2] ?? 23296)
const KIT = new URL('../../kit/costar-hackathon-kit/', import.meta.url)
const OUT = new URL(`../../data/smoke/${propertyId}/`, import.meta.url)
await mkdir(OUT, { recursive: true })

const env = (name: string) => process.env[name] ?? fail(`${name} is missing from .env`)
function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
const save = (name: string, data: string | Uint8Array) => writeFile(new URL(name, OUT), data)

// ---------------------------------------------------------------- CoStar (local data extract)

type CommercialProperty = {
  id: number
  buildingName: string | null
  propertyType: number
  rentableBuildingAreaSquareFeet: number | null
  numStoriesAboveGrade: number | null
  primaryAddress: { streetNumber: string; streetName: string; streetType: string; city: string; state: string; latitude: number; longitude: number }
}

// Streams one dataset from costar-hackathon-kit/data, one parsed record per line.
async function* records<T>(dataset: string): AsyncGenerator<T> {
  const lines = createInterface({ input: createReadStream(new URL(`data/${dataset}.jsonl`, KIT)) })
  for await (const line of lines) if (line) yield JSON.parse(line)
}

async function count<T>(dataset: string, matches: (record: T) => boolean) {
  let n = 0
  for await (const record of records<T>(dataset)) if (matches(record)) n++
  return n
}

async function findProperty() {
  for await (const p of records<CommercialProperty>('commercial-property')) if (p.id === propertyId) return p
  return fail(`property ${propertyId} is not in the kit`)
}

const schema = JSON.parse(await readFile(new URL('schemas/commercial-property.schema.json', KIT), 'utf8'))
const { enum: typeIds, 'x-enum-varnames': typeNames } = schema.$defs.PropertyType
const propertyTypeName = (id: number) => typeNames[typeIds.indexOf(id)] ?? `#${id}`

const csv = await readFile(new URL('commercial-properties.csv', KIT), 'utf8')
const modelIds = csv.split('\n').map((row) => row.split(',')).filter(([id, model]) => Number(id) === propertyId && model).map(([, model]) => model)

console.log('Loading CoStar…')
const [property, tenancies, listings, sales] = await Promise.all([
  findProperty(),
  count<{ propertyId: number }>('location-occupancy', (r) => r.propertyId === propertyId),
  count<{ propertyId: number }>('commercial-listing-summary', (r) => r.propertyId === propertyId),
  count<{ entities?: { propertyId: number }[] }>('commercial-sale-comp', (r) => r.entities?.some((e) => e.propertyId === propertyId) ?? false),
])
const { latitude: lat, longitude: lon, ...addr } = property.primaryAddress
console.log(`\n■ CoStar  #${property.id} ${property.buildingName ?? ''}`)
console.log(`  ${addr.streetNumber} ${addr.streetName} ${addr.streetType}, ${addr.city} ${addr.state}  (${lat}, ${lon})`)
console.log(`  ${propertyTypeName(property.propertyType)} · ${property.rentableBuildingAreaSquareFeet ?? '?'} SF RBA · ${property.numStoriesAboveGrade ?? '?'} stories`)
console.log(`  ${tenancies} tenancies · ${listings} listings · ${sales} sale comps · ${modelIds.length} Matterport models`)
await save('costar-property.json', JSON.stringify(property, null, 2))

// ---------------------------------------------------------------- Matterport (Model API, GraphQL)

const MODEL_QUERY = /* GraphQL */ `
  query ($id: ID!) {
    model(id: $id) {
      id
      name
      geocoordinates { latitude longitude }
      address { address }
      image { url }
      floors { id label dimensions { areaFloor } }
      rooms { id label classifications { label } dimensions { areaFloor } }
      panoLocations { id }
      assets { meshes { format url } floorplans { format url } }
    }
  }
`

async function matterport<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const auth = Buffer.from(`${env('MP_TOKEN_ID')}:${env('MP_TOKEN_SECRET')}`).toString('base64')
  const res = await fetch('https://api.matterport.com/api/models/graph', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (!res.ok || body.errors) fail(`Matterport ${res.status}: ${JSON.stringify(body.errors ?? body)}`)
  return body.data
}

type MatterportModel = {
  id: string
  name: string
  address: { address: string } | null
  floors: { label: string; dimensions: { areaFloor: number } | null }[]
  rooms: { label: string; classifications: { label: string }[] }[]
  panoLocations: { id: string }[]
  assets: { meshes: unknown[]; floorplans: unknown[] }
}

const modelId = modelIds[0]
if (modelId) {
  const { model } = await matterport<{ model: MatterportModel }>(MODEL_QUERY, { id: modelId })
  const roomKinds = model.rooms.map((r) => r.label || r.classifications[0]?.label).filter((k) => k && k !== 'Void')
  console.log(`\n■ Matterport  ${model.id} "${model.name.trim()}"`)
  console.log(`  ${model.address?.address ?? 'no address'}`)
  console.log(`  ${model.floors.length} floors (${model.floors.map((f) => `${f.label} ${Math.round(f.dimensions?.areaFloor ?? 0)} SF`).join(', ')})`)
  console.log(`  ${model.rooms.length} rooms: ${[...new Set(roomKinds)].join(', ')}`)
  console.log(`  ${model.panoLocations.length} panoramas · ${model.assets.meshes.length} meshes · ${model.assets.floorplans.length} floorplans`)
  console.log(`  3D viewer: http://localhost:8000/showcase/?m=${model.id}  (run \`pnpm showcase\`)`)
  await save('matterport-model.json', JSON.stringify(model, null, 2))
} else {
  console.log('\n■ Matterport  no model for this property')
}

// ---------------------------------------------------------------- Vexcel (aerial imagery + Elements)

const VEXCEL = 'https://api.vexcelgroup.com/v2'
const LAYERS = 'urban,urban-r,wide-area,urban-g' // let the API pick the best imagery available here

async function vexcel(path: string, init?: { body: unknown }) {
  const res = await fetch(`${VEXCEL}/${path}`, {
    method: init ? 'POST' : 'GET',
    headers: { 'X-API-KEY': env('VEXCEL_API_KEY'), 'Content-Type': 'application/json' },
    body: init && JSON.stringify(init.body),
  })
  return res
}

type Geometry = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] }
const ring = (points: number[][]) => `(${points.map((p) => p.join(' ')).join(',')})`
const polygon = (rings: number[][][]) => `(${rings.map(ring).join(',')})`
const toWkt = (g: Geometry) =>
  g.type === 'Polygon' ? `POLYGON${polygon(g.coordinates)}` : `MULTIPOLYGON(${g.coordinates.map(polygon).join(',')})`

type ParcelProperties = {
  'structure.count': number
  'metadata.collection'?: string
  structures: { 'primary-structure'?: boolean; 'footprint.area'?: number; 'roof-characteristics.material.class'?: string }[]
}

const parcelRes = await vexcel(
  `property/extract?${new URLSearchParams({ wkt: `POINT(${lon} ${lat})`, srid: '4326', layer: LAYERS, latest: 'true', include: 'precomputed', 'unit-system': 'imperial' })}`,
)
console.log('\n■ Vexcel')
let area: string
if (parcelRes.ok) {
  const parcel: { features: { geometry: Geometry; properties: ParcelProperties }[] } = await parcelRes.json()
  const { geometry, properties } = parcel.features[0]
  const primary = properties.structures.find((s) => s['primary-structure'])
  area = toWkt(geometry)
  console.log(`  parcel: ${properties['structure.count']} structures · collection ${properties['metadata.collection'] ?? '?'}`)
  console.log(`  primary structure: ${Math.round(primary?.['footprint.area'] ?? 0)} SF footprint, ${primary?.['roof-characteristics.material.class'] ?? '?'} roof`)
  await save('vexcel-parcel.json', JSON.stringify(parcel, null, 2))
} else if (parcelRes.status === 404) {
  // No parcel at this exact point; imagery only needs an area, so fall back to a ~100 m box.
  const d = 0.00045
  area = `POLYGON((${lon - d} ${lat - d},${lon + d} ${lat - d},${lon + d} ${lat + d},${lon - d} ${lat + d},${lon - d} ${lat - d}))`
  console.log('  no parcel at this point; using a 100 m box')
} else {
  fail(`Vexcel property/extract ${parcelRes.status}: ${await parcelRes.text()}`)
}

const orthoRes = await vexcel('ortho/extract', {
  body: {
    wkt: area, srid: 4326, layer: LAYERS, 'buffer-meter': 10, crop: 'bounding_box', 'image-format': 'jpeg',
    drawing: [{ wkt: area, 'outline-width': 4, 'outline-color': 'rgb(255,204,0)' }],
  },
})
if (!orthoRes.ok) fail(`Vexcel ortho/extract ${orthoRes.status}: ${await orthoRes.text()}`)
await save('vexcel-ortho.jpg', new Uint8Array(await orthoRes.arrayBuffer()))
console.log(`  saved ortho image`)

console.log(`\nAll three layers OK → ${OUT.pathname}`)
