// Proppy's animation as a pure state machine, stepped once per frame by <Mascot>. Frames follow the
// Paper brief "README / Mascot brief": limited animation at 8 fps that snaps pose to pose.
//   let s = REST
//   s = step(s, 'working')  // every FRAME_MS while !isResting(s, mood)
//   frameOf(s)              // 'T1', then 'T2', ...

// Every frame in the sprite sheet, in sheet order (6 columns, read left to right, top to bottom).
// `hero` is the idle pose, T the turn to face front, W the working sheet (W3 is unused and `4b`
// replaces it), A the analyzing sheet.
export const FRAMES = [
  'hero', 'T1', 'T2', 'T3', 'T4',
  'W1', 'W2', '4b', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9',
  'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9',
] as const
export type Frame = (typeof FRAMES)[number]
export const SHEET_COLUMNS = 6
export const SHEET_ROWS = Math.ceil(FRAMES.length / SHEET_COLUMNS)
export const FRAME_MS = 125

export type Tool = 'working' | 'analyzing'
export type Mood = 'idle' | Tool

const TURN: Frame[] = ['T1', 'T2', 'T3', 'T4']
const TURN_BACK = TURN.toReversed()
const HAPPY: Frame[] = ['W9', 'W9', 'W9', 'W9'] // held 0.5 s

// Each tool opens with an intro, repeats its loop while the mood holds, and closes with an outro.
const SEQUENCES: Record<Tool, { intro: Frame[]; loop: Frame[]; outro: Frame[] }> = {
  working: {
    intro: [...TURN, 'W1', 'W2', '4b', 'W4'],
    loop: ['W5', 'W6', 'W7', 'W8'],
    outro: ['W4', '4b', 'W2', ...HAPPY, 'W1', ...TURN_BACK],
  },
  analyzing: {
    intro: [...TURN, 'A1', 'A2', 'A3', 'A4'],
    loop: ['A7', 'A8', 'A6', 'A5'],
    outro: ['A9', 'A3', 'A2', ...HAPPY, 'A1', ...TURN_BACK],
  },
}

// `intro` plays forward while the mood asks for its tool and backward (back to the hero) once it
// stops asking, so a change mid-intro never jumps. The outro always plays to its end.
export type State =
  | { phase: 'rest' }
  | { phase: 'intro' | 'loop' | 'outro'; tool: Tool; index: number }

export const REST: State = { phase: 'rest' }

export function isResting(state: State, mood: Mood) {
  return state.phase === 'rest' && mood === 'idle'
}

export function step(state: State, mood: Mood): State {
  switch (state.phase) {
    case 'rest':
      return mood === 'idle' ? state : { phase: 'intro', tool: mood, index: 0 }
    case 'intro': {
      const { intro } = SEQUENCES[state.tool]
      if (mood !== state.tool) return state.index === 0 ? REST : { ...state, index: state.index - 1 }
      return state.index + 1 < intro.length ? { ...state, index: state.index + 1 } : { phase: 'loop', tool: state.tool, index: 0 }
    }
    case 'loop': {
      if (mood !== state.tool) return { phase: 'outro', tool: state.tool, index: 0 }
      const { loop } = SEQUENCES[state.tool]
      return { ...state, index: (state.index + 1) % loop.length }
    }
    case 'outro': {
      const { outro } = SEQUENCES[state.tool]
      return state.index + 1 < outro.length ? { ...state, index: state.index + 1 } : REST
    }
  }
}

export function frameOf(state: State): Frame {
  return state.phase === 'rest' ? 'hero' : SEQUENCES[state.tool][state.phase][state.index]
}

// The sprite cell of a frame as CSS background-position percentages, for a sheet drawn at
// `background-size: SHEET_COLUMNS*100% SHEET_ROWS*100%`.
export function spritePosition(frame: Frame) {
  const i = FRAMES.indexOf(frame)
  const x = ((i % SHEET_COLUMNS) / (SHEET_COLUMNS - 1)) * 100
  const y = (Math.floor(i / SHEET_COLUMNS) / (SHEET_ROWS - 1)) * 100
  return `${x}% ${y}%`
}
