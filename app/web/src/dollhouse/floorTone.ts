import type { FloorTone } from './looks.ts'

// Keywords that give a room label its floor colour. The first tone with a matching keyword wins,
// so this order settles labels such as "Dining Hall".
export const FLOOR_KEYWORDS: [Exclude<FloorTone, 'other'>, string[]][] = [
  ['wet', ['bath', 'restroom', 'toilet', 'shower', 'kitchen', 'laundry', 'wc', 'pantry']],
  ['meet', ['conference', 'meeting', 'board', 'training']],
  ['living', ['living', 'bed', 'dining', 'lounge', 'break', 'family']],
  ['storage', ['storage', 'warehouse', 'closet', 'garage', 'dock', 'mechanical', 'utility', 'plant floor', 'rack']],
  ['circulation', ['corridor', 'hall', 'lobby', 'entry', 'foyer', 'stair', 'elevator', 'reception', 'core', 'landing']],
  ['work', ['office', 'work', 'desk', 'studio', 'suite', 'unit', 'retail']],
]

// The floor colour key for a room label, or `other` when no keyword matches.
//   look.palette.floors[floorTone(space.label)]
export function floorTone(label: string): FloorTone {
  const lower = label.toLowerCase()
  return FLOOR_KEYWORDS.find(([, words]) => words.some((word) => lower.includes(word)))?.[0] ?? 'other'
}
