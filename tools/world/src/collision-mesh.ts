/**
 * The static world every simulation collides with: one indexed triangle soup in the
 * simulation frame (right-handed, Y up, meters).
 *
 * Matterport scan files are Z up. `parseObj` converts once, at load, so nothing
 * downstream ever sees the scan frame. Use `toScan` and `fromScan` only where a
 * position crosses back to scan data, such as a saved placement or a panorama pose.
 */
export type CollisionMesh = {
  positions: Float32Array
  indices: Uint32Array
  min: Vec3
  max: Vec3
}

export type Vec3 = { x: number; y: number; z: number }

export const fromScan = (x: number, y: number, z: number): Vec3 => ({ x, y: z, z: -y })
export const toScan = (p: Vec3): Vec3 => ({ x: p.x, y: -p.z, z: p.y })

/**
 * Reads the `v` and `f` records of a Wavefront OBJ and ignores everything else.
 * Polygons become triangle fans. Materials and texture coordinates belong to the
 * render mesh, which three's OBJLoader loads separately.
 */
export function parseObj(text: string): CollisionMesh {
  const positions: number[] = []
  const indices: number[] = []
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }

  let lineStart = 0
  while (lineStart < text.length) {
    let lineEnd = text.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = text.length
    const first = text.charCodeAt(lineStart)
    const second = text.charCodeAt(lineStart + 1)

    if (first === 118 && second === 32) {
      const parts = text.slice(lineStart + 2, lineEnd).trim().split(/\s+/)
      const p = fromScan(Number(parts[0]), Number(parts[1]), Number(parts[2]))
      positions.push(p.x, p.y, p.z)
      min.x = Math.min(min.x, p.x)
      min.y = Math.min(min.y, p.y)
      min.z = Math.min(min.z, p.z)
      max.x = Math.max(max.x, p.x)
      max.y = Math.max(max.y, p.y)
      max.z = Math.max(max.z, p.z)
    } else if (first === 102 && second === 32) {
      const vertexCount = positions.length / 3
      const corners = text
        .slice(lineStart + 2, lineEnd)
        .trim()
        .split(/\s+/)
        .map((corner) => {
          const index = parseInt(corner, 10)
          return index < 0 ? vertexCount + index : index - 1
        })
      for (let i = 1; i + 1 < corners.length; i++) {
        indices.push(corners[0], corners[i], corners[i + 1])
      }
    }
    lineStart = lineEnd + 1
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    min,
    max,
  }
}
