// A Matterport space the Scene panel can open. `demo` spaces are Matterport's public demos,
// `kit` spaces are scans from the CoStar kit and `property` spaces come from `property.scans`.
export type SpaceEntry = { id: string; label: string; kind: 'demo' | 'kit' | 'property' }

export const SPACES: readonly SpaceEntry[] = [
  { id: 'L3sdz2m7jxp', label: 'Plant', kind: 'demo' },
  { id: '18TRzZNyxvU', label: 'Office', kind: 'demo' },
  { id: '35LT5s1GSfA', label: 'Kit scan', kind: 'kit' },
  { id: '2rPahZzW6H7', label: 'Building exterior', kind: 'kit' },
]

export const isSpaceId = (value: string) => /^[A-Za-z0-9]{11}$/.test(value)
