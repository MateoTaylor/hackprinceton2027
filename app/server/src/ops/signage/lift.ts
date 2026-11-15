import { EQUIPMENT, type Equipment, type EquipmentClass } from '../../model/equipment.ts'

// The lift classes from the smallest and cheapest to hire to the largest.
export const LIFT_CLASS_ORDER: readonly EquipmentClass[] = ['slab_scissor', 'rough_terrain_scissor', 'articulating_boom', 'telescopic_boom']

export type LiftNeed = { heightM: number; outreachM: number; ground: 'paved' | 'unpaved'; overObstacle: boolean }
type Lift = Equipment & { workingHeightM: number }

const LIFTS = EQUIPMENT.filter((row): row is Lift => LIFT_CLASS_ORDER.includes(row.class) && row.workingHeightM !== null).sort(
  (a, b) => LIFT_CLASS_ORDER.indexOf(a.class) - LIFT_CLASS_ORDER.indexOf(b.class) || a.workingHeightM - b.workingHeightM,
)

export const TALLEST_LIFT = LIFTS.reduce((tallest, lift) => (lift.workingHeightM > tallest.workingHeightM ? lift : tallest))

const fits = (lift: Lift, { heightM, outreachM, ground, overObstacle }: LiftNeed) =>
  lift.workingHeightM >= heightM &&
  (lift.outreachM ?? 0) >= outreachM &&
  (ground === 'paved' || lift.terrain === 'rough') &&
  (!overObstacle || lift.class === 'articulating_boom')

// The smallest lift that meets the need, with up to three larger ones that also do, or null when
// no lift in the catalogue does.
export function chooseLift(need: LiftNeed) {
  const [lift, ...alternatives] = LIFTS.filter((candidate) => fits(candidate, need))
  return lift ? { lift, alternatives: alternatives.slice(0, 3) } : null
}
