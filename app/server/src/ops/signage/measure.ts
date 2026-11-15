import type { SceneObject } from '../scene/document.ts'

const cm = (value: number) => Math.round(value * 100) / 100

// The measurements of a placed sign. The two heights are null when the ground under the sign is
// not measured, or when it was measured above the sign's bottom edge (`groundProblem`).
export function measureSign({ position, sizeM, groundY }: Pick<SceneObject, 'position' | 'groundY'> & { sizeM: NonNullable<SceneObject['sizeM']> }) {
  const size = { widthM: sizeM.widthM, heightM: sizeM.heightM, areaM2: cm(sizeM.widthM * sizeM.heightM) }
  const unknown = { ...size, bottomAboveGroundM: null, topAboveGroundM: null }
  if (groundY === undefined) return { ...unknown, groundProblem: false }
  const gap = cm(position[1] - sizeM.heightM / 2 - groundY)
  if (gap < -0.05) return { ...unknown, groundProblem: true }
  const bottom = Math.max(0, gap)
  return { ...size, bottomAboveGroundM: bottom, topAboveGroundM: cm(bottom + sizeM.heightM), groundProblem: false }
}
