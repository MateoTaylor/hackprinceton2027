import { useEffect, useRef, useState } from 'react'
import { mountScene, type SceneHandle } from './host'

export type ViewerState = { status: 'loading' } | { status: 'ready'; handle: SceneHandle } | { status: 'error'; message: string }

// Mounts the viewer for `spaceId` in the element that takes `container` as its ref, and mounts it
// again when `spaceId` changes. The handle is gone once the panel closes, so stop using it in the
// cleanup of any effect that depends on `viewer`.
//   const { container, viewer } = useScene(spaceId)
//   return <div className="scene-viewer" ref={container} />
export function useScene(spaceId: string) {
  const container = useRef<HTMLDivElement>(null)
  const [viewer, setViewer] = useState<ViewerState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    let handle: SceneHandle | undefined
    setViewer({ status: 'loading' })
    mountScene(container.current!, spaceId, controller.signal).then(
      (mounted) => {
        handle = mounted
        setViewer({ status: 'ready', handle: mounted })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setViewer({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      controller.abort()
      handle?.dispose()
    }
  }, [spaceId])

  return { container, viewer }
}
