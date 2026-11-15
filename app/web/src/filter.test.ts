import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Property } from '../../shared/property'
import { matches, NO_FACETS, type Filter } from './filter.ts'

const property = (id: string, overrides: Partial<Property>): Property => ({
  id,
  kind: 'commercial',
  costarId: id,
  name: 'Invented Tower',
  address: '100 Invented Blvd, Los Angeles',
  lat: 34,
  lon: -118,
  typeLabel: 'Office',
  facts: [],
  photoUrl: null,
  scans: [],
  ...overrides,
})

const tower = property('commercial-1', { facts: [{ label: 'Size', value: '120,000 SF' }, { label: 'Stories', value: '12' }, { label: 'Year built', value: '1987' }] })
const bungalow = property('residential-2', {
  kind: 'residential',
  name: '5 Orchard Ln',
  address: '5 Orchard Ln, Los Angeles',
  typeLabel: 'Single Family',
  facts: [{ label: 'Living area', value: '1,450 sq ft' }, { label: 'Stories', value: '1' }, { label: 'Year built', value: '1926' }],
})
const noFacts = property('commercial-3', { name: 'Bare Lot', typeLabel: 'Retail' })
const all = [tower, bungalow, noFacts]

const base: Filter = { query: '', kind: null, type: null, savedOnly: false, saved: new Set(), facets: NO_FACETS }
const ids = (f: Partial<Filter>) => all.filter((p) => matches(p, { ...base, ...f })).map((p) => p.id)

test('a blank query matches everything', () => {
  assert.deepEqual(ids({ query: '   ' }), ['commercial-1', 'residential-2', 'commercial-3'])
})

test('the query is a case-insensitive substring of name, address or type', () => {
  assert.deepEqual(ids({ query: 'TOWER' }), ['commercial-1'])
  assert.deepEqual(ids({ query: 'orchard' }), ['residential-2'])
  assert.deepEqual(ids({ query: 'family' }), ['residential-2'])
  assert.deepEqual(ids({ query: 'invented blvd' }), ['commercial-1', 'commercial-3'])
})

test('the query is exact, not fuzzy', () => {
  assert.deepEqual(ids({ query: 'towr' }), [])
  assert.deepEqual(ids({ query: 'tower invented' }), [])
})

test('the query composes with kind, type and saved', () => {
  assert.deepEqual(ids({ query: 'los angeles', kind: 'residential' }), ['residential-2'])
  assert.deepEqual(ids({ query: 'invented', type: 'Retail' }), ['commercial-3'])
  assert.deepEqual(ids({ query: 'invented', savedOnly: true, saved: new Set(['commercial-3']) }), ['commercial-3'])
})

test('a band keeps values inside it and drops properties without the fact', () => {
  assert.deepEqual(ids({ facets: { ...NO_FACETS, size: 0 } }), ['residential-2'])
  assert.deepEqual(ids({ facets: { ...NO_FACETS, size: 2 } }), ['commercial-1'])
  assert.deepEqual(ids({ facets: { ...NO_FACETS, stories: 2 } }), ['commercial-1'])
  assert.deepEqual(ids({ facets: { ...NO_FACETS, stories: 0 } }), ['residential-2'])
  assert.deepEqual(ids({ facets: { ...NO_FACETS, built: 0 } }), ['residential-2'])
  assert.deepEqual(ids({ facets: { ...NO_FACETS, built: 1, stories: 2 } }), ['commercial-1'])
  assert.deepEqual(ids({ facets: { ...NO_FACETS, built: 2 } }), [])
})

test('band edges: min is inclusive, max is exclusive', () => {
  const three = property('commercial-4', { facts: [{ label: 'Stories', value: '3' }] })
  const at = (index: number) => matches(three, { ...base, facets: { ...NO_FACETS, stories: index } })
  assert.deepEqual([at(0), at(1), at(2)], [false, true, false])
})
