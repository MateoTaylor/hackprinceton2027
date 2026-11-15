import { LoaderCircle, Sparkles } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { PictureEdit, PictureEditList } from '../../../server/src/ops/edit/index.ts'
import { OpStatus, useOp } from '../ToolPanel'
import type { PanelProps } from '../tools'
import { useWrites } from '../view'
import './edit.css'

type Tool = PictureEdit['tool']
type Listed = PictureEditList['edits'][number]

const WORDS: Record<Tool, { run: string; running: string; placeholder: string }> = {
  erase: { run: 'Erase', running: 'Erasing', placeholder: 'What should disappear?' },
  remodel: { run: 'Remodel', running: 'Remodelling', placeholder: 'What should change, and to what?' },
}

// True when a write event's result is a picture edit of `tool`. The server checked the result
// against the op's output schema; this keeps another tool's edit out of this panel.
const isPictureEdit = (result: unknown, tool: Tool): result is PictureEdit =>
  typeof result === 'object' &&
  result !== null &&
  'tool' in result &&
  result.tool === tool &&
  'editId' in result &&
  typeof result.editId === 'string' &&
  'command' in result &&
  typeof result.command === 'string' &&
  'afterUrl' in result &&
  typeof result.afterUrl === 'string'

// The picture shows the running state at least this long, so a prepared edit reads as a run.
const RUN_MS = 1400

// The body of the Magic Eraser and Remodel panels. It lists the property's prepared edits of
// `tool`, offers their commands as suggestions, runs picture_edit_apply on a command and shows the
// answer as a before and after compare:
//   export default function EditPanel({ property }: PanelProps) {
//     return <PictureEditor property={property} tool="erase" />
//   }
export function PictureEditor({ property, tool }: PanelProps & { tool: Tool }) {
  const list = useOp<PictureEditList>('picture_edit_list', { propertyId: property.id, tool })
  if (list.status !== 'ready') return <OpStatus state={list} />
  if (!list.result.edits.length) return <p className="panel-note">This property has no prepared edits for this tool.</p>
  return <EditorView propertyId={property.id} tool={tool} edits={list.result.edits} />
}

// A command this panel runs, or an edit Proppy or another tab applied, shown as it came.
type Run = { count: number } & ({ command: string } | { heard: PictureEdit })

function EditorView({ propertyId, tool, edits }: { propertyId: string; tool: Tool; edits: Listed[] }) {
  const [command, setCommand] = useState('')
  const [picked, setPicked] = useState(edits[0])
  const [run, setRun] = useState<Run | null>(null)
  const words = WORDS[tool]

  useWrites((event) => {
    if (event.op !== 'picture_edit_apply' || event.propertyId !== propertyId || !isPictureEdit(event.result, tool)) return
    const heard = event.result
    setCommand(heard.command)
    setPicked(edits.find(({ editId }) => editId === heard.editId) ?? picked)
    setRun({ heard, count: (run?.count ?? 0) + 1 })
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = command.trim()
    if (text.length >= 3) setRun({ command: text, count: (run?.count ?? 0) + 1 })
  }
  const suggest = (edit: Listed) => {
    setCommand(edit.command)
    setPicked(edit)
    setRun(null)
  }

  return (
    <div className="picture-editor">
      {run && 'heard' in run ? (
        <Applied key={run.count} edit={run.heard} />
      ) : run ? (
        <RunResult key={run.count} propertyId={propertyId} tool={tool} command={run.command} before={picked} running={words.running} />
      ) : (
        <Frame caption={picked.where}>
          <img className="picture" src={picked.beforeUrl} alt={`Before: ${picked.where ?? 'scan picture'}`} />
        </Frame>
      )}
      <form className="picture-command" onSubmit={submit}>
        <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={words.placeholder} aria-label="Command" maxLength={300} />
        <button className="button" type="submit" disabled={command.trim().length < 3}>
          <Sparkles size={16} aria-hidden />
          {words.run}
        </button>
      </form>
      <div className="picture-suggestions" role="group" aria-label="Prepared commands">
        {edits.map((edit) => (
          <button key={edit.editId} type="button" className="chip" aria-pressed={edit.editId === picked.editId && command === edit.command} onClick={() => suggest(edit)}>
            {edit.command}
          </button>
        ))}
      </div>
    </div>
  )
}

function Frame({ caption, children }: { caption: string | null; children: ReactNode }) {
  return (
    <figure className="picture-frame">
      {children}
      {caption && <figcaption className="picture-where">{caption}</figcaption>}
    </figure>
  )
}

type RunProps = { propertyId: string; tool: Tool; command: string; before: Listed; running: string }

// Runs one command. The editor remounts it per run, so each run starts in the running state.
function RunResult({ propertyId, tool, command, before, running }: RunProps) {
  const applied = useOp<PictureEdit>('picture_edit_apply', { propertyId, tool, command })
  const [waited, setWaited] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), RUN_MS)
    return () => clearTimeout(timer)
  }, [])

  if (applied.status === 'ready' && waited) return <Applied edit={applied.result} />

  return (
    <>
      <Frame caption={before.where}>
        <img className="picture" src={before.beforeUrl} alt={`Before: ${before.where ?? 'scan picture'}`} />
        {applied.status !== 'error' && (
          <div className="picture-running" role="status">
            <LoaderCircle className="panel-spinner" size={20} aria-hidden />
            {running}
          </div>
        )}
      </Frame>
      {applied.status === 'error' && <OpStatus state={applied} />}
    </>
  )
}

// One applied edit as a before and after compare, with the command and the edit's first assumption.
function Applied({ edit }: { edit: PictureEdit }) {
  return (
    <>
      <Frame caption={edit.where}>
        <Compare beforeUrl={edit.beforeUrl} afterUrl={edit.afterUrl} />
      </Frame>
      <p className="picture-note">
        {edit.command}. {edit.assumptions[0]}
      </p>
    </>
  )
}

// The after picture with the before picture over its left part. Drag the handle, or use the arrow
// keys on it, to move the split. It opens by wiping from all before to half and half.
function Compare({ beforeUrl, afterUrl }: { beforeUrl: string; afterUrl: string }) {
  const [split, setSplit] = useState(100)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setSplit(50))
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div className={`picture-compare${dragging ? ' dragging' : ''}`}>
      <img className="picture" src={afterUrl} alt="After" />
      <img className="picture compare-before" src={beforeUrl} alt="Before" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} />
      <span className="compare-label before">Before</span>
      <span className="compare-label after">After</span>
      <span className="compare-handle" style={{ left: `${split}%` }} aria-hidden />
      <input
        type="range"
        min={0}
        max={100}
        value={split}
        aria-label="Before and after split"
        onPointerDown={() => setDragging(true)}
        onPointerUp={() => setDragging(false)}
        onChange={(event) => setSplit(Number(event.target.value))}
      />
    </div>
  )
}
