import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDiskCache } from '../../cache.ts'
import { createMatterport } from '../../matterport.ts'
import { ringBounds } from '../../model/geo.ts'
import { parseScanPlan } from './scanPlan.ts'

const { MP_TOKEN_ID: tokenId, MP_TOKEN_SECRET: tokenSecret } = process.env

// Prints counts and sizes of the worked example's whole-floor scan, never a label or a position.
test('the worked example scan parses into a floor outline', { skip: !tokenId || !tokenSecret }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propstar-scan-'))
  try {
    if (!tokenId || !tokenSecret) return
    const matterport = createMatterport({ tokenId, tokenSecret, cache: createDiskCache(root) })
    const raw = await matterport.floorPlan('aYTUWzQVbUs')
    const lengths = raw.floors.flatMap((floor) => {
      const at = new Map(floor.vertices.map(({ id, x, y }) => [id, [x, y]]))
      return floor.edges.flatMap(({ vertexIds: [a, b], openings }) => {
        const [p, q] = [at.get(a), at.get(b)]
        const length = p && q ? Math.hypot(q[0] - p[0], q[1] - p[1]) : 0
        return openings.flatMap(({ relativeCenter }) => (relativeCenter === null || !length ? [] : [{ relativeCenter, perLength: relativeCenter / length }]))
      })
    })
    const range = (values: number[]) => `${Math.min(...values).toFixed(3)}..${Math.max(...values).toFixed(3)}`
    console.log('relativeCenter', range(lengths.map(({ relativeCenter }) => relativeCenter)), 'divided by length', range(lengths.map(({ perLength }) => perLength)))

    const plan = parseScanPlan('aYTUWzQVbUs', raw)
    const rooms = plan.floors.reduce((sum, { spaces }) => sum + spaces.length, 0)
    const openings = plan.floors.reduce((sum, { openings }) => sum + openings.length, 0)
    console.log('floors', plan.floors.length, 'rooms', rooms, 'openings', openings, 'skipped', plan.skippedRooms)
    for (const { outline } of plan.floors) {
      const { minX, minY, maxX, maxY } = ringBounds(outline)
      console.log('outline', (maxX - minX).toFixed(1), 'by', (maxY - minY).toFixed(1), 'm with', outline.length, 'corners')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
