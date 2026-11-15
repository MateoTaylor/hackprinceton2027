import { LoaderCircle, X } from 'lucide-react'
import { Component, Suspense, useEffect, useState, type ReactNode } from 'react'
import type { Property } from '../../shared/property'
import { callOp, OpCallError } from './api'
import type { Tool } from './tools'

export type OpState<Result, Detail = undefined> =
  | { status: 'loading' }
  | { status: 'ready'; result: Result; detail: Detail }
  | { status: 'error'; error: OpCallError }

// Runs an op when the panel mounts and again whenever `name`, `input` or `detail` change by value,
// so a panel may pass a fresh object each render. A panel that draws geometry passes
// `{detail: true}`. Show the loading and error states with `<OpStatus state={...} />`:
//   const building = useOp<BuildingResult, BuildingModel>('building_get', { propertyId: property.id }, { detail: true })
//   if (building.status !== 'ready') return <OpStatus state={building} />
export function useOp<Result, Detail = undefined>(name: string, input: object, { detail = false } = {}): OpState<Result, Detail> {
  const key = JSON.stringify([name, input, detail])
  const [state, setState] = useState<{ key: string; op: OpState<Result, Detail> }>({ key, op: { status: 'loading' } })

  useEffect(() => {
    const controller = new AbortController()
    callOp<Result, Detail>(name, input, { detail, signal: controller.signal }).then(
      ({ result, detail }) => setState({ key, op: { status: 'ready', result, detail } }),
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ key, op: { status: 'error', error: asOpError(error) } })
      },
    )
    return () => controller.abort()
  }, [key])

  return state.key === key ? state.op : { status: 'loading' }
}

const asOpError = (error: unknown) =>
  error instanceof OpCallError ? error : new OpCallError('internal', error instanceof Error ? error.message : String(error), 'Reload the page and try again.')

export function OpStatus({ state }: { state: OpState<unknown, unknown> }) {
  if (state.status === 'ready') return null
  return state.status === 'loading' ? <PanelLoading /> : <PanelError message={state.error.message} hint={state.error.hint} />
}

function PanelLoading() {
  return (
    <div className="panel-state" role="status">
      <LoaderCircle className="panel-spinner" size={20} />
      Loading
    </div>
  )
}

function PanelError({ message, hint }: { message: string; hint: string }) {
  return (
    <div className="panel-state error" role="alert">
      <strong>{message}</strong>
      <span>{hint}</span>
    </div>
  )
}

class PanelBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    const { error } = this.state
    return error ? <PanelError message={error.message} hint="Close the panel and open it again." /> : this.props.children
  }
}

type Props = { tool: Tool; property: Property; onClose: () => void }

export function ToolPanel({ tool, property, onClose }: Props) {
  const Panel = tool.panel
  return (
    <section className={`tool-panel${tool.canvas ? ' canvas' : ''}`} aria-label={`${tool.label} for ${property.name}`}>
      <header className="tool-panel-head">
        <div className="tool-panel-label">
          <tool.icon size={20} className="tool-panel-icon" aria-hidden />
          <div className="tool-panel-title">
            <strong>{tool.label}</strong>
            <span>{property.name}</span>
          </div>
        </div>
        <button className="circle panel-close" aria-label={`Close ${tool.label}`} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="tool-panel-body">
        <PanelBoundary key={`${tool.id}:${property.id}`}>
          <Suspense fallback={<PanelLoading />}>
            <Panel property={property} />
          </Suspense>
        </PanelBoundary>
      </div>
    </section>
  )
}
