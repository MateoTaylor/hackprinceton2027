import { CanvasTexture, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace } from 'three'
import type { Look, ProtoTone } from './looks.ts'

const TILE_PX = 128
const LINE_PX = 2

const cache = new WeakMap<Look, Map<ProtoTone, MeshStandardMaterial>>()

function gridTexture({ fill, line }: Look['palette']['proto'][ProtoTone]) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = TILE_PX
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot draw to a 2D canvas.')
  context.fillStyle = fill
  context.fillRect(0, 0, TILE_PX, TILE_PX)
  context.fillStyle = line
  context.fillRect(0, 0, TILE_PX, LINE_PX)
  context.fillRect(0, 0, LINE_PX, TILE_PX)
  const texture = new CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 16
  return texture
}

// The grey prototype grid in one tone: one tile per UV unit, so geometry in metres shows a 1 m
// grid. Each look and tone shares one material, so many meshes cost one texture. The material is
// marked shared, so a stage never frees it.
export function protoMaterial(tone: ProtoTone, look: Look) {
  const tones = cache.get(look) ?? new Map<ProtoTone, MeshStandardMaterial>()
  cache.set(look, tones)
  const cached = tones.get(tone)
  if (cached) return cached
  const material = new MeshStandardMaterial({
    map: gridTexture(look.palette.proto[tone]),
    roughness: look.roughness,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })
  material.userData.shared = true
  tones.set(tone, material)
  return material
}
