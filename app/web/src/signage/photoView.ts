import type { Direction } from '../../../shared/api'
import { shortestTurn } from '../stance.ts'

// How the Signage photo is framed and turned, in photo pixels. The panel shows `frame`, the part of
// the photo around the building, magnified `scale` times about the centre `cx`, `cy`. Turning moves
// between the oblique photos, which look along the bearings in LOOK_DEG.

export type Box = { x: number; y: number; w: number; h: number }
export type Zoom = { scale: number; cx: number; cy: number }

export const MAX_SCALE = 8
export const LOOK_DEG = { north: 0, east: 90, south: 180, west: 270 } satisfies Record<Direction, number>

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)

// The whole frame, unmagnified.
export const fitted = (frame: Box): Zoom => ({ scale: 1, cx: frame.x + frame.w / 2, cy: frame.y + frame.h / 2 })

// The viewBox showing `frame` at `zoom`, slid back inside the frame where it would leave it.
export function viewBoxOf(frame: Box, { scale, cx, cy }: Zoom): Box {
  const [w, h] = [frame.w / scale, frame.h / scale]
  return { x: clamp(cx - w / 2, frame.x, frame.x + frame.w - w), y: clamp(cy - h / 2, frame.y, frame.y + frame.h - h), w, h }
}

// `zoom` with its centre moved by `dx`, `dy` photo pixels and kept inside the frame.
export function panned(frame: Box, zoom: Zoom, dx: number, dy: number): Zoom {
  const box = viewBoxOf(frame, { ...zoom, cx: zoom.cx + dx, cy: zoom.cy + dy })
  return { scale: zoom.scale, cx: box.x + box.w / 2, cy: box.y + box.h / 2 }
}

// `zoom` magnified by `factor`, between 1 and MAX_SCALE, keeping the photo pixel `at` where it is
// on screen, as a pinch or wheel does about the pointer.
export function zoomedAbout(frame: Box, zoom: Zoom, factor: number, [ax, ay]: [number, number]): Zoom {
  const scale = clamp(zoom.scale * factor, 1, MAX_SCALE)
  const box = viewBoxOf(frame, zoom)
  const k = zoom.scale / scale
  const [cx, cy] = [box.x + box.w / 2, box.y + box.h / 2]
  return panned(frame, { scale, cx: ax + (cx - ax) * k, cy: ay + (cy - ay) * k }, 0, 0)
}

// The photo a turn of `turnDeg` from `from` rests on: the one nearest the heading it reached, as
// the map's oblique view settles an orbit or a pinch-rotate.
export function turnRest(available: readonly Direction[], from: Direction, turnDeg: number) {
  const heading = LOOK_DEG[from] + turnDeg
  return available.reduce((best, d) => (Math.abs(shortestTurn(heading, LOOK_DEG[d])) < Math.abs(shortestTurn(heading, LOOK_DEG[best])) ? d : best), from)
}

// The next photo clockwise (`by` 1) or anticlockwise (-1) from `from`, as the arrow keys step.
export function turnStep(available: readonly Direction[], from: Direction, by: 1 | -1) {
  const ahead = (d: Direction) => (by * (LOOK_DEG[d] - LOOK_DEG[from]) + 720) % 360 || 360
  return available.reduce((best, d) => (ahead(d) < ahead(best) ? d : best), from)
}
