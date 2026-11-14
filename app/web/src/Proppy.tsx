import { useChannelEffect, useStream } from '@langchain/react'
import { ArrowUp, ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import mascot from './assets/proppy-mascot.png'
import { applyPin, NO_PINS, parsePinEvent, settlePins, type Pins } from './pins'

// The LangGraph dev server listens on ::1 only, so 127.0.0.1 does not reach it.
const AGENT_URL = 'http://localhost:2024'

const SUGGESTIONS = ['Which of these are wheelchair-friendly?', 'Which have the most parking?']

type Trouble = 'offline' | 'needs-key' | 'failed'

const TROUBLE: Record<Trouble, { title: string; body: string }> = {
  offline: { title: 'Proppy is offline', body: 'Start the agent server on localhost:2024, then try again.' },
  'needs-key': { title: 'Proppy needs a model key', body: 'Add a model key to .env and restart the agent server.' },
  failed: { title: 'Proppy hit an error', body: 'The run stopped before it finished. Try asking again.' },
}

// A run without a key fails with a JSON-encoded message, so match on words rather than parse it.
function classify(error: unknown): Trouble {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (/failed to fetch|networkerror|load failed|econnrefused/i.test(text)) return 'offline'
  if (/api[_ ]?key|apikey|\b401\b|unauthori[sz]ed|authentication|credential/i.test(text)) return 'needs-key'
  return 'failed'
}

const RING = 2 * Math.PI * 22

// Pin events come from the score-property subagents, one namespace below the root. The server
// streams subgraphs on every protocol run and a root `custom` subscription reaches one level
// down, so submit needs no extra option.
const PIN_CHANNELS = ['custom'] as const

type Props = { open: boolean; onOpen: () => void; onClose: () => void; onPins: (update: (pins: Pins) => Pins) => void }

// Proppy stays mounted while collapsed so a run keeps streaming behind the pill. It reports pin
// colours through `onPins`, and clears them when the user asks a new question.
export function Proppy({ open, onOpen, onClose, onPins }: Props) {
  // Without the optimistic echo, a send that never reaches the server leaves no question behind
  // to show twice when the user asks again.
  const stream = useStream({ apiUrl: AGENT_URL, assistantId: 'proppy', optimistic: false })
  const [online, setOnline] = useState<boolean | null>(null)
  const [healthCheck, setHealthCheck] = useState(0)
  const [draft, setDraft] = useState('')
  const lastAsk = useRef('')
  const thread = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setOnline(null)
    fetch(`${AGENT_URL}/ok`, { signal: controller.signal }).then(
      (res) => setOnline(res.ok),
      () => controller.signal.aborted || setOnline(false),
    )
    return () => controller.abort()
  }, [open, healthCheck])

  const turns = stream.messages.flatMap((m, i) => {
    const text = m.text.trim()
    return text && (m.type === 'human' || m.type === 'ai') ? [{ key: m.id ?? String(i), human: m.type === 'human', text }] : []
  })

  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight })
  }, [turns.length, turns.at(-1)?.text])

  useChannelEffect(stream, PIN_CHANNELS, {
    onEvent: (event) => {
      const pin = event.method === 'custom' ? parsePinEvent(event.params.data) : null
      if (pin) onPins((pins) => applyPin(pins, pin))
    },
  })

  const error = stream.error
  const errorTrouble = error === undefined ? null : classify(error)

  useEffect(() => {
    if (!stream.isLoading || error !== undefined) onPins(settlePins)
  }, [stream.isLoading, error, onPins])

  // Once the server echoes the question into the thread, a later error must not put it back in the
  // draft. Sends wait for the previous run, so a new last human turn is always the latest ask.
  const lastHuman = turns.findLast((t) => t.human)?.key
  useLayoutEffect(() => {
    lastAsk.current = ''
  }, [lastHuman])

  // A network failure counts as a failed health check, so `online` alone decides "offline" and a
  // passing Check again ends it. The SDK reports it through `stream.error` rather than rejecting
  // submit, so the unsent question goes back to the draft here, before the browser paints "Ready".
  useLayoutEffect(() => {
    if (errorTrouble !== 'offline') return
    setOnline(false)
    setDraft((d) => d || lastAsk.current)
  }, [error, errorTrouble])

  const trouble = online === false ? 'offline' : errorTrouble === 'offline' ? null : errorTrouble
  const canSend = online === true && !stream.isLoading
  const subagents = [...stream.subagents.values()]
  const running = subagents.filter((s) => s.status === 'running').length
  const done = subagents.length - running

  const ask = (text: string) => {
    const content = text.trim()
    if (!content || !canSend) return
    lastAsk.current = content
    setDraft('')
    onPins(() => NO_PINS)
    void stream.submit({ messages: [{ type: 'human', content }] })
  }

  if (!open && stream.isLoading) {
    return (
      <div className="surface-pill proppy-pill">
        <span className={`ring${subagents.length ? '' : ' spinning'}`}>
          <img src={mascot} alt="" />
          <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden>
            <circle cx="24" cy="24" r="22" fill="none" stroke="#2A2D32" strokeWidth="3" />
            <circle
              cx="24"
              cy="24"
              r="22"
              fill="none"
              stroke="#3D8BDB"
              strokeWidth="3"
              strokeLinecap="round"
              transform="rotate(-90 24 24)"
              strokeDasharray={`${subagents.length ? (RING * done) / subagents.length : RING / 4} ${RING}`}
            />
          </svg>
        </span>
        <span className="pill-text">
          <strong>{subagents.length ? 'Proppy is scoring' : 'Proppy is thinking'}</strong>
          <span>{subagents.length ? `${done} of ${subagents.length} subagents done` : 'Working on your question'}</span>
        </span>
        <button className="circle accent" aria-label="Open Proppy" onClick={onOpen}>
          <ChevronUp size={16} />
        </button>
      </div>
    )
  }

  if (!open) {
    return (
      <button className="surface-pill proppy-fab" onClick={onOpen}>
        <img src={mascot} alt="" />
        Ask Proppy
      </button>
    )
  }

  const status = trouble
    ? { dot: trouble === 'offline' ? 'off' : 'warn', text: TROUBLE[trouble].title }
    : stream.isLoading
      ? { dot: '', text: running ? `Analyzing · ${running} subagent${running === 1 ? '' : 's'} running` : 'Thinking' }
      : { dot: online === null ? 'off' : '', text: online === null ? 'Connecting' : 'Ready' }

  return (
    <section className="chat" aria-label="Proppy">
      <div className="chat-head">
        <img src={mascot} alt="" />
        <div className="chat-head-text">
          <strong>Proppy</strong>
          <span className="status">
            <span className={`status-dot ${status.dot}`} />
            {status.text}
          </span>
        </div>
        <button className="circle accent" aria-label="Collapse Proppy" onClick={onClose}>
          <ChevronDown size={16} />
        </button>
      </div>

      <div className="thread" ref={thread}>
        {turns.length === 0 && !trouble && (
          <p className="agent-text muted">Ask about the properties on the map. Proppy reads each one's CoStar record, aerial and 3D scan.</p>
        )}
        {turns.map((t) =>
          t.human ? (
            <div key={t.key} className="bubble">
              {t.text}
            </div>
          ) : (
            <div key={t.key} className="agent-text">
              {t.text}
            </div>
          ),
        )}
        {trouble && (
          <div className="notice" role="status">
            <strong>{TROUBLE[trouble].title}</strong>
            {TROUBLE[trouble].body}
            {trouble === 'offline' && (
              <button className="button quiet" style={{ alignSelf: 'flex-start', marginTop: 8 }} onClick={() => setHealthCheck((n) => n + 1)}>
                Check again
              </button>
            )}
          </div>
        )}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          ask(draft)
        }}
      >
        <div className="composer-input">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={turns.length ? 'Ask a follow-up…' : 'Ask Proppy…'} aria-label="Message Proppy" />
          {stream.isLoading ? (
            <button type="button" className="circle accent" aria-label="Stop" onClick={() => void stream.stop()}>
              <span className="stop-square" />
            </button>
          ) : (
            <button type="submit" className="circle accent" aria-label="Send" disabled={!draft.trim() || !canSend}>
              <ArrowUp size={16} />
            </button>
          )}
        </div>
        {turns.length === 0 && (
          <div className="chip-row">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="chip" disabled={!canSend} onClick={() => ask(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
      </form>
    </section>
  )
}
