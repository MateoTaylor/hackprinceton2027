// n8ao ships no types. This covers the part of its postprocessing pass that the stage uses.
declare module 'n8ao' {
  import { Pass } from 'postprocessing'
  import type { Camera, Scene } from 'three'

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number)
    configuration: { aoRadius: number; distanceFalloff: number; intensity: number; halfRes: boolean }
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void
  }
}
