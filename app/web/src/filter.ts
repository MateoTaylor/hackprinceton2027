import type { Property, PropertyKind } from '../../shared/property'
import { areaOf, fact, yearOf } from './property.ts'

// A band of one numeric fact. `min` is inclusive and `max` exclusive; a missing bound is open.
type Band = { label: string; min?: number; max?: number }

const storiesOf = (p: Property) => {
  const value = Number(fact(p, 'Stories'))
  return Number.isFinite(value) ? value : undefined
}

// The numeric filters the sidebar offers. Every one reads a fact that nearly every property has,
// so a band hides few properties for lack of data. Add a facet here and the sidebar shows it.
export const FACETS = {
  size: {
    label: 'Size',
    any: 'Any size',
    value: areaOf,
    bands: [
      { label: 'Under 5k sf', max: 5_000 },
      { label: '5k to 50k sf', min: 5_000, max: 50_000 },
      { label: '50k sf and up', min: 50_000 },
    ],
  },
  stories: {
    label: 'Stories',
    any: 'Any height',
    value: storiesOf,
    bands: [
      { label: '1 to 2 stories', max: 3 },
      { label: '3 to 9 stories', min: 3, max: 10 },
      { label: '10+ stories', min: 10 },
    ],
  },
  built: {
    label: 'Year built',
    any: 'Any year built',
    value: yearOf,
    bands: [
      { label: 'Before 1950', max: 1950 },
      { label: '1950 to 1999', min: 1950, max: 2000 },
      { label: '2000 or later', min: 2000 },
    ],
  },
} satisfies Record<string, { label: string; any: string; value: (p: Property) => number | undefined; bands: Band[] }>

export type FacetKey = keyof typeof FACETS
// The chosen band of each facet, as an index into its `bands`, or null for any.
export type Facets = Record<FacetKey, number | null>
export const NO_FACETS: Facets = { size: null, stories: null, built: null }
export const FACET_KEYS: FacetKey[] = ['size', 'stories', 'built']

export type Filter = {
  query: string
  kind: PropertyKind | null
  type: string | null
  savedOnly: boolean
  saved: ReadonlySet<string>
  facets: Facets
}

// True when the property passes every filter. The query is an exact, case-insensitive substring of
// the name, address or type; a blank query matches everything.
//   properties.filter((p) => matches(p, { query, kind, type, savedOnly, saved, facets }))
export function matches(p: Property, f: Filter) {
  const query = f.query.trim().toLowerCase()
  if (query && ![p.name, p.address, p.typeLabel].some((text) => text.toLowerCase().includes(query))) return false
  if (f.kind && p.kind !== f.kind) return false
  if (f.type && p.typeLabel !== f.type) return false
  if (f.savedOnly && !f.saved.has(p.id)) return false
  return FACET_KEYS.every((key) => {
    const index = f.facets[key]
    if (index === null) return true
    const facet = FACETS[key]
    const band: Band = facet.bands[index]
    const value = facet.value(p)
    return value !== undefined && (band.min === undefined || value >= band.min) && (band.max === undefined || value < band.max)
  })
}
