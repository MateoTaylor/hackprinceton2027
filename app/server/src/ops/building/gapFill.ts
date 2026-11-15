import type { Connector, Opening, Point, Ring, Space, Storey } from '../../model/building.ts'
import { bearingDeg, pointInRing, ringArea, ringBounds, ringCentroid } from '../../model/geo.ts'
import { areaOf, closeGaps, intersectRings, offsetRings, sharedArea, subtractSplit, unionRings } from './clip.ts'
import { doorBetween, nearestOnRing, orientedRect, principalAxis, rotate } from './geometry.ts'

export type Layout = 'office' | 'warehouse' | 'apartment' | 'open'

// A lift and a stair side by side in one rectangle, the same on every storey.
export type Core = { ring: Ring; elevatorAt: Point; stairAt: Point }

// A property's CoStar type label to the layout the generator draws. The first match wins, and an
// unknown label gets `open`.
export const LAYOUT_BY_TYPE: [RegExp, Layout][] = [
  [/office|healthcare|medical/i, 'office'],
  [/industrial|warehouse|flex|distribution/i, 'warehouse'],
  [/multi-family|apartment|condo|hotel|student|senior/i, 'apartment'],
]

export const layoutOf = (typeLabel: string): Layout => LAYOUT_BY_TYPE.find(([pattern]) => pattern.test(typeLabel))?.[1] ?? 'open'

const CORE_SIZE_M = { length: 8, width: 5 }
const CORE_MIN_SCALE = 0.4
// The spacing of the points tried as the core's centre when the storey's own centre is off the floor.
const CORE_SEARCH_M = 2
const CORE_INSIDE = 0.99
const WALL_GAP_M = 0.3
const MIN_REMAINDER_M2 = 10
// Parts of the floor narrower than this, such as a strip between the core and a jagged facade, are
// left empty, because a person cannot walk them.
const SLIVER_M = 0.6
// The floor kept clear around the core on every storey, for the corridor that rings it.
const CORE_CLEAR_M = 1.5
// A remainder smaller than this is left as one open space rather than cut into rooms.
const MIN_PLANNED_M2 = 60
const MIN_ROOM_M2 = 4
const ENTRANCE_WIDTH_M = 1.8
const DOOR_WIDTH_M = 0.9
// The depth of floor a door needs clear on both sides of its wall, as the route grid draws it.
const DOOR_DEPTH_M = 0.75
const OPENING_MAX_M = 2.4
const DOCK = { widthM: 3, heightM: 4, spacingM: 12 }
const OFFICE_STRIP_M = 6
const ON_WALL_M = 0.3
const LANDING_REACH_M = 0.5
// How far inside a space a moved landing goes, so it never sits on a wall.
const LANDING_INSET_M = 0.5
const FACADE_M = 0.5
// How far past a suite's front door to look for the space it opens onto.
const BEYOND_DOOR_M = [0.15, 0.3, 0.6, 0.9]
const CONFIDENCE = { space: 0.3, opening: 0.25, connector: 0.3 }
const LAYOUTS = {
  office: { corridorM: 1.8, roomM: [4, 6], room: 'Office' },
  apartment: { corridorM: 1.5, roomM: [8, 10], room: 'Apartment' },
} as const
// Labels of generated spaces that are walked through, so they meet each other by an opening and
// not a door.
const THROUGH = new Set(['Corridor', 'Core', 'Lobby', 'Open floor', 'Warehouse floor'])

// A seeded random number generator in [0, 1). The same seed gives the same sequence.
export function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The 32-bit FNV-1a hash of a string, to seed `mulberry32`.
export function hashSeed(text: string) {
  let hash = 0x811c9dc5
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
  return hash >>> 0
}

const inside = (rect: Ring, ring: Ring) => areaOf(intersectRings([rect], [ring])) >= CORE_INSIDE * ringArea(rect)

// One core for the whole building, along the long axis of its smallest storey, as near that
// storey's centre as it fits inside every storey with a corridor's width of floor around it, shrunk
// when nothing fits at full size. A courtyard or U-shaped storey puts its centre outside the
// floor, so the core moves out onto the floor. A building of one storey, or one with no room for a
// core, gets none.
//   const core = planCore(storeys, 'office')
export function planCore(storeys: Storey[], layout: Layout): Core | null {
  if (storeys.length < 2) return null
  const smallest = storeys.reduce((a, b) => (ringArea(b.ring) < ringArea(a.ring) ? b : a)).ring
  const centroid = ringCentroid(smallest)
  const { deg } = principalAxis(smallest)
  const [length, width] = layout === 'apartment' ? [CORE_SIZE_M.length * 0.75, CORE_SIZE_M.width * 0.8] : [CORE_SIZE_M.length, CORE_SIZE_M.width]
  const { minX, minY, maxX, maxY } = ringBounds(smallest)
  const grid: Point[] = []
  for (let x = minX; x <= maxX; x += CORE_SEARCH_M) for (let y = minY; y <= maxY; y += CORE_SEARCH_M) grid.push([x, y])
  const centres = [centroid, ...grid]
    .filter((point) => storeys.every(({ ring }) => pointInRing(point, ring)))
    .toSorted((a, b) => Math.hypot(a[0] - centroid[0], a[1] - centroid[1]) - Math.hypot(b[0] - centroid[0], b[1] - centroid[1]))
  for (let scale = 1; scale >= CORE_MIN_SCALE; scale -= 0.1) {
    for (const centre of centres) {
      const ring = orientedRect(centre, deg, length * scale, width * scale)
      const cleared = orientedRect(centre, deg, length * scale + 2 * CORE_CLEAR_M, width * scale + 2 * CORE_CLEAR_M)
      if (!storeys.every((storey) => inside(cleared, storey.ring))) continue
      const [dx, dy] = rotate([(length * scale) / 4, 0], deg)
      return { ring, elevatorAt: [centre[0] - dx, centre[1] - dy], stairAt: [centre[0] + dx, centre[1] + dy] }
    }
  }
  return null
}

// A ring without the slivers thinner than SLIVER_M, as the rings left. Open each piece on its own,
// because pieces that touch along a seam would merge back into one. The result is clipped to the
// ring, because a sharp corner grows back past where it was.
const openRing = (ring: Ring) => intersectRings(offsetRings(offsetRings([ring], -SLIVER_M / 2), SLIVER_M / 2), [ring])

// Cuts a region into strips across `axisDeg`, each `widthM` wide from `widthOf`, with a narrow end
// strip merged into the one before it.
function cutAcross(region: Ring, axisDeg: number, [minM, maxM]: readonly [number, number], random: () => number) {
  const turned = region.map((point) => rotate(point, -axisDeg))
  const { minX, maxX, minY, maxY } = ringBounds(turned)
  const cuts = [minX]
  while (maxX - cuts[cuts.length - 1] > maxM) cuts.push(cuts[cuts.length - 1] + minM + random() * (maxM - minM))
  if (cuts.length > 1 && maxX - cuts[cuts.length - 1] < minM) cuts.pop()
  cuts.push(maxX)
  return cuts.slice(1).flatMap((east, i) => {
    const west = cuts[i]
    const corners: Point[] = [[west, minY - 1], [east, minY - 1], [east, maxY + 1], [west, maxY + 1]]
    const strip = corners.map((point) => rotate(point, axisDeg))
    return intersectRings([region], [strip]).filter((ring) => ringArea(ring) >= MIN_ROOM_M2)
  })
}

type Drawn = { label: string; ring: Ring }

// A corridor along the long axis, around the core when the core stands in or against this region,
// and rooms cut across the axis on both sides of it. A core already cut out of the region still
// counts, so the corridor reaches it.
function corridorAndRooms(region: Ring, core: Ring | null, plan: (typeof LAYOUTS)[keyof typeof LAYOUTS], random: () => number): Drawn[] {
  const { deg, lengthM } = principalAxis(region)
  const coreHere = core && sharedArea(offsetRings([core], plan.corridorM), [region]) > 0.5 * ringArea(core) ? core : null
  const centre = coreHere ? ringCentroid(coreHere) : ringCentroid(region)
  const shapes = [orientedRect(centre, deg, lengthM * 3, plan.corridorM), ...(coreHere ? offsetRings([coreHere], plan.corridorM) : [])]
  const walked = unionRings(shapes)
  const corridor = subtractSplit(intersectRings([region], walked), coreHere ? [coreHere] : []).filter((ring) => ringArea(ring) >= MIN_ROOM_M2)
  const rooms = subtractSplit([region], walked).flatMap((part) => cutAcross(part, deg, plan.roomM, random)).flatMap(openRing).filter((ring) => ringArea(ring) >= MIN_ROOM_M2)
  return [
    ...corridor.map((ring) => ({ label: 'Corridor', ring })),
    ...rooms.map((ring) => ({ label: plan.room === 'Office' && random() < 0.15 ? 'Conference room' : plan.room, ring })),
  ]
}

// The longest edge of a ring, as its two ends and its outward compass bearing.
function longestEdge(ring: Ring) {
  const edges = ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length] }))
  return edges.reduce((best, edge) => (Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]) > Math.hypot(best.b[0] - best.a[0], best.b[1] - best.a[1]) ? edge : best))
}

const outward = ({ a, b }: { a: Point; b: Point }) => bearingDeg([0, 0], [b[1] - a[1], -(b[0] - a[0])])
const lengthOf = ({ a, b }: { a: Point; b: Point }) => Math.hypot(b[0] - a[0], b[1] - a[1])
const along = ({ a, b }: { a: Point; b: Point }, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

// The long edge facing the longest one, where a warehouse's docks go.
function facingEdge(ring: Ring) {
  const front = longestEdge(ring)
  const frontDeg = outward(front)
  const mid = along(front, 0.5)
  const facing = ring
    .map((a, i) => ({ a, b: ring[(i + 1) % ring.length] }))
    .filter((edge) => Math.abs(((outward(edge) - frontDeg + 540) % 360) - 180) < 20 && lengthOf(edge) >= DOCK.spacingM)
  return facing.reduce<{ a: Point; b: Point } | null>((best, edge) => {
    const far = (e: { a: Point; b: Point }) => Math.hypot(along(e, 0.5)[0] - mid[0], along(e, 0.5)[1] - mid[1])
    return !best || far(edge) > far(best) ? edge : best
  }, null)
}

// A warehouse region: an office strip along the entrance edge on the ground storey, and the rest
// one floor.
function warehouseOf(region: Ring, front: { a: Point; b: Point } | null): Drawn[] {
  if (!front) return [{ label: 'Warehouse floor', ring: region }]
  const { a, b } = front
  const length = lengthOf(front)
  const [nx, ny] = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length]
  const [ex, ey] = [((b[0] - a[0]) / length) * 2, ((b[1] - a[1]) / length) * 2]
  const strip: Ring = [
    [a[0] - ex, a[1] - ey],
    [b[0] + ex, b[1] + ey],
    [b[0] + ex + nx * OFFICE_STRIP_M, b[1] + ey + ny * OFFICE_STRIP_M],
    [a[0] - ex + nx * OFFICE_STRIP_M, a[1] - ey + ny * OFFICE_STRIP_M],
  ]
  const office = intersectRings([region], [strip]).filter((ring) => ringArea(ring) >= MIN_ROOM_M2)
  const floor = subtractSplit([region], [strip]).filter((ring) => ringArea(ring) >= MIN_ROOM_M2)
  return [...office.map((ring) => ({ label: 'Office', ring })), ...floor.map((ring) => ({ label: 'Warehouse floor', ring }))]
}

const nearSpace = (spaces: Space[], at: Point, reachM: number) =>
  spaces
    .map((space) => ({ space, distanceM: pointInRing(at, space.ring) ? 0 : nearestOnRing(at, space.ring).distanceM }))
    .filter(({ distanceM }) => distanceM <= reachM)
    .toSorted((a, b) => a.distanceM - b.distanceM)[0]?.space

// The ground storey's front door: on its longest edge where a space reaches the wall, nearest the
// middle, then on shorter edges.
function placeEntrance(storey: Storey, spaces: Space[]): Opening | null {
  const edges = storey.ring.map((a, i) => ({ a, b: storey.ring[(i + 1) % storey.ring.length] })).toSorted((x, y) => lengthOf(y) - lengthOf(x))
  for (const edge of edges.filter((e) => lengthOf(e) >= ENTRANCE_WIDTH_M)) {
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      const at = along(edge, t)
      const space = nearSpace(spaces, at, ON_WALL_M)
      if (!space) continue
      return {
        id: `gen-${storey.index}-entrance`,
        kind: 'exterior_door',
        at,
        widthM: ENTRANCE_WIDTH_M,
        heightM: null,
        bearingDeg: outward(edge),
        spaceIds: [space.id, null],
        source: 'inferred',
        confidence: CONFIDENCE.opening,
      }
    }
  }
  return null
}

function placeDocks(storey: Storey, spaces: Space[]): Opening[] {
  const edge = facingEdge(storey.ring)
  if (!edge) return []
  const count = Math.floor(lengthOf(edge) / DOCK.spacingM)
  return Array.from({ length: count }, (_, k) => along(edge, (k + 0.5) / count)).flatMap((at, k): Opening[] => {
    const space = nearSpace(spaces.filter(({ label }) => label === 'Warehouse floor'), at, ON_WALL_M)
    if (!space) return []
    return [{
      id: `gen-${storey.index}-dock-${k + 1}`,
      kind: 'exterior_door',
      at,
      widthM: DOCK.widthM,
      heightM: DOCK.heightM,
      bearingDeg: outward(edge),
      spaceIds: [space.id, null],
      source: 'inferred',
      confidence: CONFIDENCE.opening,
    }]
  })
}

const boxAround = (ring: Ring, padM: number) => {
  const { minX, minY, maxX, maxY } = ringBounds(ring)
  return { minX: minX - padM, minY: minY - padM, maxX: maxX + padM, maxY: maxY + padM }
}
const boxesMeet = (a: ReturnType<typeof boxAround>, b: ReturnType<typeof boxAround>) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY

// Joins every space to the roots: a space no opening reaches gets an inferred door or opening to a
// reached space it touches, until nothing changes. Returns the openings it added and the ids of
// spaces that stay unreached.
export function connectSpaces(spaces: Space[], openings: Opening[], roots: string[], idOf: (k: number) => string) {
  const links = new Map(spaces.map(({ id }) => [id, new Set<string>()]))
  const link = (a: string, b: string) => {
    links.get(a)?.add(b)
    links.get(b)?.add(a)
  }
  for (const { spaceIds: [a, b] } of openings) if (b !== null) link(a, b)
  const reached = new Set<string>()
  const reach = (id: string) => {
    const queue = [id]
    while (queue.length) {
      const next = queue.pop() ?? ''
      if (reached.has(next) || !links.has(next)) continue
      reached.add(next)
      queue.push(...(links.get(next) ?? []))
    }
  }
  roots.forEach(reach)
  const boxes = new Map(spaces.map((space) => [space.id, boxAround(space.ring, 0.5)]))
  const added: Opening[] = []
  let progress = true
  while (progress) {
    progress = false
    for (const space of spaces) {
      if (reached.has(space.id)) continue
      const box = boxes.get(space.id) ?? boxAround(space.ring, 0.5)
      const candidates = spaces
        .filter((other) => reached.has(other.id) && boxesMeet(box, boxes.get(other.id) ?? box))
        .toSorted((a, b) => Number(THROUGH.has(b.label)) - Number(THROUGH.has(a.label)))
      for (const other of candidates) {
        const door = doorBetween(other.ring, space.ring)
        if (!door || door.sharedM < DOOR_WIDTH_M + 0.2) continue
        // A third space in the gap between the two would cut the door off from one side.
        const passage = [orientedRect(door.at, -door.bearingDeg, DOOR_WIDTH_M, DOOR_DEPTH_M)]
        const cut = spaces.some((third) => third !== space && third !== other && boxesMeet(box, boxes.get(third.id) ?? box) && sharedArea(passage, [third.ring]) > 0.01)
        if (cut) continue
        const through = THROUGH.has(space.label) && THROUGH.has(other.label) && space.source === 'inferred' && other.source === 'inferred'
        added.push({
          id: idOf(added.length + 1),
          kind: through ? 'opening' : 'door',
          at: door.at,
          widthM: through ? Math.min(OPENING_MAX_M, door.sharedM - 0.2) : DOOR_WIDTH_M,
          heightM: through ? null : 2.1,
          bearingDeg: door.bearingDeg,
          spaceIds: [other.id, space.id],
          source: 'inferred',
          confidence: CONFIDENCE.opening,
        })
        link(other.id, space.id)
        reach(space.id)
        progress = true
        break
      }
    }
  }
  return { added, unreached: new Set(spaces.filter(({ id }) => !reached.has(id)).map(({ id }) => id)) }
}

export type Filled = { storey: Storey; landings: { elevator: Point; stair: Point } | null; filled: boolean }

// A scanned exterior door away from the storey's outside wall is a suite's front door. It becomes a
// door into the space just beyond it, such as the floor around the suite, or is dropped when no
// space is there, so a route never starts inside the building.
//   const openings = storey.openings.flatMap((opening) => indoorDoor(opening, storey.ring, spaces))
export function indoorDoor(opening: Opening, ring: Ring, spaces: Space[]): Opening[] {
  if (opening.kind !== 'exterior_door' || nearestOnRing(opening.at, ring).distanceM <= FACADE_M) return [opening]
  const [from] = opening.spaceIds
  const turn = (opening.bearingDeg * Math.PI) / 180
  const probes = BEYOND_DOOR_M.map((d): Point => [opening.at[0] + Math.sin(turn) * d, opening.at[1] + Math.cos(turn) * d])
  const beyond = probes.flatMap((at) => spaces.filter(({ id, ring: other }) => id !== from && pointInRing(at, other)))[0]
  return beyond ? [{ ...opening, kind: 'door', spaceIds: [from, beyond.id] }] : []
}

// Fills the part of one storey that no scanned space covers with spaces of `layout`, adds the core,
// the ground storey's entrance and a warehouse's docks, and joins every space to the core or the
// entrance. `roots` are points already reached from elsewhere, such as a scanned stair's landing.
// A generated space that cannot be joined is dropped.
//   const { storey, landings } = fillStorey(storeys[3], core, 'office', hashSeed('commercial-1:3'))
export function fillStorey(storey: Storey, core: Core | null, layout: Layout, seed: number, roots: Point[] = []): Filled {
  const random = mulberry32(seed)
  const index = storey.index
  const ground = index === 0
  const scanned = storey.spaces
  const covered = scanned.length ? closeGaps(scanned.map(({ ring }) => ring), WALL_GAP_M) : []
  const coreFree = core && areaOf(intersectRings([core.ring], covered)) < 0.01 * ringArea(core.ring) ? core : null
  const cut = [...covered, ...(coreFree ? [coreFree.ring] : [])]
  const pieces = cut.length ? subtractSplit([storey.ring], cut) : [storey.ring]
  const regions = pieces.flatMap(openRing).filter((ring) => ringArea(ring) >= MIN_REMAINDER_M2)
  const front = ground && layout === 'warehouse' ? longestEdge(storey.ring) : null

  const drawn = regions.flatMap((region): Drawn[] => {
    if (ringArea(region) < MIN_PLANNED_M2 || layout === 'open') return [{ label: 'Open floor', ring: region }]
    if (layout === 'warehouse') return warehouseOf(region, front)
    return corridorAndRooms(region, core?.ring ?? null, LAYOUTS[layout], random)
  })
  const generated: Space[] = [
    ...(coreFree ? [{ id: `gen-${index}-core`, label: 'Core', ring: coreFree.ring }] : []),
    ...drawn.map(({ label, ring }, k) => ({ id: `gen-${index}-space-${k + 1}`, label, ring })),
  ].map((space) => ({ ...space, source: 'inferred' as const, confidence: CONFIDENCE.space }))
  let spaces = [...scanned, ...generated]
  const openings = storey.openings.flatMap((opening) => indoorDoor(opening, storey.ring, spaces))

  let landings: Filled['landings'] = null
  if (core) {
    const centre = ringCentroid(core.ring)
    // A landing off every space moves to the nearest point a little inside one, not onto its wall.
    const settle = (at: Point): Point => {
      if (spaces.some(({ ring }) => pointInRing(at, ring))) return at
      const inner = spaces.flatMap(({ ring }) => offsetRings([ring], -LANDING_INSET_M))
      const nearest = inner.map((ring) => nearestOnRing(at, ring)).toSorted((a, b) => a.distanceM - b.distanceM)[0]
      return nearest?.at ?? at
    }
    landings = coreFree ? { elevator: core.elevatorAt, stair: core.stairAt } : { elevator: settle(centre), stair: settle(centre) }
  }
  // One root, so every space joins one walk: the core, else a scan's street door, else the
  // largest space. A space the walk cannot reach is dropped.
  const onFacade = ({ kind, at }: Opening) => kind === 'exterior_door' && nearestOnRing(at, storey.ring).distanceM <= FACADE_M
  const rootPoints = [...roots, ...(landings ? [landings.elevator, landings.stair] : [])]
  const landingIds = rootPoints.flatMap((at) => nearSpace(spaces, at, LANDING_REACH_M)?.id ?? [])
  const streetIds = openings.filter(onFacade).map(({ spaceIds: [id] }) => id)
  const largest = spaces.length ? spaces.reduce((a, b) => (ringArea(b.ring) > ringArea(a.ring) ? b : a)).id : null
  const root = landingIds[0] ?? streetIds[0] ?? largest
  const { added, unreached } = connectSpaces(spaces, openings, root ? [root] : [], (k) => `gen-${index}-door-${k}`)
  spaces = spaces.filter(({ id, source }) => source !== 'inferred' || !unreached.has(id))
  openings.push(...added)
  // The ground storey gets a street entrance into the walk unless a door on its outside wall
  // already opens into it. A scanned suite's front door opens onto the floor around it instead.
  if (ground && !openings.some((opening) => onFacade(opening) && !unreached.has(opening.spaceIds[0]))) {
    const entrance = placeEntrance(storey, spaces.filter(({ id }) => !unreached.has(id)))
    if (entrance) openings.push(entrance)
  }
  if (ground && layout === 'warehouse') openings.push(...placeDocks(storey, spaces))
  const kept = new Set(spaces.map(({ id }) => id))
  const lobby = openings.find(({ id }) => id === `gen-${index}-entrance`)?.spaceIds[0]
  return {
    storey: {
      ...storey,
      spaces: spaces.map((space) => (space.id === lobby && space.source === 'inferred' && space.label !== 'Corridor' && layout !== 'warehouse' ? { ...space, label: 'Lobby' } : space)),
      openings: openings.filter(({ spaceIds: [a, b] }) => kept.has(a) && (b === null || kept.has(b))),
    },
    landings,
    filled: generated.some(({ id }) => kept.has(id)),
  }
}

// Fills every storey of a building and adds the core's lift and stair, with landings on every
// storey. `connectors` are the stairs the scans gave, whose landings join the storeys they reach.
//   const { storeys, connectors, assumptions } = gapFill(placed, scanStairs, 'commercial-1', 'office')
export function gapFill(storeys: Storey[], connectors: Connector[], propertyId: string, layout: Layout) {
  const core = planCore(storeys, layout)
  const results = storeys.map((storey) => {
    const roots = connectors.flatMap(({ landings }) => landings.filter(({ storeyIndex }) => storeyIndex === storey.index).map(({ at }) => at))
    return fillStorey(storey, core, layout, hashSeed(`${propertyId}:${storey.index}`), roots)
  })
  const coreConnectors: Connector[] = core
    ? (['elevator', 'stair'] as const).map((kind) => ({
        id: `core-${kind}`,
        kind,
        landings: results.map(({ storey, landings }) => ({ storeyIndex: storey.index, at: landings?.[kind] ?? core.elevatorAt, openingId: null })),
        source: 'inferred',
        confidence: CONFIDENCE.connector,
      }))
    : []
  const filled = results.filter(({ filled }) => filled).map(({ storey }) => storey.index + 1)
  const assumptions = filled.length
    ? [`Storeys ${spanOf(filled)} are generated as a ${layout} layout, because no scan covers them.`]
    : []
  return { storeys: results.map(({ storey }) => storey), connectors: [...connectors, ...coreConnectors], core, assumptions }
}

// "1-4, 6" for [1, 2, 3, 4, 6].
function spanOf(numbers: number[]) {
  const runs: [number, number][] = []
  for (const n of numbers) {
    const last = runs[runs.length - 1]
    if (last && n === last[1] + 1) last[1] = n
    else runs.push([n, n])
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ')
}
