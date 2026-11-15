import { toLatLon } from '../../model/geo.ts'

// The side of one area grid cell in degrees. A cell id is
// `${Math.floor(lon / CELL_DEG)}_${Math.floor(lat / CELL_DEG)}`.
export const CELL_DEG = 0.02

// The bounding box of a cell, for Overture's `bbox` filter.
export function cellBounds(id: string) {
  const [x, y] = id.split('_').map(Number)
  return { xmin: x * CELL_DEG, ymin: y * CELL_DEG, xmax: (x + 1) * CELL_DEG, ymax: (y + 1) * CELL_DEG }
}

// How far around a property the area build loads every cell. It is also the largest radius an area
// op takes, so nothing inside a radius is missing from the data. 5 km reaches the nearest motorway
// of every property.
export const AREA_REACH_M = 5000

// Every cell that the square reaching `reachM` east, west, north and south of a point touches,
// over all points, deduplicated and sorted by id so every build loads cells in the same order.
//   coverCells(properties.map(({ lat, lon }) => ({ lat, lon })))
export function coverCells(points: Iterable<{ lat: number; lon: number }>, reachM = 1000) {
  const ids = new Set<string>()
  for (const point of points) {
    const [west, south] = toLatLon(point, [-reachM, -reachM])
    const [east, north] = toLatLon(point, [reachM, reachM])
    for (let x = Math.floor(west / CELL_DEG); x <= Math.floor(east / CELL_DEG); x++) {
      for (let y = Math.floor(south / CELL_DEG); y <= Math.floor(north / CELL_DEG); y++) ids.add(`${x}_${y}`)
    }
  }
  return [...ids].sort()
}
