import type { Move, ServerEvent, View } from '../../../shared/view.ts'

export type ViewChange = Partial<Omit<View, 'version'>>

export interface ViewStore {
  get(): View
  // Merges `change`, adds 1 to `version` and sends a `view` event to every listener.
  apply(change: ViewChange, by: string, move?: Move): View
  // Sends a `write` event naming the write op that just succeeded.
  publishWrite(op: string, by: string): void
  // Returns the function that unsubscribes.
  subscribe(listener: (event: ServerEvent) => void): () => void
  // How many listeners are subscribed, which is the number of open tabs.
  attached(): number
}

export const INITIAL_VIEW: View = {
  version: 0,
  screen: { kind: 'browse' },
  camera: null,
  bounds: null,
  filter: { kind: null, type: null, sort: 'name', savedOnly: false },
  highlights: [],
}

// The one in-memory view the server holds. A listener that throws is dropped, so one broken
// stream cannot stop the others.
export function createViewStore(initial: View = INITIAL_VIEW): ViewStore {
  let view = initial
  const listeners = new Set<(event: ServerEvent) => void>()

  const send = (event: ServerEvent) => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        listeners.delete(listener)
      }
    }
  }

  return {
    get: () => view,
    apply(change, by, move) {
      view = { ...view, ...change, version: view.version + 1 }
      send(move ? { type: 'view', view, by, move } : { type: 'view', view, by })
      return view
    },
    publishWrite: (op, by) => send({ type: 'write', op, by }),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    attached: () => listeners.size,
  }
}
