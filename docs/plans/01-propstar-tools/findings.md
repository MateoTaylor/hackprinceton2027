# Findings behind the plan

Back to the [overview](overview.md).

Six read-only explorations on 2026-11-14 measured what the data and the libraries can do. This
file records what they found. Treat each item as a measurement on the named sample, not as a
guarantee for every property. Where an item says "unverified" or "unexplained", the phase that
depends on it must check it.

## The data on this laptop

- `data/propstar/propstar.duckdb` holds 50 curated properties, all in Los Angeles. Tables
  `properties` and `scans`. `properties` has `stories`, `building_sf` and `year_built` as raw
  numbers. It has no per-floor data and no slab height.
- The worked example is `commercial-248243`, an office tower with a podium. Its CoStar record
  has a storey count, a rentable area, a year built and
  `propertyOffice.structural.slabToSlabHeightFeet`. `floors[]` has a `floorName` code (24 is
  First, counting up, and 1 is Unknown) and a `floorSize`.
- CoStar records carry real broker and contact names. Read geometry fields only.
- This repo is public. This file and the phase files give field names, counts and ratios. They
  do not give a property's address or the values in its record. Read those from the database on
  the laptop.
- The server has no Matterport client. `tools/fetch_matterport.py` has a working GraphQL helper,
  and `tools/smoke/smoke.ts` has working TypeScript for all three sources.

## Vexcel: building shell and neighbours

- `property/extract` with `wkt=POINT(lon lat)`, `srid=4326`, `include=calculated` and
  `latest=true` returns one feature per capture, unsorted. Use the newest capture whose height is
  over 3 m.
- Of the calculated attributes on 248243, only `roof-characteristics.elevation` and
  `roof-characteristics.height` were filled.
- The extract gives the tower's footprint, its edge bearings, its height and its ground
  elevation. The `primary-structure` flag separates the tower from its low podium.
- The Vexcel height is about a quarter more than CoStar's storey count times its slab-to-slab
  height. The gap is unexplained. A roof plant level and a tall lobby are likely causes.
- Neighbours come from the same endpoint with `buffer-meter=150` and
  `include=precomputed,calculated`. That returned 34 structures.
- Vexcel offers no surface model, mesh or point cloud on this key. Heights come from attributes.
- Each oblique photo's XMP holds the full camera model. `app/server/src/obliquePose.ts` reads it.
- Attribute groups seen: `pool.*`, `roof-characteristics.*`, `roof-objects.*`, `roof-defects.*`,
  `building-type.*`, `vehicles.*` and `parcel-tree-cover.percent`. There is no roof age field.
  Captures run from 2021-01-20 to 2026-07-03.
- `elements/detect` answered 200 with zero detections on the sample.

## Matterport: floor plans from the API

The model query that returns a floor plan:

```
model(id) {
  floors { id label sequence
    vertices { id position { x y } }
    edges { id type thickness centerLineBias vertices { id }
      openings { id type width height lowerElevation relativeCenter label } } }
  rooms { id label floor { id } holes { edges { id } } boundary { edges { id } }
    classifications { label confidence }
    dimensions { areaFloor height width depth units }
    ceiling { minHeight maxHeight } }
}
```

- A room's `boundary` edges close into a ring. `holes` edges are walls inside the room.
- Opening `type` is `doorway` or `opening`. Both are passable. A `doorway` on an edge that only
  one room uses is an exterior door.
- Opening sizes are in metres. Room `dimensions` are imperial, so compute sizes from the ring.
- `lowerElevation` looks like world Z. `relativeCenter` places the opening along its edge.
- The floor-plan frame equals the mesh frame. This was checked on the warehouse scan only.
- The API gives a door's width and height. It says nothing about the leaf or its swing.
- Scans hold no furniture data. `classifications` gives a room label with a confidence.
- There are no stair or lift types. Rooms labelled `Staircase` stack in xy across floors, which
  is how to find a stair. Floors have a `sequence` but no elevation.
- Of 36 scans sampled, 2 span more than one floor.
- One scan of the worked example (model `aYTUWzQVbUs`) covers a whole floor. Its outline matches
  the Vexcel tower footprint to within a metre, which fixes its position up to a 180° flip.
- Matterport's geolocation cannot place a suite inside a building. That a suite numbered 1000
  is on the tenth storey is unverified.
- Samples used: `aYTUWzQVbUs` (office floor), `JEaAkySdA5X` (warehouse), `zzvymDx5ty7` (1BR),
  `kxoWjp46deg`.

## Matterport: the Showcase viewer

- The team's Matterport API token answers `not.found` for the two public demo spaces. The team's
  Showcase SDK key opens both in the browser.
- `@matterport/webcomponent` 0.1.47 bundles three r184. Its Scene context exposes `three`, `scene`,
  `camera` and `renderer`. Objects added to the viewer's scene must be built with that `three`.
- Plant `L3sdz2m7jxp`: 27 `RoomMesh` objects, 1,030,018 triangles, 2 floors. The meshes have
  `geometry.boundsTree`. Raycast with `THREE.Mesh.prototype.raycast`. A Rapier trimesh collider of
  the whole plant builds in 919 ms, so build it once at startup.
- Office `18TRzZNyxvU`: 35 meshes, 4 floors, 764 sweeps.
- Kit scans that have a MatterPak on the account, as fallbacks: `35LT5s1GSfA`, `DyxhMkHBivo`,
  `vR3V3LVTBFj`, `2WMhwuqjJkb`, `e69f8VbdT5e`, `kc7dw4iFVdB`. Nobody has tried a kit scan in the
  web component yet.
- Kit scan `2rPahZzW6H7` shows a building from outside, with 11 panoramas, by Mateo's log. The
  Signage tool hangs its sign there. Nobody has opened it in the web component, and nobody has
  checked that its mesh holds the outside wall and the ground in front of it.
- Matterport's viewer has its own measurement mode, a white line with a length label. The
  Signage tool copies that look with its own lines. Whether the SDK can switch the built-in mode
  on from code was not checked, and the plan does not depend on it.
- A second search on 2026-11-15 found licensed vehicle models. The Models table below lists them.
  Only the wheelchair is CC0 with a direct download. The forklift and the scissor lift are
  CC BY 4.0 on Sketchfab, which needs a login to download and a credit in the repo. No CC0
  scissor lift exists on Poly Pizza, Poly Haven, Quaternius, Kenney or OpenGameArt.
- Vehicles without a model are built from boxes and cylinders. No vehicle carries a maker's
  branding.

### Models

Fahim approved all three rows and the CC BY licence on 2026-11-15. [b4](phase-b4-vehicles.md)
uses the primitive shape until a file is in `app/web/public/models/`.

| Class | Model, author | Licence | Triangles | Download | Page |
| --- | --- | --- | --- | --- | --- |
| `wheelchair` | Wheelchair 01, Garreth Dean | CC0 | 40,252 | Direct, glTF at 1k is 1.7 MB | https://polyhaven.com/a/wheelchair_01 |
| `forklift` | Forklift Truck, louis-muir | CC BY 4.0 | 9,627 | Sketchfab login, GLB at 1k is 7.3 MB | https://sketchfab.com/3d-models/forklift-truck-060f3f8bc7de4e6ca2f348d414702e9d |
| `slab_scissor`, `rough_terrain_scissor` | Scissor Lift, one80solar | CC BY 4.0 | 4,579 | Sketchfab login, GLB at 1k is 1.8 MB | https://sketchfab.com/3d-models/scissor-lift-44b32d34ea2945ddb4d98e7143aca15a |

- The wheelchair file is in metres, about 0.82 by 1.10 by 1.10. It is one mesh, so its wheels do
  not turn.
- Fahim chose the scissor lift because it extends. Both Sketchfab files were downloaded on
  2026-11-15 as GLB with 1k textures. Their download dialogs show "CC Attribution. Author must
  be credited. Commercial use is allowed."
- Neither file uses Draco or meshopt. Almost all of each file is PNG textures. The forklift has
  7 and the geometry is 0.6 MB, so a 2k download is 22 MB.
- The forklift is 3 static meshes with 3 materials. Its units are not metres.
- The scissor lift is one skinned mesh with 16 joints, one material and two textures. Its one
  clip, "Take 001", moves the 16 joints for 4 seconds. Nobody has played it yet, so b4 checks
  that it raises the platform.

## `tools/world`, the drivable prototype

- 1,404 lines. `world.ts` 429, `main.ts` 310, `drivable.ts` 142, `bench/drive.ts` 139,
  `lift-visual.ts` 94, `prop-visuals.ts` 78, `collision-mesh.ts` 72, `scan-view.ts` 64.
- Dependencies: `@dimforge/rapier3d-compat` 0.21.0, `three` 0.187.0, `three-mesh-bvh` 0.9.18.
- Collision is a Rapier trimesh built from the scan's MatterPak OBJ. The vehicle is a rigid body
  with a box collider that Rapier resolves against the trimesh. `bench:measure` and `bench:drive`
  run against `data/JEaAkySdA5X`.

## Routing

- Door clearance from the API is opening width minus payload width. A `three-mesh-bvh` box sweep
  through the doorway gives the real clear width and the share of the opening that is free.
- Confidence that a payload fits a door:
  `sigmoid((clearanceM - 0.05) / 0.03) * freeFraction`, capped at 0.8 while the leaf state is
  unknown.
- Libraries checked: `ngraph.path` 1.6.1, `pathfinding` 0.4.18, `three-pathfinding` 1.3.0,
  `recast-navigation` 0.44.0.

## Look and assets

- Kenney's Furniture Kit and Factory Kit are CC0. They lack curtains, racking, pallets and
  conference tables, so build those from primitives.
- A look that worked in a sample render: `three` 0.187.0, `OrthographicCamera` at azimuth 45° and
  elevation 35.264° (or about 30°), `HemisphereLight` plus one `DirectionalLight`, `PCFShadowMap`,
  ambient occlusion from `n8ao` 2.0.2 with `postprocessing` 6.39.6, outlines from `EdgesGeometry`,
  roughness 0.8, background `#0E0F11`, and the tokens `--surface-2`, `--border` and
  `--accent-bright` from `docs/design/design.md`.
- A cut-away reads well when walls drop to 0.3 m stubs and the storeys above are removed. At the
  camera's elevation a 0.3 m stub hides about 0.4 m of the floor behind it.
- For generated floors: `clipper2-ts` 2.0.1-19 offsets polygons, `straight-skeleton` 3.0.0 finds a
  corridor spine and `d3-hierarchy` splits an area into rooms.
- Inferred space read as different in a sample render when it was hatched clay with dashed
  outlines. Fahim then set another look on 2026-11-14. Scanned rooms take a flat colour, and
  everything without a scan takes a sharp grey 1 m grid. That look has no sample render yet.
  [l1](phase-l1-look-page.md) and [l4](phase-l4-inferred-style.md) check it by screenshot.

## Area

- Overture release `2026-10-21.0`, themes `transportation/segment` and `places/place`, read with
  DuckDB's `spatial` and `httpfs` extensions. A 2 km box took 58.1 s for segments and 11.3 s for
  places.
- Segments have `class`. Places have `basic_category` and `taxonomy`. Drop the `footway` and
  `service` classes when you look for the fronting street.
- For distance, `ST_Transform` to EPSG:32611 with `always_xy` and then `ST_Distance`.
- 800 m in a straight line stands in for a ten-minute walk.
- OpenFreeMap serves a free street basemap for MapLibre.
- A check blocked a downloaded `pmtiles` binary from running. Do not plan on it.

## Signage, Los Angeles (LAMC 14.4), not used

Fahim cut the sign rules on 2026-11-15. The Signage tool hangs a placeholder sign and measures
it. No phase reads this section or the next one. The notes stay for a later plan.

- Wall sign area: 2 sq ft per foot of street frontage plus 1 sq ft per foot of building frontage.
  Each storey above the first adds 10%, up to 50%. A wall sign may not rise above the top of the
  wall, may project 24 in at most and may not sit within 5 ft of an interior lot line.
- Projecting sign: needs 50 ft of frontage, one per 200 ft, bottom at least 8 ft above the
  sidewalk, 7.5 ft from interior lot lines, projection 8 ft at most.
- Pole sign: 25, 35 or 42 ft tall by frontage, 10 ft from interior lot lines.
- Monument sign: 8 ft tall at most, 1.5 sq ft per foot of frontage, 75 sq ft at most.
- All signs together: 4 sq ft per foot of street frontage.
- Light: 3 foot-candles at a residential property line.
- A sign district, specific plan or design overlay prevails over these base rules, so every
  result must say "subject to overlays". Chapter 1A (Div. 4C.11) applies Downtown only, and its
  tables did not extract cleanly.
- Zone lookup: `https://data.lacity.org/resource/jjxn-vhan.json`, field `zone_cmplt`. Suffixes
  such as SN or CDO, which mark overlays, were not checked.
- The code was read through a mirror because the official library refused automated requests.
  Each rule row must keep its section number so a person can check it.
- Not computable from the data: overlays, existing signs, window area, tenant count and ground
  type.
- The permit for a lift on a public sidewalk was not researched.

## Signage, Houston (Chapter 46), not used

- Wall signs: 25% of the wall area or 1,000 sq ft. Roof signs are prohibited. Projecting signs
  need 14 ft of clearance and project 10 ft at most. Ground sign limits depend on the street
  category in the Major Thoroughfare and Freeway Plan (`ST_TYPE` at gis.hctx.net). A 45 ft
  visibility triangle applies at corners.

## Lifts

From Genie specification sheets. Working height is platform height plus 6 ft. Recheck every
number against the maker's sheet when you write the catalogue.

| Class | Model | Platform height | Outreach | Width | Weight |
| --- | --- | --- | --- | --- | --- |
| Slab scissor | GS-1930 | 19 ft 3 in | none | 2 ft 6 in | 3,209 lb |
| Slab scissor | GS-3232 | 32 ft | none | 2 ft 8 in | 5,185 lb |
| Rough-terrain scissor | GS-2669 RT | 26 ft 2 in | none | 5 ft 9 in | not recorded |
| Rough-terrain scissor | GS-3369 RT | 32 ft 8 in | none | 5 ft 9 in | not recorded |
| Rough-terrain scissor | GS-4069 RT | 40 ft 3 in | none | 5 ft 9 in | not recorded |
| Articulating boom | Z-45 XC | 45 ft 6 in | 24 ft 9 in | 7 ft 6 in | 16,360 lb |
| Articulating boom | Z-80/60 | 78 ft | 60 ft | not recorded | not recorded |
| Telescopic boom | S-65 XC | 65 ft | 54 ft 2 in | not recorded | not recorded |
| Telescopic boom | SX-180 | 180 ft | 80 ft | not recorded | not recorded |

Pick the smallest class that fits. A slab scissor needs firm paving. A rough-terrain scissor
works on unpaved ground. An articulating boom reaches over an obstacle. A telescopic boom gives
the longest outreach.

## Edit API on Mateo's PC

These facts come from `tools/edit_api/README.md` and `tools/edit_api/proxy.ts` on `origin/main`.
Nothing here was called from this laptop, and Mateo's log says the link from this laptop is
unverified. Read the README in full before you build on it.

- A FastAPI server on port 2026 on Mateo's PC. The laptop reaches it over the campus VPN with a
  bearer token. `forwardEdit` in `proxy.ts` adds the token and passes only the request headers
  `content-type`, `accept` and `last-event-id`.
- `GET /health` needs no token. `GET /places` lists the downloaded scans. `GET
  /places/{model_id}` answers for any scan and never calls Matterport. A scan that is not on the
  PC answers `downloaded: false` with no panoramas.
- `POST /edits` takes `{place: {model_id}, start: {pano_id, yaw, pitch, fov}, command, preset?}`.
  `pitch` is -89 to 89. `fov` is 30 to 120 and defaults to 70. `command` is 3 to 300 characters.
  `preset` is `720`, `fast`, `draft` or `quality`. The answer is 202 with `{job_id, kind, status,
  queue_position}`.
- `place.property_id` answers 501 on that PC, because the CoStar kit is not there. Send
  `model_id`.
- A job moves through `queued`, `fetching` and `running`, and ends `done`, `failed` or
  `cancelled`. The PC runs one edit at a time. A job takes about 5 s when it finds nothing and
  about 9 min at worst. `busy` (503) means 8 jobs already wait.
- `GET /edits/{job_id}` gives the status, the steps and the result or error. `GET
  /edits/{job_id}/events` is the same job as server-sent events named `status`, `step`, `done`
  and `failed`. `DELETE /edits/{job_id}` cancels a job that is still queued.
- Pictures are cube faces of 2048 px. Face 0 is up, 1 is +X, 2 is -Y, 3 is -X, 4 is +Y and 5 is
  down. The world frame is right-handed with Z up, and `yaw = atan2(forward.y, forward.x)`.
- `POST /places/{model_id}/fetch` downloads a scan to the PC ahead of time. No op in this plan
  calls it. The README's examples name the scans `zzvymDx5ty7` and `2rPahZzW6H7`. Which scans are
  on the PC is unverified.

## The MVP's seams

- `app/server/src/app.ts` builds the Hono app in `createApp({properties, vexcel})`. It refuses
  requests whose host is not `127.0.0.1` or `localhost` and refuses cross-site requests.
- `app/server/src/vexcel.ts` has an internal `attempt` and a cached `json(key, request, schema)`.
  `parcelBounds` already calls `property/extract`.
- `app/server/src/main.ts` hard-codes `HOST`, `PORT = 8787` and `DATA`.
- `app/server` tests run with `node --test src/*.test.ts`, a flat glob that misses subfolders.
- `app/shared` has no `package.json`, so it can hold types and no runtime code. The web already
  uses `import type` from `../../agent/src/contract.ts`.
- `app/web` has React 19.3.1, maplibre-gl 6.18.0 and Vite 8.3.8, and no three.js. Vite runs on
  `localhost:5173` with `strictPort`, proxies `/api` to `127.0.0.1:8787` and may read only its own
  package.
- `app/web/src/App.tsx` has `View = browse | selected | flythrough`. `QuickView` has the
  fly-through button.
- `app/agent/src/proppy.ts` sends a property's aerial image to a hosted model and tells the model
  it cannot read Matterport panoramas yet.
