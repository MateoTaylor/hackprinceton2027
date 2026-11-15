import { useCallback, useEffect, useRef, useState } from 'react'
import type { Move, Screen, ServerEvent, View, ViewReport, WriteEvent } from '../../shared/view'

// This tab's id. `callOp` and `PUT /api/view` send it as `x-propstar-client`, so the server names
// this tab as the writer and the tab can drop its own reports when they come back.
export const clientId = crypto.randomUUID()

export const INITIAL_VIEW: View = {
  version: 0,
  screen: { kind: 'browse' },
  camera: null,
  bounds: null,
  filter: { kind: null, type: null, sort: 'name', savedOnly: false },
  shown: null,
  highlights: [],
}

const REPORT_MS = 250
// The server pings every 10 s. A stream silent for longer than this is stalled, as one through the
// Vite proxy is after the API restarts, so the tab reopens it.
const STALE_MS = 25_000
// How long the tab waits to reopen after an error, such as the proxy's 502 while the API is down.
const RETRY_MS = 1000

// Hears every write op by another writer. `useView` feeds it, and panels listen through `useWrites`.
const writeListeners = new Set<(event: WriteEvent) => void>()

// Calls `listener` on each write op by another tab, Proppy or a script, while the component is
// mounted. The latest `listener` is the one called, so it may close over fresh state:
//   useWrites((event) => { if (event.propertyId === property.id && event.op.startsWith('signage_')) reload() })
export function useWrites(listener: (event: WriteEvent) => void) {
  const latest = useRef(listener)
  latest.current = listener
  useEffect(() => {
    const call = (event: WriteEvent) => latest.current(event)
    writeListeners.add(call)
    return () => {
      writeListeners.delete(call)
    }
  }, [])
}

// The last move request with a counter, so the map applies each request once.
export type MoveRequest = { seq: number; request: Move }

type State = { view: View; move: MoveRequest | null }

// What a `view` event does to this tab. An event by this tab is its own report coming back and is
// dropped; any other replaces the view and carries its move, if any.
export function onViewEvent(state: State, event: ServerEvent, self: string): State {
  if (event.type !== 'view' || event.by === self) return state
  return { view: event.view, move: event.move ? { seq: (state.move?.seq ?? 0) + 1, request: event.move } : state.move }
}

// Merges reports and sends at most one every `wait` ms, on the trailing edge. `flush` sends what
// is waiting now.
export function createReporter(send: (report: ViewReport) => void, wait = REPORT_MS) {
  let pending: ViewReport | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (pending) send(pending)
    pending = null
  }
  return {
    report(change: ViewReport) {
      pending = { ...pending, ...change }
      timer ??= setTimeout(flush, wait)
    },
    flush,
  }
}

const put = (report: ViewReport) =>
  void fetch('/api/view', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-propstar-client': clientId },
    body: JSON.stringify(report),
  }).catch(() => {})

// The view this tab shows, kept in step with the server over `GET /api/events`.
//   setScreen(screen)   shows a screen here and reports it
//   report(change)      reports the camera, bounds or filter, merged into one request per 250 ms
//   move                the last move request, for the map to apply once
//   requestMove(move)   asks the map to move from this tab, as a view op would
// The tab reopens the stream after an error or a missed heartbeat, and the first event after that is
// the server's view.
export function useView() {
  const [state, setState] = useState<State>({ view: INITIAL_VIEW, move: null })
  const [reporter] = useState(() => createReporter(put))

  useEffect(() => {
    let source: EventSource
    let timer: ReturnType<typeof setTimeout> | undefined
    const reopen = (delay: number) => {
      clearTimeout(timer)
      source.close()
      timer = setTimeout(open, delay)
    }
    const alive = () => {
      clearTimeout(timer)
      timer = setTimeout(() => reopen(0), STALE_MS)
    }
    const onMessage = (message: MessageEvent<string>) => {
      alive()
      const event: ServerEvent = JSON.parse(message.data)
      if (event.type === 'write') {
        if (event.by !== clientId) for (const listener of writeListeners) listener(event)
        return
      }
      setState((s) => onViewEvent(s, event, clientId))
    }
    const open = () => {
      source = new EventSource('/api/events')
      source.onmessage = onMessage
      source.addEventListener('ping', alive)
      source.onerror = () => reopen(RETRY_MS)
      alive()
    }
    open()
    return () => {
      clearTimeout(timer)
      source.close()
      reporter.flush()
    }
  }, [reporter])

  const setScreen = useCallback((screen: Screen) => {
    setState((s) => ({ ...s, view: { ...s.view, screen } }))
    put({ screen })
  }, [])

  const requestMove = useCallback((request: Move) => setState((s) => ({ ...s, move: { seq: (s.move?.seq ?? 0) + 1, request } })), [])

  return { view: state.view, move: state.move, setScreen, report: reporter.report, requestMove }
}
