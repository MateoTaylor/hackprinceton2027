import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { RenderSlide } from '../../shared/api'
import { maskFrame, quadMatrix, toThree, viewRay, type Point, type Rect } from './renderAnchor'
import type { SceneHandle } from './scene/host'

type Props = { handle: SceneHandle; slides: RenderSlide[] }

// A frame pinned on each edited object the visitor can see from the sweep they stand on, holding
// that part of Mateo's picture, with < and > to flip it between before and after. Render it over
// the viewer, in a box the same size as the viewer, keyed by the sweep.
export function AnchoredEdits({ handle, slides }: Props) {
  return (
    <div className="anchored-edits">
      {slides.map((slide) => (
        <AnchoredEdit key={slide.after} handle={handle} slide={slide} />
      ))}
    </div>
  )
}

function AnchoredEdit({ handle, slide }: { handle: SceneHandle; slide: RenderSlide }) {
  const frame = useMaskFrame(slide.mask)
  const [after, setAfter] = useState(false)
  const quad = useRef<HTMLDivElement>(null)
  const controls = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!frame) return
    const { three, camera } = handle
    const corners = ([[frame.x0, frame.y0], [frame.x1, frame.y0], [frame.x1, frame.y1], [frame.x0, frame.y1]] as Point[]).map(([x, y]) =>
      new three.Vector3(...toThree(viewRay(slide.view, x, y))),
    )
    const eye = new three.Vector3()
    const point = new three.Vector3()
    let raf = 0

    // Each frame, place the corners' directions around the camera and project them. The camera
    // never leaves the sweep, so directions alone fix where the object is on screen.
    const place = () => {
      raf = requestAnimationFrame(place)
      const box = quad.current?.parentElement?.getBoundingClientRect()
      if (!box || !quad.current || !controls.current) return
      camera.getWorldPosition(eye)
      const screen: Point[] = []
      for (const corner of corners) {
        point.copy(corner).add(eye)
        if (point.clone().applyMatrix4(camera.matrixWorldInverse).z >= 0) break
        point.project(camera)
        screen.push([((point.x + 1) / 2) * box.width, ((1 - point.y) / 2) * box.height])
      }
      const visible = screen.length === 4
      quad.current.style.visibility = controls.current.style.visibility = visible ? 'visible' : 'hidden'
      if (!visible) return
      quad.current.style.transform = quadMatrix(frame.x1 - frame.x0, frame.y1 - frame.y0, screen)
      // Under the frame's bottom edge, but kept inside the viewer when the frame runs off it.
      const { offsetWidth: w, offsetHeight: h } = controls.current
      const x = Math.min(Math.max((screen[2][0] + screen[3][0]) / 2 - w / 2, 16), box.width - w - 16)
      const y = Math.min(Math.max(screen[2][1], screen[3][1]) + 10, box.height - h - 16)
      controls.current.style.transform = `translate(${x}px, ${y}px)`
    }
    place()
    return () => cancelAnimationFrame(raf)
  }, [frame, handle, slide.view])

  if (!frame) return null
  const { width, height } = slide.view
  return (
    <>
      <div className="anchored-quad" ref={quad} style={{ width: frame.x1 - frame.x0, height: frame.y1 - frame.y0, visibility: 'hidden' }}>
        <img
          src={after ? slide.after : slide.before}
          alt=""
          style={{ width, height, left: -frame.x0, top: -frame.y0 }}
        />
      </div>
      <div className="anchored-controls" ref={controls} style={{ visibility: 'hidden' }}>
        <button className="circle overlay" aria-label="Before" disabled={!after} onClick={() => setAfter(false)}>
          <ChevronLeft size={16} />
        </button>
        <span title={slide.command}>{after ? 'After' : 'Before'}</span>
        <button className="circle overlay" aria-label="After" disabled={after} onClick={() => setAfter(true)}>
          <ChevronRight size={16} />
        </button>
      </div>
    </>
  )
}

// The frame around what a slide's mask changed, in view pixels, once the mask has loaded.
function useMaskFrame(url: string) {
  const [frame, setFrame] = useState<Rect | null>(null)
  useEffect(() => {
    let live = true
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      if (live) setFrame(maskFrame(context.getImageData(0, 0, canvas.width, canvas.height)))
    }
    image.src = url
    return () => {
      live = false
    }
  }, [url])
  return frame
}
