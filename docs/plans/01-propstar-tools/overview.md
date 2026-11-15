# Propstar tools: seven tools behind one agent-friendly API

This plan builds seven property tools in `app/` and exposes them through one HTTP API that a model
can call without reading any code. It plans the work. It does not build the LangChain deep agent
that will call the API. That agent gets its own plan.

The measured facts behind every decision here are in [findings.md](findings.md). Read it before
you start a phase, because the explorers' scratch files are gone.

## Context

Propstar joins three data layers for the same addresses. CoStar gives building records, Matterport
gives interior 3D scans and Vexcel gives aerial imagery and property attributes. The MVP in `app/`
shows a map, a property card, oblique photos and a Matterport iframe. The judges weigh use of the
data (30%), agentic depth (30%), usefulness (25%) and polish (15%), so each tool below must combine
at least two layers and must be callable by an agent.

The seven tools:

1. **Dollhouse.** A simplified 3D model of a building at one fixed isometric angle. A slice is
   cut away. Scanned rooms are drawn in flat colour with one model per object class. Everything
   without a scan is drawn in a sharp grey prototype grid.
2. **Routing.** The best route to a target inside the building, drawn as a dot trail. Each door
   on the route shows a green tick or a red cross, and the route continues past a red cross.
   Colour encodes confidence and hover shows the number.
3. **Area.** What a free map service would tell you about the surroundings: places, streets and
   walking distance. This tool integrates open data. It does not build a map product.
4. **Scene.** Objects placed and driven inside a Matterport scan, such as a forklift on a factory
   floor, a scissor lift outside a building and a model mounted on a facade. A scene holds at
   most 30 objects.
5. **Signage.** A blank sign hung on a building's outside wall in its Matterport scan. Measurement
   lines switch on and off, in the style of Matterport's own measurement mode, and show the
   sign's width, its height and its height above the ground. The tool also names the lift class
   that reaches the sign. Fahim cut the sign rules on 2026-11-15, so it checks no city code.
6. **Features.** Vexcel property attributes such as pool, roof condition, vehicles and tree cover.
7. **Edit.** Remove or retexture an object in a scan's panoramas from a text command, such as
   "remove the floor lamp" or "make the countertop white marble". The edit runs in Mateo's scan
   edit pipeline on his PC. This plan calls it through his edit API.

### Art direction

Fahim set the art direction on 2026-11-14, so no phase stops to ask about it.

- The dollhouse takes the general traits of isometric management games. The camera is true
  isometric. Walls are cut to low stubs with light faces and dark caps. Floors carry one flat
  colour per room use. Furniture is simple and readable.
- Space without a scan looks like a game prototype. It is flat grey with a sharp 1 m grid. Colour
  therefore means "scanned" and grey means "not scanned", and the grid gives a second cue that
  does not depend on colour.
- The look copies no asset, texture or palette from any game. Models are CC0 or built from
  primitives. [l1](phase-l1-look-page.md) has the values.

## Scope

In scope:

- An op registry in `app/server/src/ops/` with `GET /api/ops` and `POST /api/ops/:name`.
- The 16 ops listed under [Ops](#ops), each with Zod input and output schemas.
- One web panel per tool, opened from the property card.
- The Edit tool's ops and panel. They reach the edit API on Mateo's PC through `forwardEdit` from
  `tools/edit_api/proxy.ts`, mounted in the Hono server.
- The two public Matterport demo spaces (`L3sdz2m7jxp`, a manufacturing plant, and `18TRzZNyxvU`, a
  commercial office) for the Scene tool, opened in the browser with the team's Showcase SDK key.
- The kit scan `2rPahZzW6H7`, which shows a building from outside, for the Signage tool.
  [b1](phase-b1-scene-host.md) checks that the viewer opens it and names the fallback.
- Generated layouts for storeys that have no scan, marked `inferred` everywhere they appear.

Out of scope:

- The deep agent, its subagents and its skills. The API is shaped for it, and
  [Agent adapter](#agent-adapter-later-plan) says how it will connect.
- Sign rules, zoning and permits, for any city. The Signage tool measures a placeholder sign.
- The scan edit pipeline. It stays in `tools/edit_agent/` on Mateo's PC. This plan calls it
  through `tools/edit_api/` and edits neither folder.
- Drive-time routing on streets. Walking distance is a straight-line estimate.
- Anything that spends money, including `unlockModelBundle`.

## Constraints

- **Local only.** Every server binds to `127.0.0.1` or `localhost`. Licensed data stays in `data/`
  and `kit/`, which are git-ignored.
- **Keys.** Keys live in `.env`. No op result, log line, test fixture or screenshot may hold one.
  The Showcase SDK key reaches the browser through `GET /api/scene/config`, which is not an op, so
  it never enters a model's context. `EDIT_API_URL` and `EDIT_API_TOKEN` stay on the server. The
  proxy adds the token, so the browser never holds it. Nobody prints either value.
- **Showcase pages leak the key.** The viewer puts `MP_SDK_KEY` in the DOM, the iframe URL, the
  console and the network log. Verify Scene phases with screenshots only. Never save page HTML, DOM
  snapshots, console logs or network logs from a page that hosts the viewer.
- **CoStar records carry real broker and contact names.** Ops read named geometry columns only.
  No op returns a raw record.
- **Images stay on the laptop** unless the user decides otherwise in
  [Open choices](#open-choices). No phase here sends an image or a record to a hosted model.
- **The edit API gets ids and a command, never a record.** A request to Mateo's PC carries a scan
  id, a panorama id, a view direction and the user's command. It carries no CoStar field. Edited
  scan pictures come back to this laptop over the campus VPN and go nowhere else, which is the
  decision that `AGENTS.md` on `origin/main` records. The pictures are licensed. They stay out of
  git, out of op results and out of any upload.
- **Demo-space geometry stays in the browser.** The two demo spaces are not in the team's
  Matterport account, so their meshes exist only inside the viewer. No phase writes them to disk.
- **Fixtures are invented.** Test fixtures and the three look-check buildings hold made-up
  geometry. They never copy a CoStar record or scan-derived coordinates, so they are safe to commit.
- **Op output stays out of git.** Op results derive from licensed data. Decision logs, Log entries
  and commit messages record status codes, counts and sizes. They never hold a pasted result.
- **One third-party request from the browser.** The street basemap in
  [c3](phase-c3-basemap.md) loads tiles from OpenFreeMap. Each request carries tile coordinates and
  nothing else. The map must show OpenFreeMap and OpenStreetMap attribution. Every other request
  from the browser goes to `localhost`.
- **Stack.** TypeScript on Node 24, `pnpm`, Hono, Vite and React, MapLibre, three.js, DuckDB on the
  `1.4` line. Scripts must run on Windows and macOS.
- **One tree, three lanes.** Lanes work in the same checkout on different folders and ports.
  [ownership.tsv](ownership.tsv) is the authority on who edits what.

## Ops

Every op has a name that matches `^[a-z][a-z0-9_]{2,40}$`, a one-line summary, an input schema, an
output schema and an effect of `read` or `write`.

| Op | Effect | What it answers |
| --- | --- | --- |
| `property_get` | read | The curated `Property` for an id |
| `building_get` | read | The `BuildingModel` of a property: shell, storeys, spaces, doors, furnishings |
| `route_solve` | read | The best route to a target for a payload, with a verdict per door |
| `area_places` | read | Places near a property by category, with distance |
| `area_summary` | read | Counts by category, the nearest of each key category and the fronting street |
| `features_get` | read | Vexcel attributes of the property |
| `equipment_list` | read | The lifts and vehicles that can be placed, with dimensions |
| `lift_choose` | read | The smallest lift class that reaches a height and outreach |
| `signage_measure` | read | The size of a placed sign, its height above the ground and the lift that reaches it |
| `scene_get` | read | The objects placed in a scan |
| `scene_place` | write | Place an object in a scan at a pose or an anchor |
| `scene_move` | write | Move or rotate a placed object |
| `scene_remove` | write | Remove a placed object |
| `edit_places` | read | The scans of a property that the edit API can edit, with their panoramas |
| `edit_start` | write | Start a remove or retexture edit from a panorama, a view and a command |
| `edit_get` | read | The status of an edit and, when it ends, its verdict and changed panoramas |

`features_detect` joins the list only if [phase c5](phase-c5-detect.md) finds that Vexcel's
`elements/detect` returns detections.

The rules that make the API easy for a model to use:

- **One envelope.** Success is `{ok: true, result}`. Failure is `{ok: false, error: {code,
  message, hint}}`. The error codes are a closed list and every `hint` says what to try next.
- **Small results.** `result` is a summary a model can read in one glance. Geometry and long lists
  go in `detail`, which the server returns only for `?detail=full`. A test caps the size of every
  `result`.
- **Units in names.** `widthM`, `heightFt`, `distanceM`, `yawDeg`. No bare numbers.
- **Provenance on every derived value.** `source` is one of `costar`, `vexcel`, `scan`, `mesh`,
  `overture`, `maker` or `inferred`. Inferred values carry `confidence` from 0 to 1.
- **Stated assumptions.** Each result lists the assumptions the op made, in plain sentences.
- **Stable ids.** Property ids are the `Property.id` strings the map already uses.
- **Same input, same output.** Generators take a seed derived from the input. Results are cached
  on disk by input hash.
- **Ops compose through `ctx.call`.** An op that needs another op's answer calls it by name
  through `OpContext.call`. It never imports another lane's folder. `route_solve` calls
  `building_get` this way, and `signage_measure` calls `lift_choose`.

## Alternatives

- **REST routes per tool.** Rejected. Six URL shapes and six error styles force the agent adapter
  to hand-write a tool per route. One registry gives one manifest.
- **An MCP server.** Rejected for now. The agent runs in LangGraph on the same laptop, and a
  manifest of JSON Schemas is enough to generate its tools. The registry can feed an MCP server
  later without changing an op.
- **Navmesh routing with `recast-navigation`.** Rejected. A 0.25 m grid over a 50 by 30 m floor is
  24,000 cells, which A* solves in milliseconds, and a grid makes door cells easy to tag. Recast
  adds a WASM build step.
- **Rendering the real Matterport mesh in the dollhouse.** Rejected. The request is a simplified
  model that reads at a glance, and the mesh is rough on soft furniture.
- **Street routing with OSRM.** Rejected. It needs a prepared road graph per region, and the demo
  question is "what is within a ten-minute walk", which a radius answers.
- **Worktrees per lane.** Rejected. Lanes own disjoint folders, so they do not collide in one
  tree, and one tree keeps one `node_modules` and one `data/`.
- **The browser calls the edit API directly.** Rejected. The browser would hold the token and
  fetch every picture by hand. The Hono proxy keeps the token on the server, and pictures and the
  event stream work as plain URLs.
- **The Edit panel inside the Matterport viewer.** Rejected. The viewer reports its pose in its
  own frame, and the conversion to the edit API's frame would have to be measured. The panel
  draws the cube faces itself, so it computes yaw and pitch in the API's frame directly.

## Applicable skills

- **architect** before [f1](phase-f1-op-contract.md) and [f3](phase-f3-building-model.md). Both
  define types that every lane consumes.
- **interrogate** once, on the `Op` contract and `BuildingModel` together, before any lane starts.
- **how** before a phase edits `app/server/src/vexcel.ts` or `app/web/src/MapView.tsx`.
- **frontend-design** and `docs/design/design.md` for every panel and for the look phases.
- **verify** for phases that end in pixels. **run** for phases that end in an op call.
- **show-me-your-work** for every lane. Each lane writes its own decision log, so no two agents
  append to one file. The logs are `decisions-lane-a.tsv`, `decisions-lane-b.tsv` and
  `decisions-lane-c.tsv` in this folder.
- `/deslop` and `/no-comments` before each commit. **unslop** and **technical-writing** for Log
  entries and commit messages.
- The LangChain skills (`langchain-skills:deep-agents-core`) apply to the later agent plan, not
  to this one.

## Phases

Foundation runs first, in order, by one agent. The three lanes then run in parallel.

**Foundation**

1. [f1 Op contract](phase-f1-op-contract.md)
2. [f2 Ops over HTTP](phase-f2-ops-http.md)
3. [f3 Building model](phase-f3-building-model.md)
4. [f4 Equipment catalogue](phase-f4-equipment.md)
5. [f5 Upstream clients](phase-f5-upstream-clients.md)
6. [f6 Server scaffolds](phase-f6-server-scaffolds.md)
7. [f7 Web scaffolds](phase-f7-web-scaffolds.md)

**Lane A, dollhouse and routing.** The look track follows the art direction above and stops for
Fahim once, at the screenshots of [l5](phase-l5-dollhouse-panel.md). The data track runs beside
it, because the look track draws invented fixtures until l5.

- Data: [a1 Shell](phase-a1-shell.md), [a2 Storeys](phase-a2-storeys.md),
  [a3 Scan plan](phase-a3-scan-plan.md), [a4 Scan placement](phase-a4-scan-placement.md),
  [a5 Gap fill](phase-a5-gap-fill.md), [a6 Furnishings](phase-a6-furnishings.md),
  [a7 `building_get`](phase-a7-building-op.md)
- Look: [l1 Look page](phase-l1-look-page.md), [l2 Cut-away](phase-l2-cutaway.md),
  [l3 Furniture kit](phase-l3-furniture-kit.md), [l4 Inferred style](phase-l4-inferred-style.md),
  [l5 Dollhouse panel](phase-l5-dollhouse-panel.md)
- Routing: [r1 Storey grid](phase-r1-storey-grid.md), [r2 Door fit](phase-r2-door-fit.md),
  [r3 `route_solve`](phase-r3-route-solve.md), [r4 Route overlay](phase-r4-route-overlay.md),
  [r5 Mesh clearance](phase-r5-mesh-clearance.md) (optional)

**Lane B, scene and signage**

- [b1 Scene host](phase-b1-scene-host.md), [b2 Scene document](phase-b2-scene-document.md),
  [b3 Collider and drive](phase-b3-collider-drive.md), [b4 Vehicles](phase-b4-vehicles.md),
  [b5 Surface anchors](phase-b5-surface-anchors.md)
- Signage, which runs inside the Scene viewer and needs no other lane:
  [b6 Sign size and ground](phase-b6-sign-size.md), [b7 Lift choice](phase-b7-lift-choice.md),
  [b8 `signage_measure`](phase-b8-signage-measure.md), [b9 Signage panel](phase-b9-signage-panel.md)

**Lane C, area, features and edit**

- [c1 Area extract](phase-c1-area-extract.md), [c2 Area ops](phase-c2-area-ops.md),
  [c3 Basemap and places](phase-c3-basemap.md), [c4 `features_get`](phase-c4-features-ops.md),
  [c5 Detect probe](phase-c5-detect.md) (optional)
- Edit: [e1 Edit link](phase-e1-edit-link.md), [e2 Edit ops](phase-e2-edit-ops.md),
  [e3 Edit panel](phase-e3-edit-panel.md). They need the steps under
  [Before kickoff](#before-kickoff). With the link down, the lane still builds the client, the
  ops and the panel against a fake.

What to cut first if time runs short, in this order: r5, c5, l4's legend, b9's Place lift button,
a6 for scanned rooms. The demo still works without each of them.

## Verification

[testing.md](testing.md) has the commands and the end-to-end demo script. In short:

- Every phase ends with `pnpm typecheck` and `pnpm test` in each package it touched.
- Every op phase ends with a real call against property `commercial-248243`, made with
  `node docs/plans/01-propstar-tools/probe-op.mjs <op> propertyId=commercial-248243`. The script
  prints the status, the size of `result` and an outline of keys and counts. Record those printed
  lines in the lane's decision log. Do not call the op with `curl` and do not paste a result.
- Every panel phase ends with a screenshot at 1440 by 900, checked against `docs/design/design.md`.
- `node docs/plans/01-propstar-tools/check-ownership.mjs --staged --lane <owner>` runs before
  every commit. It fails when a staged file belongs to a different owner.

## Implementation guidance

- **Ports.** Each lane runs its own servers so nobody restarts a server someone else is using.
  Pass the ports inline. Do not put them in `.env`.

  | Lane | API port (`PROPSTAR_PORT`) | Web port (`PROPSTAR_WEB_PORT`) |
  | --- | --- | --- |
  | Fahim's own dev servers | 8787 | 5173 |
  | A | 8788 | 5174 |
  | B | 8789 | 5175 |
  | C | 8790 | 5176 |

  Ports 8000, 5183, 2024, 2025 and 8021 belong to other processes. Port 2026 is the edit API on
  Mateo's PC, and nothing on this laptop listens on it. Record the PID of every server you start
  and stop only that PID.
- **Dependencies.** Only foundation phases edit a `package.json`. A lane that needs a new package
  stops and asks.
- **Shared files.** Only foundation phases edit `app.ts`, `main.ts`, `vexcel.ts`, `matterport.ts`,
  `properties.ts`, `App.tsx`, `QuickView.tsx`, `api.ts`, `tools.ts`, `ToolPanel.tsx`, `styles.css`,
  `vite.config.ts` and `pipeline/build.ts`. Lane C alone edits `MapView.tsx`. A lane registers its
  ops and its panel by editing the `index` file in its own folder, which foundation created as a
  stub. A lane keeps its CSS in its own folder and imports it from its panel. A lane that needs a
  change in a foundation file stops and asks the main session.
- **Commits and pull requests.** One committer, the main session, commits each finished phase
  with the `[Fahim-Agent]` prefix on the branch `fahim-agent/propstar-tools`. The Protocol in
  `AGENT_COMMS.md` on `origin/main` says that changes reach `main` only through a pull request.
  The repo rule is to commit, push and open a pull request only when Fahim asks. Fahim gave
  standing permission on 2026-11-15 to commit each finished phase and to push the branch at
  milestones without asking. Ask before each pull request.
- **Other agents' folders.** No phase edits `tools/edit_api/`, `tools/edit_agent/`,
  `tools/visualization/` or `tools/qwen_test/`. [f6](phase-f6-server-scaffolds.md) imports
  `tools/edit_api/proxy.ts` and changes nothing in it.
- **Review.** No agent reviews its own phase. The main session hands each lane's diff to a
  reviewer subagent at these milestones, after f7, a7, l5, r4, b5, b9, c4 and e3.
- **A failed delegate.** If a lane agent fails or is interrupted, stop that lane and ask Fahim. Do
  not move its work to another model or take it over.
- **Log.** Add an `AGENT_COMMS.md` Log entry when foundation lands, when each lane lands and when
  a decision in `AGENTS.md` changes. The stack table in `AGENTS.md` gains Rapier and
  `@matterport/webcomponent` when lane B lands.
- **Comments.** Comments sit above a function or type and say how to use it. Phase numbers and
  narration stay out of the code.

## Agent adapter (later plan)

The deep agent on port 2024 will read `GET /api/ops` at startup and create one tool per entry from
its JSON Schema. Ops with `effect: 'write'` go under `interruptOn`, which matches the rule in
`AGENTS.md` that the agent asks before it places an object. `edit_start` is one of them, because
an edit holds the GPU on Mateo's PC for up to 9 minutes. A tool call is one
`POST /api/ops/:name`, and the envelope's `hint` gives the model its next step after an error.
`AGENTS.md` says to check LangChain APIs against the live docs first, and that `deepagents` needs
`>=1.8.4` for structured subagent output. `app/agent` already pins `deepagents` 1.16.5.

## Before kickoff

The first step is done. The Edit tool cannot reach the PC without the others, and Fahim parked
them on 2026-11-15. The Edit lane builds against a fake until they are done.

1. **Merge `origin/main`.** Done on 2026-11-15. The branch `fahim-agent/propstar-tools` holds the
   merge, so `tools/edit_api/` is in the tree and foundation can finish
   [f6](phase-f6-server-scaffolds.md). The local `main` is untouched.
2. **Add the two edit keys.** `EDIT_API_TOKEN` is in the repo-root `.env`. `EDIT_API_URL` is still
   missing. It is the address of Mateo's PC, and Mateo gives it privately.
3. **Open the link.** The laptop joins the campus VPN, and Mateo opens the firewall on his PC for
   it. His log says no call from this laptop was checked yet. [e1](phase-e1-edit-link.md) checks
   the link.
4. **Answer Output-Agent's open request.** The plan takes the default of each question at the end
   of `tools/edit_api/README.md`. The Hono server calls the API. The panel draws the cube faces
   itself. The panel sends yaw and pitch in the API's world frame. The panel shows the queue
   position and the step stream. When Fahim confirms, the main session records it in a Log entry
   and ticks the request once e1 passes.

## Open choices

These need Fahim's answer. Each has a default, so no lane blocks on them.

1. **The look, after the fact.** The art direction is settled. Fahim sees it first in the three
   screenshots of [l5](phase-l5-dollhouse-panel.md) and may ask for changes then.
2. **Furniture in scanned rooms.** Default is room-label templates, which sends no image off the
   laptop. The alternative sends panorama crops to the hosted model that Proppy already uses for
   aerial images. That is a data decision, not a technical one.
3. **`tools/world/`.** The recommendation is to delete it after [b4](phase-b4-vehicles.md) ports
   the parts the app needs, because it is logged as a throwaway. No phase deletes it. It stays
   until Fahim says so.
4. **Street basemap.** Default is OpenFreeMap tiles loaded by the browser, which is the one
   third-party request in the app. The alternative is no street basemap, with places drawn over
   the Vexcel imagery.
5. **Standing permission to commit and push.** Answered on 2026-11-15: the main session commits
   each finished phase and pushes the branch at milestones without asking. Pull requests are
   still asked for.
6. **Scans that are not on the edit PC.** The edit API edits only a scan that Mateo's PC has
   already downloaded. Default is to add no op for the download and to ask Mateo to download the
   scans for the demo. The alternative is a write op, `edit_fetch`, that calls the API's
   `POST /places/{model_id}/fetch`. It downloads panoramas and never unlocks a bundle.
