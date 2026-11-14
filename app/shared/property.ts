// The curated property the server, the agent and the client all share.
// Import it with `import type` and a relative path; this file has no runtime code.

export type PropertyKind = 'commercial' | 'residential'

// One curated property. `id` is `${kind}-${costarId}`; costarId is the commercial PropertyId or the
// residential ListingId.
export interface Property {
  id: string
  kind: PropertyKind
  costarId: string
  // Building name, or the street address when there is none.
  name: string
  address: string
  lat: number
  lon: number
  // Display type, such as "Office", "Multi-Family" or "Single Family".
  typeLabel: string
  // 4 to 8 display facts, already formatted.
  facts: { label: string; value: string }[]
  // Commercial photos come from the CoStar CDN at size 113 (1400x720). Residential photos come from
  // images.homes.com at size 102 (984x658), because homes.com does not document size 113.
  photoUrl: string | null
  // Matterport models our token can read, at most 4, in kit CSV order.
  scans: { modelId: string; name: string }[]
}
