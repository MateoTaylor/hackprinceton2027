import { MeshStandardMaterial } from 'three'
import type { Space } from '../../../server/src/model/building.ts'
import { floorTone } from './floorTone.ts'
import type { Look, ProtoTone } from './looks.ts'
import { protoMaterial } from './protoGrid.ts'

// Confidence at or above the second step is `high`, at or above the first is `mid`, and lower is
// `low`. Three tones and not a ramp, because small differences in grey do not read.
export const CONFIDENCE_STEPS = [0.2, 0.4] as const

export function protoTone(confidence: number): Exclude<ProtoTone, 'context'> {
  if (confidence >= CONFIDENCE_STEPS[1]) return 'high'
  return confidence >= CONFIDENCE_STEPS[0] ? 'mid' : 'low'
}

const flatCache = new WeakMap<Look, Map<string, MeshStandardMaterial>>()

// One flat, untextured material per look and colour, shared by every mesh that uses it and marked
// shared, so a stage never frees it.
export function flatMaterial(color: string, look: Look) {
  const colours = flatCache.get(look) ?? new Map<string, MeshStandardMaterial>()
  flatCache.set(look, colours)
  const cached = colours.get(color)
  if (cached) return cached
  const material = new MeshStandardMaterial({ color, roughness: look.roughness })
  material.userData.shared = true
  colours.set(color, material)
  return material
}

// How a space is drawn. `floor` is its slab material, `wallColor` its wall stubs, and
// `furnitureColor` the colour of everything standing in it, or null to keep each kit colour.
export type SpaceStyle = { floor: MeshStandardMaterial; wallColor: string; furnitureColor: string | null }

// Scanned space is in colour: the floor colour of its use, light walls and coloured furniture.
// Everything else is grey on the 1 m grid, darker as its confidence drops.
//   const { floor } = styleFor(space, look)
export function styleFor({ label, source, confidence }: Pick<Space, 'label' | 'source' | 'confidence'>, look: Look): SpaceStyle {
  if (source === 'scan') {
    return { floor: flatMaterial(look.palette.floors[floorTone(label)], look), wallColor: look.palette.wall, furnitureColor: null }
  }
  const tone = protoTone(confidence)
  const { line } = look.palette.proto[tone]
  return { floor: protoMaterial(tone, look), wallColor: line, furnitureColor: line }
}
