import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { FRAME_MS, frameOf, isResting, REST, spritePosition, step, type Mood } from './sequence'
import './mascot.css'

// What Proppy is doing: `idle` holds the hero pose, `working` writes with pencil and paper,
// `analyzing` searches with the magnifying glass.
export type MascotMood = Mood

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const subscribeReducedMotion = (onChange: () => void) => {
  reducedMotion.addEventListener('change', onChange)
  return () => reducedMotion.removeEventListener('change', onChange)
}

// Proppy's animated mascot. It fills the box its `className` sizes, like the <img> it replaced.
// A mood change plays the turn and tools-out intro, then loops; going back to idle (or to the other
// tool) plays the put-away outro first. Reduced motion holds the hero pose.
//   <Mascot mood={running ? 'working' : 'idle'} className="pill-mascot" />
export function Mascot({ mood, className }: { mood: MascotMood; className?: string }) {
  const reduced = useSyncExternalStore(subscribeReducedMotion, () => reducedMotion.matches)
  const [state, setState] = useState(REST)
  const moodRef = useRef(mood)
  useEffect(() => {
    moodRef.current = mood
  }, [mood])

  const resting = isResting(state, mood)
  const animating = !reduced && !resting
  useEffect(() => {
    if (!animating) return
    const timer = setInterval(() => setState((s) => step(s, moodRef.current)), FRAME_MS)
    return () => clearInterval(timer)
  }, [animating])

  const frame = reduced ? 'hero' : frameOf(state)
  return (
    <span
      className={`mascot${resting ? ' mascot-bob' : ''}${className ? ` ${className}` : ''}`}
      style={{ backgroundPosition: spritePosition(frame) }}
      aria-hidden="true"
    />
  )
}
