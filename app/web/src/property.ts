import type { Property } from '../../shared/property'

export const fact = (p: Property, label: string) => p.facts.find((f) => f.label === label)?.value

// A residential listing's first money fact carries its label ("Rent", "Sold for", ...), so find it by value.
export const priceFact = (p: Property) => p.facts.find((f) => f.value.startsWith('$'))

const number = (value: string | undefined) => {
  const digits = value?.match(/[\d,.]+/)?.[0].replaceAll(',', '')
  return digits ? Number(digits) : undefined
}

const compactUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 })

// The map pin carries one value. Only listings have a price, so commercial pins drop to a dot.
export function pinLabel(p: Property) {
  const price = priceFact(p)
  const amount = number(price?.value)
  if (!price || amount === undefined) return null
  return `${compactUsd.format(amount)}${price.value.endsWith('/mo') ? '/mo' : ''}`
}

export const areaOf = (p: Property) => number(fact(p, 'Size') ?? fact(p, 'Living area'))
export const yearOf = (p: Property) => number(fact(p, 'Year built')?.slice(0, 4))

const stars = (rating: string | undefined) => (rating ? `${rating.split(' ')[0]}★` : undefined)

// The card's spec line, using only fields CoStar provided.
export function specLine(p: Property) {
  const parts =
    p.kind === 'commercial'
      ? [fact(p, 'Size'), fact(p, 'Class') && `Class ${fact(p, 'Class')}`, stars(fact(p, 'Rating'))]
      : [fact(p, 'Beds') && `${fact(p, 'Beds')} bd`, fact(p, 'Baths') && `${fact(p, 'Baths')} ba`, fact(p, 'Living area')]
  return parts.filter(Boolean).join(' · ')
}

export function metaLine(p: Property) {
  const price = priceFact(p)
  if (price) return `${price.label} ${price.value}`
  const year = fact(p, 'Year built')
  return [p.typeLabel, year && `Built ${year}`].filter(Boolean).join(' · ')
}

export const SORTS = {
  name: { label: 'Name', compare: (a: Property, b: Property) => a.name.localeCompare(b.name) },
  largest: { label: 'Largest first', compare: (a: Property, b: Property) => (areaOf(b) ?? -1) - (areaOf(a) ?? -1) },
  newest: { label: 'Newest first', compare: (a: Property, b: Property) => (yearOf(b) ?? -1) - (yearOf(a) ?? -1) },
} as const
export type SortKey = keyof typeof SORTS
export const isSortKey = (value: string): value is SortKey => value in SORTS
