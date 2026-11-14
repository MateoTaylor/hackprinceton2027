// Shared by the visualization pages: where the data lives, the measured panorama conventions,
// the cube-face panorama shader, and manifest / texture / mesh loading.
//
// Frames: scan data (panorama positions, MatterPak OBJ, cloud.xyz) is right-handed, Z up, meters.
// three.js is Y up, so pages put scan content under createWorld(), a group rotated -90 deg about X:
// data (x, y, z) -> three (x, z, -y).
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const V3 = THREE.Vector3;

// <repo>/data/, resolved from this file so it works wherever the pages are served from.
export const DATA_URL = new URL('../../../data/', import.meta.url).href;

// ---------------------------------------------------------------- conventions
// Matterport doesn't document the skybox face layout or the pose convention. These were measured on
// model zzvymDx5ty7 (all 9 panoramas): seam matching fixes the face layout, and correlation against
// the MatterPak mesh fixes yaw 0 with the API quaternion used as-is (pano-local -> world).
// alignment.html can re-measure them on a new model.
export const DEFAULT_CONV = Object.freeze({ order: 'cw', yaw: 0, topRot: 180, botRot: 0, invertQ: false, meshUp: 'z' });

// Pano-local frame is Z up. Faces 1-4 are horizontal, 0 looks up, 5 looks down.
// Each face k has forward F, image-up U and image-right R = F x U (seen from inside the cube).
export function faceFrames(c = DEFAULT_CONV) {
  const Z = new V3(0, 0, 1);
  const rotZ = (v, deg) => v.clone().applyAxisAngle(Z, (deg * Math.PI) / 180);
  const f1 = rotZ(new V3(1, 0, 0), +c.yaw);
  const step = c.order === 'ccw' ? 90 : -90;
  const F = [], U = [], R = [];
  for (let k = 0; k < 4; k++) { F[k + 1] = rotZ(f1, step * k); U[k + 1] = Z.clone(); }
  F[0] = Z.clone(); U[0] = rotZ(f1, +c.topRot);
  F[5] = Z.clone().negate(); U[5] = rotZ(f1, +c.botRot);
  for (let k = 0; k < 6; k++) R[k] = new V3().crossVectors(F[k], U[k]);
  return { F, U, R };
}

// ---------------------------------------------------------------- world frame
export function createWorld() {
  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;
  world.updateMatrixWorld(true);
  return world;
}
export const dataToThree = (world, p, target = new V3()) => target.set(p[0], p[1], p[2]).applyMatrix4(world.matrixWorld);
export function threeToData(world, v) {
  const p = v.clone().applyMatrix4(new THREE.Matrix4().copy(world.matrixWorld).invert());
  return [p.x, p.y, p.z];
}

// ---------------------------------------------------------------- panorama shader
// For a surface point, take the direction from the panorama centre, rotate it into the pano-local
// frame, pick the cube face it falls on and sample that face. Works on any geometry: a big sphere
// around the camera shows the photo; the scan mesh shows the photo projected onto it.
// Face textures are sampled raw (sRGB bytes straight through), so no colour conversion is applied.
export const PANO_VS = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
export const PANO_GLSL = /* glsl */`
  uniform sampler2D uFace0, uFace1, uFace2, uFace3, uFace4, uFace5;
  uniform vec3 uF[6]; uniform vec3 uR[6]; uniform vec3 uU[6];
  uniform mat3 uToLocal;   // three.js world direction -> pano-local direction
  uniform vec3 uCenter;    // pano centre in three.js world
  uniform float uOpacity;
  varying vec3 vWorld;
  vec3 panoColor(vec3 worldPos) {
    vec3 d = uToLocal * normalize(worldPos - uCenter);
    int k = 0; float best = -2.0; vec3 r = uR[0]; vec3 u = uU[0];
    for (int i = 0; i < 6; i++) {
      float s = dot(d, uF[i]);
      if (s > best) { best = s; k = i; r = uR[i]; u = uU[i]; }
    }
    vec2 uv = vec2(0.5 + 0.5 * dot(d, r) / best, 0.5 - 0.5 * dot(d, u) / best);
    vec3 c;
    if (k == 0) c = texture2D(uFace0, uv).rgb;
    else if (k == 1) c = texture2D(uFace1, uv).rgb;
    else if (k == 2) c = texture2D(uFace2, uv).rgb;
    else if (k == 3) c = texture2D(uFace3, uv).rgb;
    else if (k == 4) c = texture2D(uFace4, uv).rgb;
    else c = texture2D(uFace5, uv).rgb;
    return c;
  }`;

// Uniforms shared by every material that shows a panorama. The face frames are filled in here
// because three.js cannot upload an empty vec3 array (the render loop may start before data loads).
export function createPanoUniforms(conv = DEFAULT_CONV) {
  const uniforms = {
    uFace0: { value: null }, uFace1: { value: null }, uFace2: { value: null },
    uFace3: { value: null }, uFace4: { value: null }, uFace5: { value: null },
    uF: { value: [] }, uR: { value: [] }, uU: { value: [] },
    uToLocal: { value: new THREE.Matrix3() }, uCenter: { value: new V3() },
  };
  setFaceFrames(uniforms, conv);
  return uniforms;
}
export function setFaceFrames(uniforms, conv = DEFAULT_CONV) {
  const { F, R, U } = faceFrames(conv);
  uniforms.uF.value = F; uniforms.uR.value = R; uniforms.uU.value = U;
}
export function setPanoTextures(uniforms, textures) {
  textures.forEach((t, k) => { uniforms['uFace' + k].value = t; });
}
// Point the uniforms at one panorama (a manifest location). Returns its centre in three.js world.
export function setPanoPose(uniforms, loc, world, conv = DEFAULT_CONV) {
  const q = loc.rotation ? new THREE.Quaternion(...loc.rotation) : new THREE.Quaternion();
  if (!conv.invertQ) q.invert();            // the API quaternion rotates pano-local -> world
  const toData = new THREE.Matrix4().makeRotationFromQuaternion(world.quaternion).invert();
  uniforms.uToLocal.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q).multiply(toData));
  return dataToThree(world, loc.position, uniforms.uCenter.value);
}

// ---------------------------------------------------------------- manifest
export async function loadIndex() {
  try {
    const res = await fetch(DATA_URL + 'index.json');
    return res.ok ? await res.json() : { models: [] };
  } catch { return { models: [] }; }
}
// -> { manifest, dataRoot }; paths in the manifest are relative to dataRoot.
export async function loadManifest(modelId) {
  const dataRoot = `${DATA_URL}${encodeURIComponent(modelId)}/`;
  const res = await fetch(dataRoot + 'manifest.json');
  if (!res.ok) throw new Error(`No manifest for model "${modelId}" (HTTP ${res.status})`);
  const manifest = await res.json();
  manifest.locations = (manifest.locations || []).filter((l) => l.faces?.every(Boolean));
  return { manifest, dataRoot };
}

// ---------------------------------------------------------------- panorama textures
const textureLoader = new THREE.TextureLoader();
function loadFace(url) {
  return new Promise((resolve, reject) => textureLoader.load(url, (t) => {
    // No mipmaps: the shader's uv jumps between faces, which would pick a blurry mip along seams.
    t.flipY = false; t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
    resolve(t);
  }, undefined, () => reject(new Error(`Could not load ${url}`))));
}
// Small least-recently-used cache: one 2k panorama is about 100 MB of GPU memory.
export class PanoTextureCache {
  constructor(max = 3) { this.max = max; this.entries = new Map(); }
  // Promise of the six face textures of a manifest location. Ids in `keep` are never evicted.
  get(loc, dataRoot, keep = []) {
    let entry = this.entries.get(loc.id);
    if (entry) this.entries.delete(loc.id);     // re-inserted below, so the newest is last
    else {
      entry = Promise.all(loc.faces.map((f) => loadFace(dataRoot + f)));
      entry.catch(() => { if (this.entries.get(loc.id) === entry) this.entries.delete(loc.id); });
    }
    this.entries.set(loc.id, entry);
    for (const [id, promise] of this.entries) {
      if (this.entries.size <= this.max) break;
      if (id === loc.id || keep.includes(id)) continue;
      this.entries.delete(id);
      promise.then((ts) => ts.forEach((t) => t.dispose()), () => {});
    }
    return entry;
  }
}

// ---------------------------------------------------------------- mesh
// Loads a manifest mesh entry ({type: 'obj' | 'gltf', path, mtl}) and returns the loader's root
// object with the loader's own materials. Pages swap in the materials they want.
export async function loadMeshEntry(entry, dataRoot, onProgress) {
  const url = dataRoot + entry.path;
  if (entry.type === 'obj') {
    const loader = new OBJLoader();
    if (entry.mtl) {
      const materials = await new MTLLoader().loadAsync(dataRoot + entry.mtl);
      materials.preload();
      loader.setMaterials(materials);
    }
    return loader.loadAsync(url, onProgress);
  }
  return (await new GLTFLoader().loadAsync(url, onProgress)).scene;
}
// Collected up front on purpose: adding children while traverse() runs makes it visit them too.
export function listMeshes(root) {
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  return meshes;
}
export function triangleCount(meshes) {
  let n = 0;
  for (const o of meshes) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
  return n;
}
