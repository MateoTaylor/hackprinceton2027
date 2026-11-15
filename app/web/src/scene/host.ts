import '@matterport/webcomponent'
import type * as THREE from 'three'
// The package's `exports` map names no types, so its declarations are reached by path.
import type { MpSdk, Scene } from '../../node_modules/@matterport/webcomponent/types'

declare global {
  interface HTMLElementTagNameMap {
    'matterport-viewer': MatterportViewer
  }
}

// The viewer's SDK and its three.js scene. Build every object added to `scene` with `three`, the
// viewer's own module, because a second copy of three.js breaks `instanceof` checks inside the viewer.
export type SceneHandle = {
  sdk: MpSdk
  three: typeof THREE
  scene: THREE.Scene
  camera: THREE.Camera
  renderer: THREE.WebGLRenderer
  meshes(): THREE.Mesh[]
  dispose(): void
}

const ASSET_BASE = '/node_modules/@matterport/webcomponent/built-bundle/'
const SETTLE_MS = 500
const LOAD_TIMEOUT_MS = 90_000

// Mounts the Showcase viewer for `spaceId` inside `container` and resolves once the scan's meshes
// have loaded. Aborting `signal` removes the viewer and rejects. Call `dispose()` on the handle
// before mounting another space.
export async function mountScene(container: HTMLElement, spaceId: string, signal?: AbortSignal): Promise<SceneHandle> {
  const timeout = AbortSignal.timeout(LOAD_TIMEOUT_MS)
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
  const sdkKey = await readSdkKey(deadline)
  const viewer = document.createElement('matterport-viewer')
  viewer.setAttribute('m', spaceId)
  viewer.setAttribute('application-key', sdkKey)
  viewer.setAttribute('asset-base', ASSET_BASE)
  viewer.setAttribute('play', '1')
  viewer.setAttribute('qs', '1')

  let sceneObject: Scene.IObject | undefined
  const dispose = () => {
    sceneObject?.stop()
    viewer.remove()
  }

  container.append(viewer)
  try {
    const sdk = await abortable(playing(viewer), deadline)
    const { context, object } = await abortable(readContext(sdk), deadline)
    sceneObject = object
    const meshes = () => scanMeshes(context.scene)
    await settled(meshes, deadline)
    return { sdk, three: context.three, scene: context.scene, camera: context.camera, renderer: context.renderer, meshes, dispose }
  } catch (error) {
    dispose()
    throw timeout.aborted ? new Error('The scan did not finish loading. Pick it again or try another space.') : error
  }
}

async function readSdkKey(signal: AbortSignal) {
  const response = await fetch('/api/scene/config', { signal })
  if (response.status === 503) throw new Error('The Showcase key is not set. Add MP_SDK_KEY to .env.')
  if (!response.ok) throw new Error(`The scene config request failed with status ${response.status}.`)
  const { sdkKey } = (await response.json()) as { sdkKey: string }
  return sdkKey
}

function playing(viewer: MatterportViewer) {
  return new Promise<MpSdk>((resolve, reject) => {
    viewer.addEventListener('mpViewerError', (event) => reject(event.detail.error), { once: true })
    viewer.playingPromise.then(resolve)
  })
}

// The SDK hands its three.js objects only to a scene component, so register one that reports
// its context from `onInit`.
async function readContext(sdk: MpSdk) {
  const name = 'propstar.context'
  const context = new Promise<Scene.IComponentContext>((resolve) => {
    void sdk.Scene.register(name, () => ({
      onInit() {
        resolve(this.context)
      },
    }))
  })
  const [object] = await sdk.Scene.createObjects(1)
  object.addNode().addComponent(name)
  object.start()
  return { context: await context, object }
}

// Every scan mesh has a BVH, which tells it apart from the viewer's own helpers.
function scanMeshes(scene: THREE.Scene) {
  const meshes: THREE.Mesh[] = []
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.isMesh && 'boundsTree' in mesh.geometry && mesh.geometry.boundsTree) meshes.push(mesh)
  })
  return meshes
}

function settled(meshes: () => THREE.Mesh[], signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let last = -1
    const timer = setInterval(() => {
      const count = meshes().length
      if (count > 0 && count === last) stop(resolve)
      last = count
    }, SETTLE_MS)
    const stop = (end: () => void) => {
      clearInterval(timer)
      signal.removeEventListener('abort', onAbort)
      end()
    }
    const onAbort = () => stop(() => reject(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function triangleCount(meshes: THREE.Mesh[]) {
  return meshes.reduce((sum, { geometry }) => sum + (geometry.index ?? geometry.getAttribute('position')).count / 3, 0)
}
