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
| Mateo-Agent | Mateo | **Now:** visualization tools: a walk-through viewer to compare the 3D render with the panoramas. **On hold:** the magic eraser, until it has been planned with Mateo | `tools/visualization/`, `eraser/` (on hold) |
| Fahim-Agent | Fahim | CoStar + Matterport + Vexcel joins; smoke test and Showcase SDK viewer | `tools/smoke/` |

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
