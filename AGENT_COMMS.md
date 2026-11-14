# Agent communication

Shared channel for the coding agents (and their humans) working in this repo. Keep entries short
and factual; this file is read at the start of every work session.

## Protocol

1. **Before you start:** `git pull`, then read `AGENTS.md` (direction, stack, working rules), then
   Agents, Shared contracts, Open requests and the newest few Log entries here.
2. **Stay in your lane:** edit only the paths you own. If you need something changed elsewhere, add
   an Open request addressed to the owner.
3. **Shared paths and contracts:** anyone may change them, but add a Log entry first saying what
   changes and who is affected.
4. **Log as you work:** after each meaningful step (new interface, finished feature, blocker, finding
   others should know), add an entry at the top of the Log, signed with your agent name.
5. **Commits:** prefix messages with your agent name, e.g. `[Mateo-Agent] add mask voting`. Pull
   with rebase before pushing. On a merge conflict in this file, keep both sides' entries.
6. **Secrets:** never put keys, tokens or passwords in this file or in code. They live in `.env`.
7. Times are Eastern (America/New_York).

## Agents

| Agent | Human | Task | Owns |
| --- | --- | --- | --- |
| Mateo-Agent | Mateo | **Now:** tests of editing a scan with local models (remove or change one item across its panoramas) in `tools/qwen_test/`; the visualization tools. **Runs on the PC that hosts the local models** (see Compute). **On hold:** the magic eraser module in `eraser/` | `tools/visualization/`, `tools/qwen_test/`, `eraser/` (on hold) |
| Fahim-Agent | Fahim | CoStar + Matterport + Vexcel joins; smoke test and Showcase SDK viewer | `tools/smoke/` |

**Compute:** Mateo-Agent works on Mateo's PC (Windows 11, RTX 5070 Ti with 16 GB), the only machine
that hosts the local models: SAM 2.1, Qwen3-VL-8B and Qwen-Image-2.1. Other agents have no access to
it. If you need one of these models run, add an Open request for Mateo-Agent. The weights, the runner
binaries and everything the models produce are git-ignored and exist only on that PC.

Shared (announce changes in the Log): `tools/` outside the per-tool subfolders (including
`tools/fetch_matterport.py`), `README.md`, `.gitignore`, `.env.example`. New tools get their own
subfolder under `tools/`, owned by whoever builds them.

## Shared contracts

- **`data/<model_id>/manifest.json`**, written by `tools/fetch_matterport.py`. Paths inside it are
  relative to `data/<model_id>/`.
  - `model_id`, `name`, `resolution`, `fetched_at`
  - `conventions`: world frame, quaternion meaning, cube-face layout (measured, see below)
  - `mesh` (preferred) and `meshes` (all found): `{type: "obj" | "gltf", path, mtl, bytes}`
  - `locations[]`: `{id, location_id, label, floor, room, position: [x, y, z] (m), rotation: [x, y, z, w], faces: [6 paths]}`
- **`data/index.json`**: downloaded models, `{models: [{id, name, panos}]}`.
- **Frame:** right-handed, Z up, meters; the same frame as the MatterPak OBJ and `cloud.xyz`.
- **Panorama faces:** 0 = up, 1 = +X, 2 = −Y, 3 = −X, 4 = +Y, 5 = down (pano-local frame). The
  quaternion rotates pano-local directions into world as given.

## Open requests

_None yet._ Format: `- [ ] (from → to) request · date`, ticked when done.

## Log (newest first)

### 2026-11-14 10:20 ET · Mateo-Agent · Viewer landed; new `tools/qwen_test/`; this PC hosts the local models

**Compute (affects both agents)**
- Mateo-Agent runs on Mateo's PC, the machine that hosts the local models (RTX 5070 Ti, 16 GB).
  SAM 2.1 large, Qwen3-VL-8B (a chat model behind a llama.cpp server on `127.0.0.1:8081`) and
  Qwen-Image-2.1 (stable-diffusion.cpp) run there one at a time, because they do not fit in 16 GB
  together.
- Other agents have no access to that machine. Work that needs these models goes through an Open
  request to Mateo-Agent. This is now in the Agents section above.

**Landed (shared paths)**
- `tools/visualization/`, as announced at 01:06: walk-through viewer, alignment viewer and the
  localhost-only server. `viewer/` and `tools/serve.py` are gone. Run
  `py tools/visualization/serve.py`.
- New `tools/qwen_test/`, owned by Mateo-Agent and added to the Agents table in this commit. It was
  built before `AGENTS.md` asked for paths to be claimed first. Python with its own virtual
  environments; setup is in its README.
- `README.md` layout table: rows for both folders. Fahim's changes from 10:00 are kept as they were.

**What works (model `zzvymDx5ty7`; numbers are in `tools/qwen_test/README.md`)**
- A typed request ("remove the couch") and the view the user is looking at become an edit over
  several panoramas. SAM segments the view, Qwen3-VL answers with a box and one shared instruction,
  the mesh lifts the item to 3D voxels and finds it in the other panoramas without the VLM, and
  Qwen-Image edits each view in 45-60 s.
- Results are pasted into copies of the cube faces and written to `data/<model_id>/edits/` (local
  only, not a shared contract yet). The walk-through viewer steps through them with `X`.

**Findings others may need**
- An image-edit model reuses every picture it is given. A second photo of the same room that already
  showed the finished edit made the model return that photo instead of editing the current one.
  Naming the pictures the way the model's prompt template does (`image1`, `image2`) fixed it.
- The 8B VLM could not choose among numbered segments. Asking it for a bounding box and letting SAM
  outline the object inside the box works.
- The scan mesh has holes where the scanner could not see. Rays through a removed sofa reach a
  surface for only 39% of its area, so the wall and floor behind it have to be completed as planes.

**Where this stands against `AGENTS.md`**
- `AGENTS.md` lists the magic eraser as on hold. This work is exploration that Mateo is directing in
  `tools/qwen_test/`. Nothing is in `eraser/`, and Defurnish and the Matterport API are not used.
  Whether it joins the product is for Mateo and Fahim to settle, so `AGENTS.md` is unchanged.
- On Fahim's stack question at 10:00, facts only: `tools/visualization/` is three.js 0.170 from a CDN
  with no build step and its own Python server, so it does not depend on the app stack. The local
  models are Python and native binaries, not TypeScript. Mateo has not answered the question yet.

**Next (per Mateo):** an iterative loop managed with LangChain. The VLM builds first images, inspects
the outputs, decides what to fix (shadow removal and matching come next) and calls SAM, generation
and image labelling as tools or subagents. Design not started.

**Needs from others:** nothing.

### 2026-11-14 10:00 ET · Fahim-Agent · New root `AGENTS.md`: product direction, stack and working rules

**Changed (shared paths)**
- New `AGENTS.md` at the repo root. Every agent reads it before working. It holds the decisions;
  this file stays the log, the ownership table and the shared contracts.
- Protocol step 1 above now points to `AGENTS.md`.
- `README.md`: Direction now describes the new product and keeps the magic eraser text under "On
  hold". Its heading drops "(working, subject to change)". The layout table gains `AGENTS.md` and
  `tools/smoke/` and marks `eraser/` as on hold. Agents are sent to `AGENTS.md` first. Setup
  mentions Node 24 and `pnpm`. The scan and viewer sections are untouched.

**Decided with Fahim (details and reasons are in `AGENTS.md`)**
- Product: an aerial map of the kit's properties, an agent that scores and colours them with
  evidence, and a WASD fly-through outside and inside the scans with placeable 3D objects.
- Stack: local-only on `localhost`. Vite + React, MapLibre GL, three.js, Hono, DuckDB, and a
  `deepagents` (JS) agent on a local LangGraph server. Nothing is built yet.
- LangSmith tracing stays off until a CoStar mentor approves it, because traces upload CoStar records.

**Who is affected:** both agents. The three.js choice matches `tools/visualization/`. The Shared
contracts do not change.

**Coming (shared path, announced here first):** Fahim will add the model-provider key name to
`.env.example` later. The app's folder is not claimed yet.

**Needs from others:** Mateo, say here if any part of the stack conflicts with the visualization work.

### 2026-11-14 09:27 ET · Fahim-Agent · Added `tools/smoke/`: all three data sources checked on one building

- `tools/smoke/smoke.ts` (TypeScript, Node 24+) joins CoStar → Matterport → Vexcel for one property and writes `data/smoke/<propertyId>/`. Verified on property 23296.
- `tools/smoke/showcase.ts` serves a Showcase SDK viewer. The SDK key only works on `localhost`.
- The data notes (join keys, CoStar kit traps, Vexcel quirks) are in `tools/smoke/README.md`.
- Local layout: the CoStar kit is in `kit/costar-hackathon-kit/` and the Vexcel guide is in `kit/vexcel/`. Both are git-ignored.
- Filled in the Fahim-Agent row of the Agents table above. No other shared paths were changed. The scripts read the existing `MP_*` / `VEXCEL_API_KEY` names in `.env`.

**Needs from others:** nothing.

### 2026-11-14 01:06 ET · Mateo-Agent · Task change: visualization first; `viewer/` and `tools/serve.py` are moving

**Changing (shared paths; announced here before the code lands)**
- `viewer/index.html` → `tools/visualization/alignment.html` (the convention-check viewer, unchanged
  in behaviour). The `viewer/` folder goes away.
- `tools/serve.py` → `tools/visualization/serve.py`, with the same guarantees: localhost only,
  refuses dotfiles, serves only the visualization pages and `data/`.
- New `tools/visualization/index.html`: walk-through viewer. WASD through the textured mesh, every
  panorama position is a preset, and one key toggles photo and 3D render at the same camera pose.
- From now on each tool lives in its own subfolder under `tools/` (Mateo's request), so two people
  can work without touching each other's files. `tools/fetch_matterport.py` stays where it is.

**Who is affected:** anyone running `py tools/serve.py` or opening `/viewer/`. After the move, run
`py tools/visualization/serve.py`. The manifest, index and conventions in Shared contracts do not
change.

**On hold (per Mateo):** the magic eraser and anything using Defurnish, until planned. Nothing has
been started in `eraser/`. No further Matterport API calls from Mateo-Agent for now; work uses the
already downloaded `zzvymDx5ty7`.

**Next (Mateo-Agent):** land the walk-through viewer, then report how the mesh textures compare
with the photos.

**Needs from others:** nothing.

### 2026-11-14 00:10 ET · Mateo-Agent · Repo set up; scan download and alignment viewer in place

**Done**
- Initial repo: README, this file, `.gitignore` (keeps `.env`, `.claude/`, `data/`, model weights
  out of git), `eraser/` placeholder.
- `tools/fetch_matterport.py`: lists and searches models, downloads panoramas and unlocked bundles,
  writes the manifest and index. Stdlib-only Python. Never purchases anything.
- `tools/serve.py`: localhost-only server that refuses dotfiles.
- `viewer/index.html`: three.js 0.170 from a CDN, no build step. Panorama-inside-mesh and dollhouse
  views, plus automatic convention checks.

**Findings others should know**
- The hackathon Matterport keys read about 14.9k models (2,782 match "1BR"). On `zzvymDx5ty7` the
  MatterPak and Defurnish bundles are unlocked and E57 is unavailable. Other models not yet checked.
- The conventions in Shared contracts were measured on all 9 panoramas of `zzvymDx5ty7`. Seam
  matching between cube faces fixed the face layout; correlating each panorama with the textured mesh
  fixed the pose, with no leftover yaw.
- The API's skybox `format` field says `"skybox"`, not `"jpg"`; the real file type is in the URL.
- Signed asset URLs expire about 5 minutes after the GraphQL query: download right away.
- The mesh is clean on planar surfaces and rough on soft furniture. Projecting a panorama onto the
  mesh smears onto surfaces that panorama could not see, so per-panorama visibility (depth) is needed.

**Next (Mateo-Agent):** the magic eraser in `eraser/`. Detailed requirements are coming from Mateo.

**Needs from others:** nothing yet.
