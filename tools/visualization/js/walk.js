// Walk-through viewer: the real panorama photos and the textured MatterPak mesh ("3D render"),
// seen through one shared camera so the two can be compared from exactly the same pose.
//
// Each frame draws up to three layers in order: photo sphere, mesh, floor markers. "Panorama" and
// "3D render" are just different layer choices, so switching between them cannot move the camera.
import * as THREE from 'three';
import {
  PANO_VS, PANO_GLSL, PanoTextureCache, createPanoUniforms, createWorld, dataToThree, threeToData,
  listMeshes, loadIndex, loadManifest, loadMeshEntry, setPanoPose, setPanoTextures, triangleCount,
} from './scan.js';

const V3 = THREE.Vector3;
const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const FAST = 3;                 // Shift multiplies the walk speed by this
const MAX_PITCH = 1.55;         // rad, just short of straight up / down
const RENDER_MODES = ['textured', 'normals', 'wire'];
const RENDER_NAMES = { textured: 'textured', normals: 'untextured (normals)', wire: 'wireframe' };
const COMPARE_MODES = ['off', 'blend', 'wipe'];

// ---------------------------------------------------------------- renderer, camera, scenes
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x101014, 1);
renderer.autoClear = false;                       // the frame is composed from several render() calls
const canvas = renderer.domElement;
document.body.prepend(canvas);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.02, 500);
camera.rotation.order = 'YXZ';                    // yaw about the vertical first, then pitch

const skyScene = new THREE.Scene();               // the panorama photo, on a sphere around the camera
const meshScene = new THREE.Scene();              // the scanned mesh
const markerScene = new THREE.Scene();            // floor rings at the panorama positions
const world = createWorld();                      // scan frame (Z up) inside three.js (Y up)
const markerWorld = createWorld();
meshScene.add(world);
markerScene.add(markerWorld);

const panoUniforms = createPanoUniforms();
const sky = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), new THREE.ShaderMaterial({
  uniforms: { ...panoUniforms, uOpacity: { value: 1 } }, vertexShader: PANO_VS,
  fragmentShader: PANO_GLSL + 'void main() { gl_FragColor = vec4(panoColor(vWorld), 1.0); }',
  side: THREE.BackSide, depthWrite: false, depthTest: false,
}));
sky.frustumCulled = false;
skyScene.add(sky);

// ---------------------------------------------------------------- state
const state = {
  view: 'render',        // 'render' (3D mesh) | 'pano' (photo). 'pano' implies at === true.
  compare: 'off',        // 'off' | 'blend' | 'wipe': photo and render together, only while at a panorama
  mix: 0.5,              // 0 = all photo, 1 = all render (blend amount, or the wipe line position)
  peek: false,           // Space held: temporarily show the other view
  pano: 0,               // selected panorama: the one the photo view shows
  at: true,              // the camera stands exactly on the selected panorama's position
  yaw: 0, pitch: 0,      // camera angles (rad, three.js frame)
  renderMode: 'textured', cull: false, texels: false, markers: true, speed: 1.5,
  edit: 0,               // which photo version: 0 = original, k = editSets[k - 1]
};
let manifest = null, dataRoot = '';
let centres = [];        // panorama positions in three.js world coordinates
let floorZ = [];         // floor height (scan frame, m) under each panorama
let skyReady = -1;       // panorama whose pose and textures the photo shader currently holds
let skyEdit = 0;         // ...and which photo version of it (see state.edit)
let skyId = null;        // texture-cache id of what the shader holds, so it is never evicted
// Edited copies of some panorama faces, from data/<model>/edits/index.json (optional):
// [{ name, label, panos: { <location id>: { <face index>: <path relative to edits/> } } }]
let editSets = [];
let meshRoot = null, meshes = [], texturedMats = [], triangles = 0;
let fps = 0;
const panoCache = new PanoTextureCache(3);

const applyLook = () => camera.rotation.set(state.pitch, state.yaw, 0);
// Heading in the scan frame: degrees counter-clockwise from +X, seen from above.
const headingDeg = () => (((state.yaw / DEG + 90) % 360) + 360) % 360;

function nearestPano(pos = camera.position) {
  let index = 0, dist = Infinity;
  centres.forEach((c, i) => { const d = c.distanceTo(pos); if (d < dist) { dist = d; index = i; } });
  return { index, dist };
}

// What the frame shows right now, derived from the state.
function display() {
  const photoOk = state.at && skyReady === state.pano;
  if (state.peek && state.at) {
    const wantPhoto = state.view !== 'pano';
    return { kind: wantPhoto && photoOk ? 'photo' : 'render', peek: true, waiting: wantPhoto && !photoOk };
  }
  if (state.compare !== 'off' && photoOk && meshRoot) return { kind: state.compare };
  if (state.view === 'pano') return photoOk ? { kind: 'photo' } : { kind: 'render', waiting: true };
  return { kind: 'render' };
}

// ---------------------------------------------------------------- panorama photo
// The location to load for panorama i in photo version `edit`: the manifest entry itself, or a copy
// whose edited faces point into edits/ (with its own cache id, so both versions can stay loaded).
function photoSource(i, edit) {
  const loc = manifest.locations[i];
  const set = editSets[edit - 1];
  const swaps = set?.panos?.[loc.id];
  if (!swaps) return loc;
  return { ...loc, id: `${loc.id}@${set.name}`, faces: loc.faces.map((f, k) => (swaps[k] ? `edits/${swaps[k]}` : f)) };
}
const editedHere = (i = state.pano, edit = state.edit) => !!editSets[edit - 1]?.panos?.[manifest.locations[i].id];

async function loadPhoto(i) {
  const edit = state.edit;
  if (skyReady === i && skyEdit === edit) return;
  const src = photoSource(i, edit);
  try {
    const textures = await panoCache.get(src, dataRoot, skyId ? [skyId] : []);
    if (state.pano !== i || state.edit !== edit) return;   // the user moved on meanwhile
    setPanoTextures(panoUniforms, textures);
    sky.position.copy(setPanoPose(panoUniforms, manifest.locations[i], world));
    skyReady = i; skyEdit = edit; skyId = src.id;
  } catch (err) { console.error(err); toast(err.message); }
}

// Cycle the photo between the original and each edit set.
function setEdit(k) {
  const n = editSets.length + 1;
  state.edit = ((Math.round(k) % n) + n) % n;
  if (!editSets.length) { toast('No edited panoramas for this scan.'); return; }
  loadPhoto(state.pano);
  const set = editSets[state.edit - 1];
  toast(!set ? 'Photo: original' : `Photo: ${set.label ?? set.name}${editedHere() ? '' : ' (this panorama is unchanged)'}`);
  refreshUi();
}

// ---------------------------------------------------------------- moving between views and presets
function goTo(i, { view = 'pano' } = {}) {
  const n = manifest.locations.length;
  state.pano = ((Math.round(i) % n) + n) % n;
  state.at = true;
  state.view = view;
  camera.position.copy(centres[state.pano]);
  loadPhoto(state.pano);
  refreshUi();
}

function setView(v) {
  if (v === 'pano' && !state.at) {                // walked away: the photo only exists at panorama positions
    const { index, dist } = nearestPano();
    goTo(index);
    toast(`Snapped to the nearest panorama: ${index + 1} (${dist.toFixed(2)} m away)`);
    return;
  }
  state.view = v;
  if (v === 'pano') loadPhoto(state.pano);
  refreshUi();
}

function toggleView() {
  if (state.compare !== 'off' && state.at) state.compare = 'off';   // leave compare, show one view
  setView(state.view === 'pano' ? 'render' : 'pano');
}

function setCompare(mode) {
  state.compare = COMPARE_MODES.includes(mode) ? mode : 'off';
  if (state.compare !== 'off' && state.at) loadPhoto(state.pano);
  refreshUi();
}
function setMix(v) {
  state.mix = clamp(v, 0, 1);
  $('mix').value = state.mix;
  $('wipe').style.left = `${(1 - state.mix) * 100}%`;
}
function setPeek(on) {
  if (on && !state.at) toast('Peek needs a panorama position: F snaps to the nearest one');
  if (on && state.at) loadPhoto(state.pano);
  state.peek = on;
}
function resetHeight() {
  camera.position.y = centres[nearestPano().index].y;
}

// ---------------------------------------------------------------- mesh materials
// Unlit on purpose: the textures already contain the scan's lighting. Always "transparent" so the
// blend slider can fade them without recompiling shaders; at opacity 1 that draws the same pixels.
const normalMat = new THREE.MeshNormalMaterial({ flatShading: true, transparent: true, forceSinglePass: true });
const wireMat = new THREE.MeshBasicMaterial({ color: 0x8fd3ff, wireframe: true, transparent: true, forceSinglePass: true });
// Depth-only pass drawn before a faded mesh, so only the nearest surface blends with the photo.
const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const allMats = () => [...texturedMats, normalMat, wireMat];
let opacity = 1;
function setOpacity(a) {
  if (a === opacity) return;
  opacity = a;
  for (const m of allMats()) m.opacity = a;
}

function tuneTexture(map) {
  map.colorSpace = THREE.SRGBColorSpace;                         // JPG bytes are sRGB
  map.anisotropy = renderer.capabilities.getMaxAnisotropy();     // sharp at grazing angles (floors)
  map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = state.texels ? THREE.NearestFilter : THREE.LinearFilter;
  if (map.image) map.needsUpdate = true;
}
function applySide() {
  // Matterport meshes face the room interior. With culling on, walls seen from behind vanish
  // (a dollhouse view from outside); with it off, back faces show their texture mirrored.
  const side = state.cull ? THREE.FrontSide : THREE.DoubleSide;
  for (const m of [...allMats(), depthOnly]) { m.side = side; m.needsUpdate = true; }
}
function applyRenderMode() {
  for (const o of meshes) {
    o.material = state.renderMode === 'textured' ? o.userData.textured : state.renderMode === 'normals' ? normalMat : wireMat;
  }
}
function setRenderMode(mode) { state.renderMode = RENDER_MODES.includes(mode) ? mode : 'textured'; applyRenderMode(); refreshUi(); }
function setCull(on) { state.cull = !!on; applySide(); refreshUi(); }
function setTexels(on) { state.texels = !!on; texturedMats.forEach((m) => tuneTexture(m.map)); refreshUi(); }
function setMarkers(on) { state.markers = !!on; refreshUi(); }

function textureSummary() {
  if (!meshRoot) return 'mesh not loaded yet';
  const sizes = new Map();
  let pending = 0;
  for (const m of texturedMats) {
    const img = m.map.image;
    if (!img?.width) { pending++; continue; }
    const key = `${img.width}×${img.height}`;
    sizes.set(key, (sizes.get(key) || 0) + 1);
  }
  const list = [...sizes].map(([size, n]) => `${n} × ${size}`).join(', ');
  return `${texturedMats.length} texture maps` + (list ? `: ${list}` : '') + (pending ? ` (${pending} loading)` : '');
}

async function loadMesh() {
  const entry = manifest.mesh ?? manifest.meshes?.[0];
  if (!entry) { toast('This model has no mesh on disk: photo view only'); return; }
  const label = $('loading');
  label.hidden = false;
  label.textContent = 'Loading the 3D mesh…';
  const root = await loadMeshEntry(entry, dataRoot, (e) => {
    if (!e.total) return;
    label.textContent = e.loaded < e.total
      ? `Loading the 3D mesh… ${Math.round((100 * e.loaded) / e.total)}% of ${(e.total / 1e6).toFixed(0)} MB`
      : 'Building the 3D mesh…';
  });
  meshes = listMeshes(root);
  const made = new Map();                           // loader material -> our unlit material
  const convert = (m) => {
    if (!m?.map) return normalMat;                  // a mesh without textures still shows its shape
    if (!made.has(m.uuid)) {
      tuneTexture(m.map);
      made.set(m.uuid, new THREE.MeshBasicMaterial({ map: m.map, transparent: true, forceSinglePass: true }));
    }
    return made.get(m.uuid);
  };
  for (const o of meshes) {
    const source = o.material;
    o.userData.textured = Array.isArray(source) ? source.map(convert) : convert(source);
    for (const m of [].concat(source)) m.dispose();
  }
  texturedMats = [...made.values()];
  triangles = triangleCount(meshes);
  opacity = 1;
  applySide();
  applyRenderMode();
  world.add(root);
  world.updateMatrixWorld(true);
  meshRoot = root;
  findFloors();
  label.hidden = true;
}

// ---------------------------------------------------------------- floor markers
const raycaster = new THREE.Raycaster();
const markers = [];                                 // one THREE.Group per panorama, in the scan frame
const ringGeo = new THREE.RingGeometry(0.11, 0.16, 40);
const discGeo = new THREE.CircleGeometry(0.11, 40);
const lift = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 };
const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd400, side: THREE.DoubleSide, ...lift });
const discMat = new THREE.MeshBasicMaterial({ color: 0xffd400, side: THREE.DoubleSide, transparent: true, opacity: 0.25, depthWrite: false, ...lift });

function numberTexture(n) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(16, 16, 20, 0.85)';
  g.beginPath(); g.arc(32, 32, 29, 0, 2 * Math.PI); g.fill();
  g.strokeStyle = '#ffd400'; g.lineWidth = 3; g.stroke();
  g.fillStyle = '#fff'; g.font = '600 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(n), 32, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function buildMarkers() {
  manifest.locations.forEach((loc, i) => {
    const group = new THREE.Group();
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: numberTexture(i + 1), depthWrite: false }));
    label.scale.set(0.2, 0.2, 1);
    label.position.z = 0.26;                        // the group is in the scan frame: z is up
    group.add(new THREE.Mesh(discGeo, discMat), new THREE.Mesh(ringGeo, ringMat), label);
    markerWorld.add(group);
    markers.push(group);
  });
  placeMarkers();
}
function placeMarkers() {
  markers.forEach((group, i) => {
    const [x, y] = manifest.locations[i].position;
    group.position.set(x, y, floorZ[i] + 0.03);
  });
  markerWorld.updateMatrixWorld(true);
}
// Drop a ray from each panorama position to find the floor under it.
function findFloors() {
  const down = new V3(0, -1, 0);
  raycaster.near = 0.3; raycaster.far = 3;
  const drops = centres.map((c) => { raycaster.set(c, down); return raycaster.intersectObject(meshRoot, true)[0]?.distance ?? null; });
  const found = drops.filter((d) => d !== null).sort((a, b) => a - b);
  if (!found.length) return;
  const median = found[found.length >> 1];
  floorZ = manifest.locations.map((loc, i) => loc.position[2] - (drops[i] !== null && Math.abs(drops[i] - median) < 0.3 ? drops[i] : median));
  placeMarkers();
}

// The marker under a screen point, judged in screen space so far-away rings stay clickable.
const size2 = new THREE.Vector2(), tmp = new V3(), ndc = new V3();
function markerAt(px, py) {
  if (!state.markers || !manifest) return -1;
  renderer.getSize(size2);
  const pxPerMeterAt1m = size2.y / (2 * Math.tan((camera.fov * DEG) / 2));
  let best = -1, bestDist = Infinity;
  markers.forEach((group, i) => {
    if (!group.visible) return;
    group.getWorldPosition(tmp);
    const dist = tmp.distanceTo(camera.position);
    ndc.copy(tmp).project(camera);
    if (ndc.z < -1 || ndc.z > 1) return;            // behind the camera
    const sx = (ndc.x * 0.5 + 0.5) * size2.x, sy = (-ndc.y * 0.5 + 0.5) * size2.y;
    const radius = Math.max(16, (0.2 * pxPerMeterAt1m) / dist);
    if (Math.hypot(sx - px, sy - py) <= radius && dist < bestDist) { best = i; bestDist = dist; }
  });
  return best;
}
function markerHidden(i) {                          // is the mesh between the camera and the marker?
  if (!meshRoot) return false;
  markers[i].getWorldPosition(tmp);
  tmp.y += 0.03;
  const dir = tmp.sub(camera.position);
  const dist = dir.length();
  raycaster.set(camera.position, dir.normalize());
  raycaster.near = 0.02; raycaster.far = dist - 0.1;
  return raycaster.far > raycaster.near && raycaster.intersectObject(meshRoot, true).length > 0;
}

// ---------------------------------------------------------------- UI
let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function buildPresets() {
  const rooms = new Map();                          // Matterport room id -> panorama indices
  manifest.locations.forEach((loc, i) => {
    const key = loc.room ?? '';
    if (!rooms.has(key)) rooms.set(key, []);
    rooms.get(key).push(i);
  });
  let letter = 65;
  for (const list of rooms.values()) {
    const row = document.createElement('div');
    row.className = 'room';
    const name = document.createElement('span');
    name.textContent = rooms.size > 1 ? `Room ${String.fromCharCode(letter++)}` : '';
    row.append(name);
    for (const i of list) {
      const loc = manifest.locations[i];
      const b = document.createElement('button');
      b.textContent = String(i + 1);
      b.dataset.index = String(i);
      b.title = `Panorama ${i + 1} (Matterport label ${loc.label ?? '-'}) at x ${loc.position[0].toFixed(2)}, y ${loc.position[1].toFixed(2)} m`;
      b.addEventListener('click', () => goTo(i));
      row.append(b);
    }
    $('presets').append(row);
  }
}

function refreshUi() {
  if (!manifest) return;
  const n = state.pano + 1;
  $('toggle').innerHTML = state.view === 'pano'
    ? `Showing <b>panorama photo ${n}</b> · <kbd>F</kbd> for the 3D render`
    : 'Showing <b>3D render</b> · <kbd>F</kbd> for the photo';
  $('compare').value = state.compare;
  $('compareNote').textContent = state.compare === 'off' ? 'Hold Space to peek at the other view.'
    : !state.at ? 'Paused: comparing needs a panorama position. F snaps to the nearest one.'
    : state.compare === 'wipe' ? 'Left of the line: photo. Right: 3D render. Drag the line.'
    : 'Slider: photo on the left, 3D render on the right.';
  $('renderMode').value = state.renderMode;
  $('cull').checked = state.cull;
  $('texels').checked = state.texels;
  $('markers').checked = state.markers;
  $('speed').value = state.speed;
  $('speedOut').textContent = `${state.speed.toFixed(2)} m/s`;
  for (const b of $('presets').querySelectorAll('button')) b.classList.toggle('on', state.at && +b.dataset.index === state.pano);
  markers.forEach((group, i) => { group.visible = !(state.at && i === state.pano); });   // not the one underfoot
}

function updateHud() {
  if (!manifest) return;
  const [x, y, z] = threeToData(world, camera.position);
  const near = nearestPano();
  const d = display();
  const f = (v) => v.toFixed(2).padStart(6);
  const version = !skyEdit ? '' : editedHere(skyReady, skyEdit) ? ` · edit: ${editSets[skyEdit - 1].label ?? editSets[skyEdit - 1].name}` : ' · edit set has no change here';
  $('hudMode').textContent = (d.kind === 'photo' ? `Panorama photo ${state.pano + 1}${version}`
    : d.kind === 'render' ? `3D render · ${RENDER_NAMES[state.renderMode]}`
    : d.kind === 'blend' ? `Compare · blend, ${Math.round(state.mix * 100)}% render`
    : 'Compare · split wipe') + (d.peek ? ' (peek)' : '') + (d.waiting ? ' (photo loading…)' : '');
  $('hudBody').textContent = [
    `pos   x${f(x)}  y${f(y)}  z${f(z)} m`,
    `eye   ${(z - floorZ[near.index]).toFixed(2)} m above the floor · fov ${camera.fov.toFixed(0)}°`,
    `look  heading ${headingDeg().toFixed(0)}° · pitch ${(state.pitch / DEG).toFixed(0)}°`,
    `pano  nearest is ${near.index + 1}, ${near.dist.toFixed(2)} m away${state.at ? ' (standing on it)' : ''}`,
    `${fps.toFixed(0)} fps · ${triangles.toLocaleString('en-US')} triangles`,
    textureSummary(),
  ].join('\n');
}

// The URL hash holds the pose, so a reload (or a link sent to a teammate) opens the same view.
function hashString() {
  const parts = state.at
    ? [`n=${state.pano + 1}`, `v=${state.view}`]
    : [`p=${threeToData(world, camera.position).map((v) => v.toFixed(3)).join(',')}`];
  parts.push(`h=${headingDeg().toFixed(1)}`, `t=${(state.pitch / DEG).toFixed(1)}`, `f=${camera.fov.toFixed(0)}`);
  return '#' + parts.join('&');
}
function restorePose() {
  const h = new URLSearchParams(location.hash.slice(1));
  const num = (k) => (h.get(k) !== null && h.get(k) !== '' && Number.isFinite(+h.get(k)) ? +h.get(k) : null);
  const p = h.get('p')?.split(',').map(Number);
  if (p?.length === 3 && p.every(Number.isFinite)) {
    camera.position.copy(dataToThree(world, p));
    state.at = false; state.view = 'render'; state.pano = nearestPano().index;
    loadPhoto(state.pano);
  } else {
    // Default start: the 3D render, standing on panorama 1.
    goTo((num('n') ?? 1) - 1, { view: h.get('v') === 'pano' ? 'pano' : 'render' });
  }
  if (num('h') !== null) state.yaw = (num('h') - 90) * DEG;
  else {                                            // face the middle of the scanned area
    const mid = centres.reduce((s, c) => s.add(c), new V3()).multiplyScalar(1 / centres.length);
    state.yaw = Math.atan2(camera.position.x - mid.x, camera.position.z - mid.z);
  }
  if (num('t') !== null) state.pitch = clamp(num('t') * DEG, -MAX_PITCH, MAX_PITCH);
  if (num('f') !== null) camera.fov = clamp(num('f'), 20, 110);
  camera.updateProjectionMatrix();
  applyLook();
}

// Controls give up keyboard focus after use, so the walking keys keep working.
const blurAfter = (el, type) => el.addEventListener(type, () => el.blur());
$('toggle').addEventListener('click', toggleView);
$('compare').addEventListener('change', () => setCompare($('compare').value));
$('mix').addEventListener('input', () => setMix(+$('mix').value));
$('renderMode').addEventListener('change', () => setRenderMode($('renderMode').value));
$('cull').addEventListener('change', () => setCull($('cull').checked));
$('texels').addEventListener('change', () => setTexels($('texels').checked));
$('markers').addEventListener('change', () => setMarkers($('markers').checked));
$('speed').addEventListener('input', () => { state.speed = +$('speed').value; refreshUi(); });
$('lock').addEventListener('click', toggleMouseLook);
$('resetHeight').addEventListener('click', resetHeight);
$('model').addEventListener('change', () => { location.href = `${location.pathname}?model=${encodeURIComponent($('model').value)}`; });
for (const el of document.querySelectorAll('#panel select, #panel input')) blurAfter(el, 'change');
$('panel').addEventListener('click', (e) => e.target.closest('button')?.blur());

const wipe = $('wipe');
let wipeShown = false, wipeDrag = false;
wipe.addEventListener('pointerdown', (e) => { wipeDrag = true; wipe.setPointerCapture(e.pointerId); });
wipe.addEventListener('pointermove', (e) => { if (wipeDrag) setMix(1 - e.clientX / innerWidth); });
wipe.addEventListener('pointerup', () => { wipeDrag = false; });
wipe.addEventListener('pointercancel', () => { wipeDrag = false; });

// ---------------------------------------------------------------- mouse
const drag = { on: false, moved: 0, x: 0, y: 0 };
const locked = () => document.pointerLockElement === canvas;
const lookRate = () => (0.0045 * camera.fov) / 75;  // rad per pixel, slower when zoomed in
function turn(dYaw, dPitch) {
  state.yaw += dYaw;
  state.pitch = clamp(state.pitch + dPitch, -MAX_PITCH, MAX_PITCH);
  applyLook();
}
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag.on = true; drag.moved = 0; drag.x = e.clientX; drag.y = e.clientY;
  if (!locked()) canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (locked()) { turn(-e.movementX * lookRate(), -e.movementY * lookRate()); return; }   // mouse look
  if (!drag.on) { canvas.style.cursor = markerAt(e.clientX, e.clientY) >= 0 ? 'pointer' : ''; return; }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
  turn(dx * lookRate(), dy * lookRate());           // drag: the scene follows the pointer
});
const endDrag = (e) => {
  if (!drag.on) return;
  drag.on = false;
  if (e.type !== 'pointerup' || drag.moved >= 5) return;
  const [px, py] = locked() ? [innerWidth / 2, innerHeight / 2] : [e.clientX, e.clientY];
  const i = markerAt(px, py);
  if (i >= 0 && !markerHidden(i)) goTo(i);
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  camera.fov = clamp(camera.fov + e.deltaY * 0.04, 20, 110);
  camera.updateProjectionMatrix();
}, { passive: true });

function toggleMouseLook() {
  if (locked()) { document.exitPointerLock(); return; }
  try { Promise.resolve(canvas.requestPointerLock()).catch(() => toast('The browser blocked mouse look')); }
  catch { toast('The browser blocked mouse look'); }
}
document.addEventListener('pointerlockchange', () => {
  $('crosshair').hidden = !locked();
  $('lock').textContent = locked() ? 'Leave mouse look (Esc)' : 'Mouse look';
});

// ---------------------------------------------------------------- keyboard
const HELD = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const keys = new Set();                             // held movement keys, by physical key code
const inFormControl = (e) => e.target instanceof Element && e.target.closest('input, select, textarea, button') !== null;
// The physical key (so WASD works on any layout). Some input sources (remote desktops, automation)
// send no code: fall back to the typed character.
function keyCode(e) {
  if (e.code) return e.code;
  const k = e.key ?? '';
  if (/^[a-z]$/i.test(k)) return 'Key' + k.toUpperCase();
  if (/^[1-9]$/.test(k)) return 'Digit' + k;
  return { ']': 'BracketRight', '[': 'BracketLeft', ' ': 'Space', Shift: 'ShiftLeft' }[k] ?? k;
}

addEventListener('keydown', (e) => {
  if (!manifest || e.ctrlKey || e.metaKey || e.altKey || inFormControl(e)) return;
  const c = keyCode(e);
  if (HELD.has(c)) { keys.add(c); e.preventDefault(); return; }
  if (c === 'Space') { e.preventDefault(); if (!e.repeat) setPeek(true); return; }
  if (e.repeat) return;
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(c);
  if (digit) { if (+digit[1] <= manifest.locations.length) goTo(+digit[1] - 1); return; }
  switch (c) {
    case 'KeyF': toggleView(); break;
    case 'BracketRight': goTo(state.pano + 1); break;
    case 'BracketLeft': goTo(state.pano - 1); break;
    case 'KeyC': setCompare(COMPARE_MODES[(COMPARE_MODES.indexOf(state.compare) + 1) % COMPARE_MODES.length]); break;
    case 'KeyM': setRenderMode(RENDER_MODES[(RENDER_MODES.indexOf(state.renderMode) + 1) % RENDER_MODES.length]); break;
    case 'KeyB': setCull(!state.cull); break;
    case 'KeyT': setTexels(!state.texels); break;
    case 'KeyP': setMarkers(!state.markers); break;
    case 'KeyR': resetHeight(); break;
    case 'KeyL': toggleMouseLook(); break;
    case 'KeyH': document.body.classList.toggle('bare'); break;
    case 'KeyX': {            // next version that changes this panorama, then back to the original
      let k = state.edit + 1;
      while (k <= editSets.length && !editedHere(state.pano, k)) k++;
      if (k > editSets.length && !state.edit && editSets.length) toast('No edit set changes this panorama.');
      else setEdit(k);
      break;
    }
    default: return;
  }
  e.preventDefault();
});
addEventListener('keyup', (e) => {
  const c = keyCode(e);
  keys.delete(c);
  if (c === 'Space') setPeek(false);
});
addEventListener('blur', () => { keys.clear(); state.peek = false; });

// Called once per frame with the elapsed time, so speed is in meters per second at any frame rate.
function update(dt) {
  const axis = (plus, minus) => (keys.has(plus) ? 1 : 0) - (keys.has(minus) ? 1 : 0);
  const yawKeys = axis('ArrowLeft', 'ArrowRight'), pitchKeys = axis('ArrowUp', 'ArrowDown');
  if (yawKeys || pitchKeys) turn(yawKeys * 1.4 * dt * (camera.fov / 75), pitchKeys * 1.0 * dt * (camera.fov / 75));

  const fwd = axis('KeyW', 'KeyS'), right = axis('KeyD', 'KeyA'), up = axis('KeyE', 'KeyQ');
  if (!fwd && !right && !up) return;
  const step = state.speed * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? FAST : 1) * dt;
  const len = Math.hypot(fwd, right) || 1;          // so a diagonal is not faster
  const sin = Math.sin(state.yaw), cos = Math.cos(state.yaw);
  // Horizontal heading only: looking up or down does not change the eye height.
  camera.position.x += ((-sin * fwd + cos * right) / len) * step;
  camera.position.z += ((-cos * fwd - sin * right) / len) * step;
  camera.position.y += up * step;
  if (state.at || state.view === 'pano') {          // walking leaves the photo: it exists at one point only
    state.at = false;
    state.view = 'render';
    refreshUi();
  }
}

// ---------------------------------------------------------------- drawing
function drawLayers(photo, renderAlpha) {
  if (photo) renderer.render(skyScene, camera);
  if (meshRoot) {
    if (renderAlpha < 1) {                          // depth only: hides markers behind walls, readies a clean fade
      meshScene.overrideMaterial = depthOnly;
      renderer.render(meshScene, camera);
      meshScene.overrideMaterial = null;
    }
    if (renderAlpha > 0) { setOpacity(renderAlpha); renderer.render(meshScene, camera); }
  }
  if (state.markers) renderer.render(markerScene, camera);
}
function draw() {
  const d = display();
  renderer.setScissorTest(false);
  renderer.clear();
  if (d.kind === 'photo') drawLayers(true, 0);
  else if (d.kind === 'blend') drawLayers(true, state.mix);
  else if (d.kind === 'wipe') {
    renderer.getSize(size2);
    const x = Math.round((1 - state.mix) * size2.x);
    renderer.setScissorTest(true);
    if (x > 0) { renderer.setScissor(0, 0, x, size2.y); drawLayers(true, 0); }
    if (x < size2.x) { renderer.setScissor(x, 0, size2.x - x, size2.y); drawLayers(false, 1); }
    renderer.setScissorTest(false);
  } else drawLayers(false, 1);
  if (wipeShown !== (d.kind === 'wipe')) { wipeShown = d.kind === 'wipe'; wipe.hidden = !wipeShown; }
}

let last = performance.now(), frames = 0, since = 0, warmed = -1, lastHash = '';
function frame() {
  const now = performance.now();
  tick((now - last) / 1000);
  last = now;
}
function tick(elapsed) {
  if (manifest) update(Math.min(elapsed, 0.1));     // a stalled tab must not teleport the camera
  draw();
  frames++; since += elapsed;
  if (since < 0.5) return;
  fps = frames / since; frames = 0; since = 0;      // twice a second: HUD, URL, and photo preloading
  housekeeping();
}
function housekeeping() {
  if (!manifest) return;
  updateHud();
  const hash = hashString();
  if (hash !== lastHash && !drag.on && !keys.size) {  // not mid-gesture: wait until the pose settles
    lastHash = hash;
    history.replaceState(null, '', hash);
  }
  const near = nearestPano().index;
  if (!state.at && near !== warmed) {               // have the nearest photo ready before it is asked for
    warmed = near;
    panoCache.get(photoSource(near, state.edit), dataRoot, skyId ? [skyId] : []).catch(() => {});
  }
}
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- boot
async function boot() {
  const index = await loadIndex();
  const modelId = new URLSearchParams(location.search).get('model') || index.models[0]?.id;
  for (const m of index.models) $('model').add(new Option(`${m.name ?? m.id} (${m.panos} panos)`, m.id));
  if (!modelId) { $('status').textContent = 'No scan on disk yet. Run: py tools/fetch_matterport.py fetch <model_id>'; return; }
  $('model').value = modelId;
  const loaded = await loadManifest(modelId);
  dataRoot = loaded.dataRoot;
  if (!loaded.manifest.locations.length) { $('status').textContent = `${modelId}: the manifest has no panoramas.`; return; }
  centres = loaded.manifest.locations.map((loc) => dataToThree(world, loc.position));
  floorZ = loaded.manifest.locations.map((loc) => loc.position[2] - 1.3);   // a guess; measured once the mesh is in
  manifest = loaded.manifest;
  try {                                             // optional: edited copies of some faces (X cycles them)
    const res = await fetch(dataRoot + 'edits/index.json');
    if (res.ok) editSets = (await res.json()).sets ?? [];
  } catch { editSets = []; }
  $('status').textContent = `${manifest.name ?? modelId} (${manifest.model_id ?? modelId}) · ${manifest.locations.length} panoramas, ${manifest.resolution ?? '?'} faces`;
  buildPresets();
  buildMarkers();
  setMix(state.mix);
  restorePose();
  refreshUi();
  updateHud();
  await loadMesh();
  refreshUi();
}
renderer.setAnimationLoop(frame);
boot().catch((err) => {
  console.error(err);
  $('loading').hidden = true;
  $('status').textContent = 'Error: ' + err.message;
});

// Console helpers, e.g. walk.goTo(2); walk.look(180, -10); walk.pose()
window.walk = {
  state, camera, goTo, setView, toggleView, setCompare, setMix, setRenderMode, setCull, setTexels, setMarkers, setPeek, resetHeight,
  setEdit, edits: () => editSets.map((s, k) => ({ edit: k + 1, name: s.name, label: s.label, panos: Object.keys(s.panos ?? {}).length })),
  look(heading, pitchDeg = 0) { state.yaw = (heading - 90) * DEG; state.pitch = clamp(pitchDeg * DEG, -MAX_PITCH, MAX_PITCH); applyLook(); },
  moveTo(p) { camera.position.copy(dataToThree(world, p)); state.at = false; state.view = 'render'; refreshUi(); },
  panels(on) { document.body.classList.toggle('bare', !on); },
  pose() {
    return {
      view: state.view, showing: display().kind, pano: state.pano + 1, at: state.at,
      pos: manifest ? threeToData(world, camera.position).map((v) => +v.toFixed(4)) : null,
      heading: +headingDeg().toFixed(2), pitch: +(state.pitch / DEG).toFixed(2), fov: camera.fov,
    };
  },
  info() { return { ready: !!meshRoot, fps: +fps.toFixed(1), triangles, textures: textureSummary(), photo: skyReady + 1, floorZ: floorZ.map((v) => +v.toFixed(3)) }; },
  markerAt, markerHidden,
  markerScreen(i) {                                 // where panorama i's floor ring is on screen, in CSS pixels
    renderer.getSize(size2);
    ndc.copy(markers[i].getWorldPosition(tmp)).project(camera);
    return ndc.z < -1 || ndc.z > 1 ? null : [Math.round((ndc.x * 0.5 + 0.5) * size2.x), Math.round((-ndc.y * 0.5 + 0.5) * size2.y)];
  },
  // Advance n frames of dt seconds each without waiting for the browser (for tests and hidden tabs).
  step(dt = 1 / 60, n = 1) { for (let i = 0; i < n; i++) tick(dt); housekeeping(); return this.pose(); },
  // Milliseconds per frame with the GPU forced to finish: a rough render cost, not an on-screen fps.
  frameCost(n = 60) {
    const gl = renderer.getContext();
    draw(); gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) draw();
    gl.finish();
    return +((performance.now() - t0) / n).toFixed(2);
  },
  get manifest() { return manifest; },
};
