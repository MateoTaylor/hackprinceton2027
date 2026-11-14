/**
 * Loose objects in the world: what they look like, and where physics has put them.
 *
 *   const props = createPropVisuals(scene, world)
 *   props.add(crate(), ground, yaw)               // ground is a point on the floor
 *   props.add(await loadModel(url), ground, yaw)  // undefined when it does not fit there
 *   props.sync()                                  // every frame
 *
 * A model collides as the box around it. Its units are taken as meters.
 */
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3, type Object3D, type Raycaster, type Scene } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { Vec3 } from './collision-mesh.ts'
import type { Prop, World } from './world.ts'

export type PropShape = { visual: Object3D; half: Vec3 }

const CRATE_HALF = { x: 0.4, y: 0.4, z: 0.4 }
const MIN_HALF = 0.01
/** How far above the floor a prop's base sits while it is held, and when it is first set down. */
export const HOVER = 0.2
const crateGeometry = new BoxGeometry(CRATE_HALF.x * 2, CRATE_HALF.y * 2, CRATE_HALF.z * 2)
const crateMaterial = new MeshStandardMaterial({ color: 0xb98a4e, roughness: 0.85 })

export const crate = (): PropShape => ({ visual: new Mesh(crateGeometry, crateMaterial), half: CRATE_HALF })

/** Loads a self-contained `.glb` file and centers it on the box around it. */
export async function loadModel(url: string): Promise<PropShape> {
  const { scene: model } = await new GLTFLoader().loadAsync(url)
  model.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(model)
  if (bounds.isEmpty()) throw new Error('the model has no geometry')
  const size = bounds.getSize(new Vector3())
  model.position.sub(bounds.getCenter(new Vector3()))
  return {
    visual: new Group().add(model),
    half: { x: Math.max(size.x / 2, MIN_HALF), y: Math.max(size.y / 2, MIN_HALF), z: Math.max(size.z / 2, MIN_HALF) },
  }
}

export function createPropVisuals(scene: Scene, world: World) {
  const owners = new Map<Object3D, Prop>()

  return {
    /** Sets a prop down with its base centered on `ground`. Adds nothing if it does not fit there. */
    add({ visual, half }: PropShape, ground: Vec3, yaw: number) {
      const at = { x: ground.x, y: ground.y + half.y + HOVER, z: ground.z }
      if (!world.hasRoom(half, at, yaw)) return
      const prop = world.addProp(half, at, yaw)
      owners.set(visual, prop)
      scene.add(visual)
      return prop
    },

    remove(prop: Prop) {
      for (const [visual, owner] of owners) {
        if (owner !== prop) continue
        scene.remove(visual)
        owners.delete(visual)
      }
      world.removeProp(prop)
    },

    /** The prop under the ray, if there is one. */
    pick(raycaster: Raycaster) {
      let hit: Object3D | null = raycaster.intersectObjects([...owners.keys()])[0]?.object ?? null
      while (hit && !owners.has(hit)) hit = hit.parent
      return hit ? owners.get(hit) : undefined
    },

    sync() {
      for (const [visual, prop] of owners) {
        visual.position.copy(prop.body.translation())
        visual.quaternion.copy(prop.body.rotation())
      }
    },
  }
}
