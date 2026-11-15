// The groups an area op sorts places into, in the order area_summary lists them.
export const AREA_GROUPS = ['food', 'grocery', 'transit', 'health', 'school', 'park', 'bank', 'fuel'] as const

export type AreaGroup = (typeof AREA_GROUPS)[number]

// Overture `basic_category` values per group. A category in no group is left out of every area
// op. The lists come from the categories of named places around the covered properties.
const MEMBERS: Record<AreaGroup, string[]> = {
  food: [
    'restaurant',
    'casual_eatery',
    'fast_food_restaurant',
    'coffee_shop',
    'cafe',
    'bar',
    'food_truck_stand',
    'smoothie_juice_bar',
    'food_service',
    'food_and_drink',
    'non_alcoholic_beverage_venue',
  ],
  grocery: ['food_and_beverage_store', 'convenience_store', 'farmers_market', 'market', 'warehouse_club_store'],
  transit: ['public_transit_facility_or_service', 'train_station'],
  health: [
    'health_care',
    'primary_care_or_general_clinic',
    'dental_clinic',
    'hospital',
    'specialty_hospital',
    'pharmacy_and_drug_store',
    'urgent_care_clinic',
    'emergency_or_urgent_care_facility',
    'emergency_department',
    'walk_in_clinic',
    'pediatric_clinic',
    'outpatient_care_facility',
    'vision_or_eye_care_clinic',
  ],
  school: ['preschool', 'elementary_school', 'middle_school', 'high_school', 'college_university'],
  park: ['park', 'playground', 'dog_park', 'skate_park', 'national_park', 'garden', 'nature_reserve'],
  bank: ['bank_or_credit_union', 'atm'],
  fuel: ['gas_station', 'fueling_station', 'ev_charging_station'],
}

// The group of each Overture category that belongs to one.
//   CATEGORY_GROUPS.get('coffee_shop') // 'food'
export const CATEGORY_GROUPS = new Map(AREA_GROUPS.flatMap((group) => MEMBERS[group].map((category) => [category, group] as const)))
