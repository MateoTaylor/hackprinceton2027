/**
 * The scan as it looks: Matterport's textured mesh, unlit, in the simulation frame.
 *
 *   const view = loadScanView(`${base}/scan.obj`, 1024, 16)
 *   scene.add(view.group)        // geometry arrives first, in grey
 *   await view.textured          // then every texture is on
 *
 * Each OBJ material is named after the JPG that textures it, so the MTL file is not
 * read. Faces are drawn from the inside only, so a camera outside a wall sees into
 * the room.
 */
import { Group, Mesh, MeshBasicMaterial, SRGBColorSpace, Texture, type Material } from 'three'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'

async function loadTexture(url: string, width: number | null, anisotropy: number) {
  const blob = await (await fetch(url)).blob()
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'flipY',
    ...(width ? { resizeWidth: width, resizeQuality: 'high' as const } : {}),
  })
  const texture = new Texture(bitmap)
  texture.flipY = false
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = anisotropy
  texture.onUpdate = () => bitmap.close()
  texture.needsUpdate = true
  return texture
}

/** `textureWidth` is in pixels, or null to keep each texture at its full size. */
export function loadScanView(objUrl: string, textureWidth: number | null, anisotropy: number) {
  const group = new Group()
  group.rotation.x = -Math.PI / 2
  const folder = objUrl.slice(0, objUrl.lastIndexOf('/') + 1)
  const materials = new Map<string, MeshBasicMaterial>()
  const loads: Promise<void>[] = []

  const textured = (source: Material) => {
    const known = materials.get(source.name)
    if (known) return known
    const material = new MeshBasicMaterial({ color: 0x6b7078 })
    materials.set(source.name, material)
    loads.push(
      loadTexture(folder + source.name, textureWidth, anisotropy).then((map) => {
        material.map = map
        material.color.set(0xffffff)
        material.needsUpdate = true
      }),
    )
    return material
  }

  const textured_ = new OBJLoader().loadAsync(objUrl).then(async (object) => {
    object.traverse((child) => {
      if (!(child instanceof Mesh)) return
      child.material = Array.isArray(child.material) ? child.material.map(textured) : textured(child.material)
    })
    group.add(object)
    await Promise.all(loads)
    return materials.size
  })

  return { group, textured: textured_ }
}
