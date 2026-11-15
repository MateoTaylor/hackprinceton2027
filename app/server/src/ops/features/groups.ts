// The Vexcel attribute groups features_get reports, in the order it reports them. A key belongs to
// the group whose prefix it starts with, such as `pool.detected` to `pool`.
export const FEATURE_GROUPS = [
  { group: 'pool', prefix: 'pool.' },
  { group: 'roof-characteristics', prefix: 'roof-characteristics.' },
  { group: 'roof-objects', prefix: 'roof-objects.' },
  { group: 'roof-defects', prefix: 'roof-defects.' },
  { group: 'building-type', prefix: 'building-type.' },
  { group: 'vehicles', prefix: 'vehicles.' },
  { group: 'parcel-tree-cover', prefix: 'parcel-tree-cover.' },
] as const

export type FeatureGroupId = (typeof FEATURE_GROUPS)[number]['group']
export type FeatureValue = string | number | boolean
export type FeatureGroup = { group: FeatureGroupId; attributes: { key: string; value: FeatureValue }[] }

// Sorts flat Vexcel attributes into FEATURE_GROUPS order, keys sorted within a group. Nulls, keys
// that match no group and groups left empty are dropped.
//   groupAttributes({ 'pool.detected': true, 'footprint.area': 120 })  // [{ group: 'pool', attributes: [...] }]
export function groupAttributes(attributes: Record<string, FeatureValue | null | undefined>): FeatureGroup[] {
  const entries = Object.entries(attributes).toSorted(([a], [b]) => a.localeCompare(b))
  return FEATURE_GROUPS.flatMap(({ group, prefix }) => {
    const rows = entries.flatMap(([key, value]) => (value != null && key.startsWith(prefix) ? [{ key, value }] : []))
    return rows.length ? [{ group, attributes: rows }] : []
  })
}
