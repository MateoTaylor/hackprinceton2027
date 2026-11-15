import { OpError } from '../op.ts'
import type { Payload } from './doorFit.ts'

export const PAYLOAD_NAMES = ['person', 'wheelchair', 'pallet_jack', 'scissor_lift', 'grand_piano', 'custom'] as const
export type PayloadName = (typeof PAYLOAD_NAMES)[number]

// Each preset is the size that has to pass a door, with the sentence a route states about it.
export const PAYLOAD_PRESETS: Record<Exclude<PayloadName, 'custom'>, { payload: Payload; assumption: string }> = {
  person: { payload: { widthM: 0.55, heightM: 1.9, wheeled: false }, assumption: 'A person is taken as 0.55 m wide and 1.9 m tall.' },
  wheelchair: { payload: { widthM: 0.7, heightM: 1.4, wheeled: true }, assumption: 'A wheelchair with its user is taken as 0.70 m wide and 1.4 m tall.' },
  pallet_jack: { payload: { widthM: 1.02, heightM: 1.5, wheeled: true }, assumption: 'A loaded pallet jack is taken as 1.02 m wide and 1.5 m tall.' },
  scissor_lift: { payload: { widthM: 0.81, heightM: 2, wheeled: true }, assumption: 'A stowed scissor lift is taken as 0.81 m wide and 2.0 m tall.' },
  grand_piano: { payload: { widthM: 0.75, heightM: 1.65, wheeled: true }, assumption: 'A grand piano on its side on a dolly is taken as 0.75 m wide and 1.65 m tall.' },
}

// The payload a route input names. A custom payload is not wheeled and needs both sizes, else
// `invalid_input`.
//   const { payload, assumption } = resolvePayload({ payload: 'wheelchair' })
export function resolvePayload(input: { payload: PayloadName; widthM?: number; heightM?: number }) {
  if (input.payload !== 'custom') return PAYLOAD_PRESETS[input.payload]
  const { widthM, heightM } = input
  if (widthM === undefined || heightM === undefined) {
    throw new OpError('invalid_input', 'A custom payload needs widthM and heightM.', 'Pass both sizes in metres, or pick a preset payload.')
  }
  return {
    payload: { widthM, heightM, wheeled: false },
    assumption: `The custom payload is ${widthM} m wide and ${heightM} m tall and is carried, so stairs are open to it.`,
  }
}
