import type { BuildingModel, Furnishing, Opening, Point, Ring, Space, Storey } from './building.ts'

type Provenance = Pick<Space, 'source' | 'confidence'>

const COSTAR: Provenance = { source: 'costar', confidence: 1 }
const VEXCEL: Provenance = { source: 'vexcel', confidence: 0.9 }
const SCAN: Provenance = { source: 'scan', confidence: 0.95 }
const GUESS: Provenance = { source: 'inferred', confidence: 0.5 }

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
]

const space = (id: string, label: string, ring: Ring, provenance = GUESS): Space => ({ id, label, ring, ...provenance })

const door = (id: string, at: Point, bearingDeg: number, spaceIds: [string, string], provenance = GUESS): Opening => ({
  id,
  kind: 'door',
  at,
  widthM: 0.9,
  heightM: 2.1,
  bearingDeg,
  spaceIds,
  ...provenance,
})

const exteriorDoor = (id: string, at: Point, bearingDeg: number, spaceId: string, widthM: number, heightM = 2.1): Opening => ({
  id,
  kind: 'exterior_door',
  at,
  widthM,
  heightM,
  bearingDeg,
  spaceIds: [spaceId, null],
  ...COSTAR,
})

const item = (id: string, kind: Furnishing['kind'], spaceId: string, at: Point, provenance = GUESS): Furnishing => ({
  id,
  kind,
  spaceId,
  at,
  yawDeg: 0,
  ...provenance,
})

function stack(heights: number[], build: (index: number) => Omit<Storey, 'index' | 'elevationM' | 'heightM'>): Storey[] {
  let elevationM = 0
  return heights.map((heightM, index) => {
    const storey = { index, elevationM, heightM, ...build(index) }
    elevationM += heightM
    return storey
  })
}

const top = (storeys: Storey[]) => storeys.reduce((height, storey) => height + storey.heightM, 0)

const INVENTED = 'This building is invented. Every room, door and furnishing in it is made up.'

const PODIUM = rect(-28, -18, 28, 18)
const PLATE = rect(-20, -12, 20, 12)
const SCANNED_OFFICE_STOREY = 5

const officeGround = () => ({
  label: 'Ground',
  ring: PODIUM,
  ...COSTAR,
  spaces: [
    space('g-lobby', 'Lobby', rect(-12, -18, 12, 18)),
    space('g-retail-west', 'Retail west', rect(-28, -18, -12, 18)),
    space('g-retail-east', 'Retail east', rect(12, -18, 28, 18)),
  ],
  openings: [
    exteriorDoor('g-entrance', [0, -18], 180, 'g-lobby', 2.4),
    exteriorDoor('g-retail-west-entrance', [-20, -18], 180, 'g-retail-west', 1.8),
    exteriorDoor('g-retail-east-entrance', [20, -18], 180, 'g-retail-east', 1.8),
    door('g-lobby-west', [-12, 6], 270, ['g-lobby', 'g-retail-west']),
    door('g-lobby-east', [12, 6], 90, ['g-lobby', 'g-retail-east']),
  ],
  furnishings: [
    item('g-reception', 'counter', 'g-lobby', [0, -11]),
    item('g-sofa-west', 'sofa', 'g-lobby', [-8, -12]),
    item('g-sofa-east', 'sofa', 'g-lobby', [8, -12]),
    item('g-plant', 'plant', 'g-lobby', [-11, 17]),
    ...[-24, -16].map((x, n) => item(`g-west-shelf-${n + 1}`, 'shelf', 'g-retail-west', [x, 17.5])),
    item('g-west-counter', 'counter', 'g-retail-west', [-20, 10]),
    ...[16, 24].map((x, n) => item(`g-east-table-${n + 1}`, 'table', 'g-retail-east', [x, 0])),
    item('g-east-counter', 'counter', 'g-retail-east', [20, 12]),
  ],
})

function officeStorey(index: number) {
  const provenance = index === SCANNED_OFFICE_STOREY ? SCAN : GUESS
  const [west, core, east] = [`s${index}-west`, `s${index}-core`, `s${index}-east`]
  const opening: Opening = {
    id: `s${index}-core-west`,
    kind: 'opening',
    at: [-4, 0],
    widthM: 2,
    heightM: null,
    bearingDeg: 270,
    spaceIds: [core, west],
    ...provenance,
  }
  const desks = [-16, -10].flatMap((x) => [-8, -3, 3, 8].map((y): Point => [x, y]))
  const chairs: Point[] = [
    [10.5, 4.9],
    [13.5, 4.9],
    [10.5, 7.1],
    [13.5, 7.1],
  ]
  return {
    label: `Floor ${index + 1}`,
    ring: PLATE,
    ...COSTAR,
    spaces: [
      space(west, 'Open office west', rect(-20, -12, -4, 12), provenance),
      space(core, 'Core', rect(-4, -12, 4, 12), provenance),
      space(east, 'Open office east', rect(4, -12, 20, 12), provenance),
    ],
    openings: [opening, door(`s${index}-core-east`, [4, 0], 90, [core, east], provenance)],
    furnishings: [
      ...desks.map((at, n) => item(`s${index}-desk-${n + 1}`, 'desk', west, at, provenance)),
      ...desks.map(([x, y], n) => item(`s${index}-chair-${n + 1}`, 'chair', west, [x, y - 0.7], provenance)),
      item(`s${index}-conference`, 'conference_table', east, [12, 6], provenance),
      ...chairs.map((at, n) => item(`s${index}-meeting-chair-${n + 1}`, 'chair', east, at, provenance)),
      item(`s${index}-shelf`, 'shelf', east, [12, -11.6], provenance),
      item(`s${index}-plant`, 'plant', east, [19, -11], provenance),
    ],
  }
}

const officeStoreys = stack([4.5, ...Array<number>(11).fill(3.6)], (index) => (index === 0 ? officeGround() : officeStorey(index)))

const officeTower: BuildingModel = {
  propertyId: 'fixture-office-tower',
  origin: { lat: 29.75, lon: -95.36, groundElevationM: 14 },
  shell: {
    heightM: top(officeStoreys),
    volumes: [
      { id: 'tower', ring: PLATE, baseM: 0, topM: top(officeStoreys), primary: true, ...VEXCEL },
      { id: 'podium', ring: PODIUM, baseM: 0, topM: officeStoreys[0].heightM, primary: false, ...VEXCEL },
    ],
  },
  context: [
    { ring: rect(-70, -20, -40, 20), heightM: 18 },
    { ring: rect(40, -30, 80, -5), heightM: 30 },
  ],
  storeys: officeStoreys,
  connectors: [
    {
      id: 'tower-elevator',
      kind: 'elevator',
      landings: officeStoreys.map(({ index }) => ({ storeyIndex: index, at: [-2, 6], openingId: null })),
      ...GUESS,
    },
    {
      id: 'tower-stair',
      kind: 'stair',
      landings: officeStoreys.map(({ index }) => ({ storeyIndex: index, at: [2, -6], openingId: null })),
      ...GUESS,
    },
  ],
  scans: [
    {
      modelId: 'fixture-office-scan',
      name: 'Invented office floor',
      storeyIndexes: [SCANNED_OFFICE_STOREY],
      transform: { tx: -20, ty: -12, yawDeg: 0 },
      fit: 'outline',
      iou: 0.91,
      flipAmbiguous: false,
      confidence: 0.9,
    },
  ],
  assumptions: [INVENTED],
}

const WAREHOUSE_PLATE = rect(-30, -18, 30, 18)
const RACK_COLUMNS = Array.from({ length: 14 }, (_, n) => -14 + 3 * n)
const DOCKS = [0, 7, 14, 21]

const warehouseStoreys = stack([10], () => ({
  label: 'Ground',
  ring: WAREHOUSE_PLATE,
  ...COSTAR,
  spaces: [space('wh-office', 'Office', rect(-30, -18, -22, 18)), space('wh-floor', 'Warehouse floor', rect(-22, -18, 30, 18))],
  openings: [
    exteriorDoor('wh-front-door', [-30, 0], 270, 'wh-office', 1),
    door('wh-office-floor', [-22, 0], 90, ['wh-office', 'wh-floor']),
    ...DOCKS.map((x, n) => exteriorDoor(`wh-dock-${n + 1}`, [x, 18], 0, 'wh-floor', 3, 3.5)),
  ],
  furnishings: [
    ...[-12, -6, 6, 12].flatMap((y, n) => [
      item(`wh-desk-${n + 1}`, 'desk', 'wh-office', [-27, y]),
      item(`wh-chair-${n + 1}`, 'chair', 'wh-office', [-27, y - 0.7]),
    ]),
    item('wh-counter', 'counter', 'wh-office', [-26, 16.5]),
    item('wh-sink', 'sink', 'wh-office', [-29, 16.5]),
    ...[-12, -7, -2, 3].flatMap((y, row) => RACK_COLUMNS.map((x, column) => item(`wh-rack-${row + 1}-${column + 1}`, 'rack', 'wh-floor', [x, y]))),
    ...DOCKS.map((x, n) => item(`wh-pallet-${n + 1}`, 'pallet', 'wh-floor', [x, 14])),
    item('wh-crate-1', 'crate', 'wh-floor', [3.5, 15]),
    item('wh-crate-2', 'crate', 'wh-floor', [10.5, 15]),
    item('wh-machine', 'machine', 'wh-floor', [-17, 13]),
  ],
}))

const warehouse: BuildingModel = {
  propertyId: 'fixture-warehouse',
  origin: { lat: 29.8, lon: -95.3, groundElevationM: 12 },
  shell: {
    heightM: top(warehouseStoreys),
    volumes: [{ id: 'warehouse', ring: WAREHOUSE_PLATE, baseM: 0, topM: top(warehouseStoreys), primary: true, ...VEXCEL }],
  },
  context: [{ ring: rect(40, -18, 70, 18), heightM: 9 }],
  storeys: warehouseStoreys,
  connectors: [],
  scans: [],
  assumptions: [INVENTED],
}

const APARTMENT_PLATE = rect(-16, -10, 16, 10)
const SCANNED_UNIT = { storey: 1, corner: 'ne' }

const UNITS = [
  { corner: 'sw', letter: 'A', ring: rect(-16, -10, 0, -1.5), centre: [-8, -5.75], intoUnitY: -1 },
  { corner: 'se', letter: 'B', ring: rect(0, -10, 16, -1.5), centre: [8, -5.75], intoUnitY: -1 },
  { corner: 'nw', letter: 'C', ring: rect(-16, 1.5, 0, 10), centre: [-8, 5.75], intoUnitY: 1 },
  { corner: 'ne', letter: 'D', ring: rect(0, 1.5, 16, 10), centre: [8, 5.75], intoUnitY: 1 },
] as const

function apartmentStorey(index: number) {
  const corridor = `a${index}-corridor`
  const units = UNITS.map((unit) => {
    const id = `a${index}-unit-${unit.corner}`
    const provenance = index === SCANNED_UNIT.storey && unit.corner === SCANNED_UNIT.corner ? SCAN : GUESS
    const [cx, cy] = unit.centre
    const at = (dx: number, dy: number): Point => [cx + dx, cy + unit.intoUnitY * dy]
    return {
      space: space(id, `Unit ${index + 1}${unit.letter}`, unit.ring, provenance),
      door: door(`${id}-door`, [cx, unit.intoUnitY * 1.5], unit.intoUnitY > 0 ? 0 : 180, [corridor, id]),
      furnishings: [
        item(`${id}-bed`, 'bed', id, at(-5, 1), provenance),
        item(`${id}-sofa`, 'sofa', id, at(4, 0), provenance),
        item(`${id}-table`, 'table', id, at(0, 1.5), provenance),
        item(`${id}-counter`, 'counter', id, at(-2, 3.9), provenance),
        item(`${id}-toilet`, 'toilet', id, at(6.5, 3.5), provenance),
        item(`${id}-sink`, 'sink', id, at(5.5, 3.6), provenance),
      ],
    }
  })
  return {
    label: `Floor ${index + 1}`,
    ring: APARTMENT_PLATE,
    ...COSTAR,
    spaces: [space(corridor, 'Corridor', rect(-16, -1.5, 16, 1.5)), ...units.map((unit) => unit.space)],
    openings: [
      ...(index === 0
        ? [exteriorDoor('a0-east-door', [16, 0], 90, corridor, 1.2), exteriorDoor('a0-west-door', [-16, 0], 270, corridor, 1)]
        : []),
      ...units.map((unit) => unit.door),
    ],
    furnishings: units.flatMap((unit) => unit.furnishings),
  }
}

const apartmentStoreys = stack([3.2, 3, 3], apartmentStorey)

const apartment: BuildingModel = {
  propertyId: 'fixture-apartment',
  origin: { lat: 34.05, lon: -118.3, groundElevationM: 90 },
  shell: {
    heightM: top(apartmentStoreys),
    volumes: [{ id: 'apartment', ring: APARTMENT_PLATE, baseM: 0, topM: top(apartmentStoreys), primary: true, ...VEXCEL }],
  },
  context: [
    { ring: rect(-16, 16, 16, 36), heightM: 12 },
    { ring: rect(24, -10, 44, 10), heightM: 6 },
  ],
  storeys: apartmentStoreys,
  connectors: [
    {
      id: 'apartment-stair',
      kind: 'stair',
      landings: apartmentStoreys.map(({ index }) => ({ storeyIndex: index, at: [-13, 0], openingId: null })),
      ...GUESS,
    },
  ],
  scans: [
    {
      modelId: 'fixture-apartment-scan',
      name: 'Invented apartment unit',
      storeyIndexes: [SCANNED_UNIT.storey],
      transform: { tx: 0, ty: 1.5, yawDeg: 0 },
      fit: 'inferred',
      iou: null,
      flipAmbiguous: true,
      confidence: 0.55,
    },
  ],
  assumptions: [INVENTED],
}

// Three invented buildings that pass `checkBuilding`, for tests and for drawing with no server.
// The office tower has a podium, a lift, a stair and one scanned floor. The warehouse has dock
// doors, an office strip and racking. The apartment has four units per floor, a stair and no lift,
// and one scanned unit.
//   const { storeys } = FIXTURES.officeTower
export const FIXTURES = { officeTower, warehouse, apartment }
