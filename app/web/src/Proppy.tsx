import { AIMessage, ToolMessage } from '@langchain/core/messages'
import { useStream } from '@langchain/react'
import { ArrowUp, ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { actionRequests, describeAction, type Decision } from './approval'
import mascot from './assets/proppy-mascot.png'
import './proppy.css'

// The LangGraph dev server listens on ::1 only, so 127.0.0.1 does not reach it.
const AGENT_URL = 'http://localhost:2024'

const SUGGESTIONS = [
  'Which of these are wheelchair-friendly?',
  'Hang a sign on 2838 Potomac Ave. Which lift reaches it?',
  'Remove an object or remodel a room at 2838 Potomac Ave.',
]

// What each tool call shows in the thread. A tool missing here shows its own name.
const TOOL_LINES: Record<string, string> = {
  property_get: 'Read a property record',
  property_query: 'Searched properties',
  building_get: 'Read the building model',
  route_solve: 'Traced a route',
  area_places: 'Looked up nearby places',
  area_summary: 'Read the area around a property',
  features_get: 'Read the property features',
  features_detect: 'Looked for features in the scan',
  equipment_list: 'Listed the equipment',
  lift_choose: 'Chose a lift',
  signage_get: 'Read the building walls',
  signage_place: 'Hung a sign',
  signage_move: 'Moved a sign',
  signage_remove: 'Took a sign down',
  signage_measure: 'Measured a sign',
  signage_camera: 'Framed a sign',
  scene_get: 'Read the objects in a scan',
  scene_place: 'Placed an object',
  scene_move: 'Moved an object',
  scene_remove: 'Removed an object',
  picture_edit_list: 'Listed the prepared picture edits',
  picture_edit_apply: 'Applied a picture edit',
  view_get: 'Checked the screen',
  view_open: 'Opened a panel',
  view_frame: 'Moved the map',
  view_camera: 'Moved the camera',
  view_highlight: 'Coloured the pins',
  view_aerial: 'Looked at the aerial',
  web_search: 'Searched the web',
  task: 'Asked a scorer to study one property',
  read_file: 'Read a skill',
  write_todos: 'Planned the steps',
}

type Item = { key: string; kind: 'human' | 'agent' | 'tool'; text: string }

// The thread as the user reads it: questions, answers, and one quiet line per tool call. A
// tool result never shows. A call whose result came back as an error was rejected or refused.
function threadItems(messages: ReturnType<typeof useStream>['messages']): Item[] {
  const refused = new Set(messages.flatMap((m) => (ToolMessage.isInstance(m) && m.status === 'error' ? [m.tool_call_id] : [])))
  return messages.flatMap((m, i): Item[] => {
    const key = m.id ?? String(i)
    const text = m.text.trim()
    if (m.type === 'human') return text ? [{ key, kind: 'human', text }] : []
    if (!AIMessage.isInstance(m)) return []
    const searches = Array.isArray(m.content) ? m.content.filter((block) => block.type === 'server_tool_use').map(() => 'web_search') : []
    const calls = [...searches.map((name, j) => ({ name, id: `${key}-search-${j}` })), ...(m.tool_calls ?? []).map((c, j) => ({ name: c.name, id: c.id ?? `${key}-${j}` }))]
    const lines = calls.map(({ name, id }): Item => {
      const line = TOOL_LINES[name] ?? name
      return { key: id, kind: 'tool', text: refused.has(id) ? `${line} · not run` : line }
    })
    return text ? [...lines, { key, kind: 'agent', text }] : lines
  })
}

type Trouble = 'no-api' | 'offline' | 'needs-key' | 'failed'

const TROUBLE: Record<Trouble, { title: string; body: string }> = {
  'no-api': { title: 'Propstar API is off', body: 'Start the Propstar server, then try again.' },
  offline: { title: 'Proppy is offline', body: 'Start the agent server on localhost:2024, then try again.' },
  'needs-key': { title: 'Proppy needs a model key', body: 'Add a model key to .env and restart the agent server.' },
  failed: { title: 'Proppy hit an error', body: 'The run stopped before it finished. Try asking again.' },
}

// A run without a key fails with a JSON-encoded message, so match on words rather than parse it.
function classify(error: unknown): Trouble {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (/Propstar API is not reachable/i.test(text)) return 'no-api'
  if (/failed to fetch|networkerror|load failed|econnrefused/i.test(text)) return 'offline'
  if (/api[_ ]?key|apikey|\b401\b|unauthori[sz]ed|authentication|credential/i.test(text)) return 'needs-key'
  return 'failed'
}

const RING = 2 * Math.PI * 22

type Props = { open: boolean; onOpen: () => void; onClose: () => void; onRunning: (running: boolean) => void }

// Proppy stays mounted while collapsed so a run keeps streaming behind the pill. Pins come from
// the view's highlights, which Proppy's ops write, so the panel reports only whether a run is
// streaming. A write op waits on an approval card until the user approves or rejects it.
export function Proppy({ open, onOpen, onClose, onRunning }: Props) {
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

  const turns = threadItems(stream.messages)
  const requests = actionRequests(stream.interrupt?.value)

  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight })
  }, [turns.length, turns.at(-1)?.text, requests.length])

  useEffect(() => onRunning(stream.isLoading), [stream.isLoading, onRunning])

  const error = stream.error
  const errorTrouble = error === undefined ? null : classify(error)

  // Once the server echoes the question into the thread, a later error must not put it back in the
  // draft. Sends wait for the previous run, so a new last human turn is always the latest ask.
  const lastHuman = turns.findLast((t) => t.kind === 'human')?.key
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
  const canSend = online === true && !stream.isLoading && requests.length === 0
  const subagents = [...stream.subagents.values()]
  const running = subagents.filter((s) => s.status === 'running').length
  const done = subagents.length - running

  const ask = (text: string) => {
    const content = text.trim()
    if (!content || !canSend) return
    lastAsk.current = content
    setDraft('')
    void stream.submit({ messages: [{ type: 'human', content }] })
  }

  // One decision per action request, in order, resumes the paused run.
  const decide = (type: Decision['type']) =>
    void stream.respond({ decisions: requests.map((): Decision => ({ type })) }, { interruptId: stream.interrupt?.id })

  if (!open && requests.length) {
    return (
      <div className="surface-pill proppy-pill">
        <img className="pill-mascot" src={mascot} alt="" />
        <span className="pill-text">
          <strong>Proppy is waiting for you</strong>
          <span>Approve or reject in the chat</span>
        </span>
        <button className="circle accent" aria-label="Open Proppy" onClick={onOpen}>
          <ChevronUp size={16} />
        </button>
      </div>
    )
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
    : requests.length
      ? { dot: 'warn', text: 'Waiting for your approval' }
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
        {turns.map((t) => (
          <div key={t.key} className={t.kind === 'human' ? 'bubble' : t.kind === 'tool' ? 'tool-line' : 'agent-text'}>
            {t.text}
          </div>
        ))}
        {requests.map((request, i) => {
          const { line, args } = describeAction(request)
          return (
            <div key={i} className="approval" role="group" aria-label="Approve this change">
              <strong>{line}</strong>
              {args.length > 0 && (
                <dl>
                  {args.map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )
        })}
        {requests.length > 0 && (
          <div className="approval-actions">
            <button className="button quiet" onClick={() => decide('reject')}>
              Reject
            </button>
            <button className="button" onClick={() => decide('approve')}>
              Approve
            </button>
          </div>
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
