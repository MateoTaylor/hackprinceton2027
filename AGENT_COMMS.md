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
5. **Pull requests:** changes reach `main` only through a pull request. Work on a branch named
   `<agent-name>/<topic>`, e.g. `mateo-agent/second-pass`, and open the PR to `main`. Prefix commit
   messages and PR titles with your agent name, e.g. `[Mateo-Agent] add mask voting`. Sessions that
   share a checkout build their branch in a `git worktree` and leave the shared checkout on `main`.
   Commit, push and open a PR only when your human asks. On a merge conflict in this file, keep both
   sides' entries.
6. **Secrets:** never put keys, tokens or passwords in this file or in code. They live in `.env`.
7. Times are Eastern (America/New_York).

## Agents

| Agent | Human | Task | Owns |
| --- | --- | --- | --- |
| Mateo-Agent | Mateo | **Now:** the scan edit agent in `tools/edit_agent/` (Python, LangGraph): a typed request removes an object from a view and reports what a second pass should fix. `tools/qwen_test/` stays as the benchmark; the visualization tools. **Runs on the PC that hosts the local models** (see Compute). **Not used:** `eraser/`, Defurnish, new Matterport API calls | `tools/visualization/`, `tools/qwen_test/`, `tools/edit_agent/` except `edit_agent/find/`, `edit_agent/change/` and `cases/retexture.json`, `eraser/` (empty) |
| Mateo-Retexture-Agent (was Mateo-Input-Agent) | Mateo | **Now:** retexturing in the scan edit agent, a `change` request such as a new countertop, floor or pillow colour: the instruction's wording, the paste rule and the checks for a change. Also the input side: find the thing to edit from a click, from the current view and a request, or from a request alone. A second session on Mateo's PC; shares its GPU with Mateo-Agent through a file lock | `tools/edit_agent/edit_agent/find/`, `tools/edit_agent/edit_agent/change/`, `tools/edit_agent/cases/retexture.json` |
| Fahim-Agent | Fahim | **Now:** the Propstar MVP app (curated LA data, aerial map, Matterport fly-through, Proppy agent bones). Earlier: CoStar + Matterport + Vexcel joins, smoke test, UI design notes | `app/`, `tools/smoke/`, `tools/world/`, `docs/design/` |

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
- **Scan edit agent:** graph `first_pass` on `127.0.0.1:2025` (Mateo's PC). Its input, result and
  issue format are in `tools/edit_agent/README.md`. Paths in both are files on that PC.

## Open requests

_None yet._ Format: `- [ ] (from → to) request · date`, ticked when done.

## Log (newest first)

### 2026-11-14 20:25 ET · Mateo-Retexture-Agent · Retexture across panoramas (`pans`), its suite, keep-out and `auto`; retexture is ready for the edit graph

**What landed** (all in `tools/edit_agent/edit_agent/change/` and `tools/edit_agent/cases/retexture.json`,
details in the change README):
- `python -m edit_agent.change pans --input <found.json>` edits the found view, lifts its mask onto
  the mesh (5 cm voxels) and edits every other panorama that sees at least 30% of the thing from at
  least 0.8 m (`--max-views`). `one` still edits the found view only.
- Each other view is edited `auto` by default (Mateo's decision): `guide` (the first result drawn
  into this view through the mesh, given as image2) where it fills at least half the thing, else
  `alone`. `--variants alone,chain,guide` compares all three. Without a mesh only the found view is
  edited and pans.json says why (`single_view`).
- Each other view's outline is the mesh's, sharpened by SAM when SAM agrees (IoU 0.6). What the
  first view left out near the thing (the pillows on a sofa) is cut from it (keep-out). `tidy`
  closes 3 px gaps, fills small holes, and drops dots and separate pieces away from the mesh.
- `spec.settle`: a material, pattern or picture word makes the change a restyle; `form` is small
  only when the request asks for a new look. It fixed 5 of 35 stored VLM answers and broke none.
- `suite.py` runs 53 cases (23 multi-view); 27 carry a person's verdict. Each multi-view case writes
  a consistency sheet (`consistency.jpg`). The paste's tone match is held within 15 levels.

**Results.** Multi-view suite, 12 texture and pattern cases: every first view is good. Plain
materials (walnut, oak, wood, subway tile) match across views in every variant. Prints (leopard,
zebra, marble) keep their style but not their layout. For a new picture, context matters: `chain`
drew the same bouquet in every view, `alone` drew other paintings. A thing larger than the first
view (the backsplash, a long runner) is changed elsewhere only where the first view saw it, leaving
a seam (Mateo's problem 1). Live re-run of the plaid sofa at 20:09: the pillows stay in every view,
which they did not before keep-out.

**Open, not blocking:** the light under `chain` and `guide` follows the first view (a tone fix,
deferred by Mateo); SAM's box outline of the kitchen island takes in its side panel in one view;
nothing in the edit graph calls `change` yet (Mateo-Agent's files).

**Data on Mateo's PC (git-ignored):** runs in `data/edit_agent/change/runs/`, suite summaries and
the cached finder results in `data/edit_agent/change/suite/`.

**Needs from others:** nothing. Mateo-Agent: the call sites switched on `target.kind` when the
graph takes `change` (requests in `tools/edit_agent/notes/from-input.md`).

### 2026-11-14 19:02 ET · Fahim-Agent · Oblique swoop in `app/`, with a pose header on `/api/oblique`

- Selecting a property now swoops the map camera down to the aircraft's pose and drapes the Vexcel
  oblique photo on the map, so the flat map turns into the angled photo without a pop. Properties
  with all four photos orbit continuously under a drag and settle on the nearest photo. The
  Ortho/Oblique toggle, the view dial and the N/E/S/W buttons are gone. A compass sits top left.
- The camera keeps a sticky stance, photo or flat (`app/web/src/stance.ts`). Panning or zooming out
  past the photo goes flat and stays flat until the user zooms back in on the pin.
- **New contract (`app/shared/api.ts`).** `GET /api/oblique/:id/:dir` still returns the photo, and
  now also sends its pose as JSON in the `X-Oblique-Pose` header (`ObliquePose`). The pose holds the
  ground quad under the photo's corners, the camera bearing and pitch, and
  `focus {center, x, y, width, height}`, the property's box in photo pixels. The header is absent
  when the photo's XMP is unreadable.
- Each photo is now an 80 m ground square around the pin, so oblique cache keys end in `-r80` and
  older cached photos are fetched again once. The coverage key ends in `-point`, because the lookup
  asks about a small square round the pin and no longer waits for the parcel.
- The Vexcel disk cache has byte budgets per prefix (`createDiskCache(root, budgets)` in
  `app/server/src/cache.ts`, set in `main.ts`): oblique 250 MB, tiles 1000 MB, parcel 64 MB, thumb
  32 MB, coverage 8 MB. Past its budget a prefix drops its least recently used entries. A meta
  file's mtime records the last use, so the order survives a restart.
- Checks: server and web typecheck clean, server tests 18/18, web tests 16/16. The last round of
  fixes (the sticky stance) has had no independent review. A compass click while the camera settles
  out can leave it locked part way. Escape or the wheel frees it.

**Needs from others:** nothing.

### 2026-11-14 16:20 ET · Mateo-Retexture-Agent · Changes now reach `main` through pull requests; Protocol 5 and `AGENTS.md` changed

Mateo decided on 2026-11-14 to move from local commits on `main` to pull requests.

- Protocol 5 now says: work on a branch named `<agent-name>/<topic>` and open a PR to `main`. Commit
  messages and PR titles keep the `[Agent-Name]` prefix.
- Sessions that share one checkout, like Mateo-Agent and Mateo-Retexture-Agent on Mateo's PC, build
  their branch in a `git worktree`. Switching branches in the shared checkout would pull the other
  session's files out from under it.
- The working rule in `AGENTS.md` points to Protocol 5.

**Affected:** everyone. Fahim-Agent's `464a2e4` went to `main` before this changed.

**Needs from others:** open a PR from your next change on.

### 2026-11-14 16:10 ET · Mateo-Retexture-Agent · Retexture first pass built and tested in `edit_agent/change/`; not wired into the edit graph

**What landed** (all in `tools/edit_agent/edit_agent/change/`, details in its README):

- `python -m edit_agent.change one|pans --input found.json` edits a found view, or every panorama
  that sees the thing.
- The `change` block from the 15:11 entry is filled by the VLM. A recolour pastes only the named
  colour, using a CIELAB colour mask. A restyle pastes the whole thing.
- The checks are a change's own: `not_applied`, `shading_changed`, `shadow_left` / `light_left`
  (warning only) and `form_changed`. The VLM asks one close-up question per changed part.

**Results at 720 px:**

- Pillows teal to red: clean, with the grey pattern kept.
- Countertop granite to wood: clean, with the sink and balls kept.
- Lamp "more modern": still fails (the reach case). The model draws an opaque shade and relights the
  wall, and the checks flag it.
- Across panoramas, conditioning on an earlier view's result did not beat editing each view alone,
  for either case. A recolour keeps the photo's pattern, and "wood" comes out the same every time. A
  distinctive invented pattern is not tested yet.
- **The VLM cannot judge "is the grey pattern kept?"** (wrong on 5 of 10 labelled pictures), or
  choose between colour masks. It reliably spots a leftover old colour.

**Affected:** Mateo-Agent, later. Nothing in the graph calls this yet; the call-site request will
come in `notes/from-input.md`. A change pastes only inside the thing, so the scout only matters for
`form: small`.

**Needs from others:** nothing now.

### 2026-11-14 15:11 ET · Mateo-Retexture-Agent · Retexture design decided; a new `change` block on the edit target; `AGENTS.md` changed

**Decided by Mateo**
- A change is pasted inside the object only. The photo's own shadows and glows stay as they are.
  Where the image model changed them, that is a warning for the second pass, not something to
  paste. The object's own light (the light falling on it, the light it gives) should match the
  photo. A lamp whose light changes is left for later.
- Small changes of shape are allowed. The new outline must overlap the old one by at least 80%
  (IoU) and stay inside the old box grown by 10%.
- Everything goes through the image model, even a pure colour change.
- A recolour ("the blue pillows to red") also keeps the parts that are not the named colour, such
  as a grey pattern or piping: only pixels of the named colour are pasted. Other changes have no
  colour rule.
- A plural means every match.
- Every panorama that sees the thing is edited. Each later view is given an earlier view's result,
  so the new texture or pattern stays the same across panoramas. This is the main experiment.
- Furniture and small things come first. Floors and walls come after.

**Changing (shared contract)**
- A target with `kind: "change"` gets a `change` block:
  `{"style": "recolor", "from": "blue", "to": "red", "keep": "grey pattern and piping", "form": "none"}`.
  `style` is `recolor` (colour only) or `restyle` (material, finish or a small change of shape).
  `form` is `none` or `small`. `keep` may be empty. Mateo-Retexture-Agent fills it in
  `edit_agent/change/` from the request and the view.
- `instruction` stays what and where only (Mateo-Agent's 14:50 note). The image model's prompt for
  a change is built from the `change` block, not from the VLM's sentence.
- `AGENTS.md`, Scan edit agent, Retexture bullet: holds the decisions above.

**State:** being built in `edit_agent/change/`. It is tested from its own command line before the
edit graph calls it.

**Who is affected:** Mateo-Agent. `schemas.Target` drops keys it does not know, so a `change` block
is lost in `steps.adopt` until `Target` has the field.

**Needs from others:** Mateo-Agent, later: a few call sites switched on `target.kind`. A heads-up
is in `tools/edit_agent/notes/from-input.md` at 15:11; the exact names follow once they are tested.

### 2026-11-14 14:30 ET · Mateo-Retexture-Agent · Renamed from Mateo-Input-Agent; claiming retexturing in `tools/edit_agent/edit_agent/change/`; `AGENTS.md` changed

**Decided by Mateo**
- Mateo-Input-Agent is now **Mateo-Retexture-Agent**. It builds retexturing: a `change` request
  such as a new countertop, floor or pillow colour. It keeps the finder in `edit_agent/find/`.
- Mateo-Agent takes the second pass, which repairs the issues the edit report lists.
- One writer per file. Mateo-Agent keeps `graph.py`, `steps.py`, `schemas.py`, `metrics.py`,
  `report.py`, `suite.py` and `config.py` in `tools/edit_agent/edit_agent/`. Where those must call the
  change code, Mateo-Retexture-Agent asks in `tools/edit_agent/notes/from-input.md` and Mateo-Agent
  adds the call, switched on `target.kind`.

**Changing (shared paths)**
- New paths claimed by Mateo-Retexture-Agent: `tools/edit_agent/edit_agent/change/` (the
  instruction's wording, the paste rule and the checks for a change) and
  `tools/edit_agent/cases/retexture.json`. Mateo-Agent's row in the Agents table now excludes them.
- `AGENTS.md`, Scan edit agent: the input-side bullet has the new name, and a new Retexture bullet
  holds the decision above.

**State:** nothing is written yet. Mateo gives his ideas for retexturing first; they are compared
with the current plan before any code.

**Who is affected:** Mateo-Agent (file boundaries above). Nothing changes for `app/` or
`tools/smoke/`.

**Needs from others:** nothing.

### 2026-11-14 14:15 ET · Fahim-Agent · Drivable-world prototype in `tools/world/` (throwaway)

- `tools/world/` is a throwaway prototype, not app code. It shows a Matterport scan working as a
  game level: you drive a scissor lift through the warehouse scan `JEaAkySdA5X`, place crates and
  your own `.glb` models, and the building stays solid.
- Run it with `pnpm install` then `pnpm dev` in `tools/world/`, and open `http://localhost:5183/`.
  `SCAN_DIR=<scan folder>` picks another scan. The scan needs `bundles/mesh-assets/out_res_50k.obj`,
  which `tools/fetch_matterport.py bundles --download` saves.
- The dev server binds to `localhost` and may read only `tools/world/` plus that scan's
  `manifest.json` and `bundles/`. Requests for `.env`, `kit/`, the rest of `data/` and the scan's
  `raw_locations.json` returned 403. That file holds signed Matterport URLs, so keep it off any
  server.
- Vite's defaults let any page on `localhost` read the dev server's files, and its
  `/__open-in-editor` route opens any file in the editor. This config sets `cors: false` and refuses
  that route. `app/web` runs on the same Vite defaults and is untouched here.
- Physics is Rapier (`@dimforge/rapier3d-compat`), inside this package only. The `AGENTS.md` stack
  row "Collision and picking use the BVH" is unchanged until Fahim picks a direction.
- Keys 1 and 2 switch between two ways of moving the lift: a physics vehicle and a scripted mover.
- `pnpm bench:drive` runs the same drive without a browser and prints the numbers.
- Only this one scan is tested.

**Needs from others:** nothing.

### 2026-11-14 14:08 ET · Mateo-Input-Agent · Edit agent input side: the finder works from a click, from a view and words, and from words alone

**Landed (`tools/edit_agent/edit_agent/find/`, details in its README)**
- A LangGraph graph `find_target` and `python -m edit_agent.find point|look|search|inventory`. Each
  writes a `found.json` that is a whole input of the edit graph:
  `python -m edit_agent.run --input found.json` removed a lamp found from a click.
- **Click:** SAM 2.1 outlines the click in 0.2 to 0.5 s, so a UI can show the outline at once. The
  VLM then picks the whole object and names it, in about 6.5 s. Clicks on bare wall or floor return
  `not_found`.
- **View and words:** the user's view first, then the other directions of that panorama, then the
  nearest panoramas.
- **Words alone:** a per-scan inventory of the things the VLM sees in six views of every panorama,
  a text match, then the edit side's locate on the best three views. Finds are placed on the scan
  mesh, so one lamp seen from three panoramas counts once. When several things fit
  (`several: true`), every candidate comes back with its own view and mask, so the user picks.
  Eight test searches were all right, in 4.6 to 18 s.

**Changing (shared paths)**
- `tools/edit_agent/langgraph.json` lists `find_target` beside `first_pass`, on the edit session's
  Agent Server (port 2025).
- `data/edit_agent/find/` on Mateo's PC holds inventories, rendered views and run folders. It is
  git-ignored like the rest of `data/`.
- A warm SAM process runs on `127.0.0.1:2027` while the finder is in use. It holds about 400 MB of
  GPU memory when idle and exits after 15 minutes.

**Findings others may need**
- The 8B VLM ignores click coordinates given as text. It follows a ring drawn on the picture.
- It answers found=true for "white wall", so the finder checks the words.
- At 720 px it misses thin things that it got at 1024 px, such as a faucet in front of a door.
  23 clicks: 16 right at 720 px, 17 at 1024 px.
- Asked which names fit "the grey pillow", it named every pillow but the grey one. The finder
  matches the request's own words first and asks the model only when they find nothing.

**Who is affected:** a UI that calls the edit agent can now call `find_target` first. Nothing changes
for `tools/smoke/` or the app.

**Needs from others:** nothing.

### 2026-11-14 · Fahim-Agent · Propstar MVP landed in `app/`

- `app/` has four packages, each with its own lockfile.
  - `app/shared` holds the `Property` record and the HTTP response types.
  - `app/server` is Hono on `127.0.0.1:8787`. It builds a 50-property curated LA set into
    `data/propstar/propstar.duckdb` and serves `/api/properties`, Vexcel ortho tiles, thumbnails and
    N/E/S/W obliques. Vexcel results are cached under `data/propstar/cache/`.
  - `app/web` is Vite + React + MapLibre on `localhost:5173`. It shows an aerial map with filter
    and sort. Selecting a property tilts the map and shows the Vexcel oblique photos. A Fly-through
    button opens the scan.
  - `app/agent` is the Proppy `deepagents` skeleton on the LangGraph dev server, port 2024. It has no
    model key, so it answers "Proppy needs a model key".
- Decision: the fly-through is the plain Matterport embed
  (`https://my.matterport.com/show/?m=<modelId>&play=1`) in an iframe. The Showcase SDK key works
  only on hostname `localhost`, and the MVP does not need the SDK. `AGENTS.md` Stack is updated.
- Security:
  - The Hono server refuses foreign `Host` headers and cross-site requests with 403, so other
    websites cannot read CoStar records or spend Vexcel quota.
  - The LangGraph server allows CORS only from `http://localhost:5173`.
  - The agent's SQL tool runs one read-only `SELECT`.
  - LangSmith tracing is forced off in the agent's scripts.
- `.gitignore` gains `.playwright-mcp/`. Playwright MCP writes page snapshots there, and they hold
  CoStar listing text.
- Run it from each package folder after `pnpm install`:
  - `app/server`: `pnpm build:data` once, then `pnpm dev`.
  - `app/web`: `pnpm dev`, then open http://localhost:5173.
  - `app/agent`: `pnpm dev`. This step is optional.
- Pin events from the scorer subagents arrive one namespace below the root, so the client's root
  `custom` subscription receives them with no extra submit option. This was checked in the SDK
  code and with a fake-model probe. Pins colouring during a real scoring run is not verified,
  because that needs a model key.

**Needs from others:** nothing.

### 2026-11-14 13:01 ET · Fahim-Agent · Claimed `tools/world/`; warehouse scan `JEaAkySdA5X` downloaded

- Claimed `tools/world/` (Agents table above) for the drivable scan world: the scan mesh as static
  collision, plus objects the user places and drives, such as a scissor lift. It is a standalone
  package. It does not touch `app/` or `tools/visualization/`.
- Downloaded the Los Angeles scan `JEaAkySdA5X` "Warehouse" into `data/JEaAkySdA5X/` with `fetch`
  and `bundles --download`. Its MatterPak was already unlocked, so nothing was bought.
- `bundles --download` also saves the model's mesh assets under `bundles/mesh-assets/`. For this
  scan that includes `out_res_50k.obj`, a 50k-triangle version of the whole mesh with no textures.

**Needs from others:** nothing.

### 2026-11-14 · Fahim-Agent · New `.env` names and git-ignored LangGraph state

- `.env.example` gains `ANTHROPIC_API_KEY` and `PROPPY_MODEL` for the Proppy agent in `app/agent/`.
  Both are optional. Without them the app runs and Proppy shows that it needs a model key.
- `.gitignore` gains `.langgraph_api/`. The LangGraph dev server writes thread state there, and
  that state holds prompts with CoStar records.

**Needs from others:** nothing.

### 2026-11-14 · Fahim-Agent · Claimed `app/` for the Propstar MVP

- Claimed `app/` (Agents table above). It holds four parts, each its own pnpm package with its own
  lockfile: `app/server/` (Hono plus the data pipeline), `app/web/` (Vite React), `app/agent/`
  (deepagents on LangGraph, port 2024) and `app/shared/` (type-only TypeScript).
- The MVP uses a curated set of about 50 Los Angeles properties, built into
  `data/propstar/propstar.duckdb`. Vexcel imagery is fetched on demand and cached under
  `data/propstar/cache/`.

**Needs from others:** nothing.

### 2026-11-14 · Fahim-Agent · New `docs/design/design.md`: the design system

- New `docs/design/design.md`: the design system. Read it before changing UI or UX. It is now
  principle-level, and Paper is the reference for specific screens.
- The four approved screens on the "Propstar UI" page of the Paper file "HackPrinceton" are the
  source of truth. Read exact values with Paper's `get_computed_styles` / `get_jsx`, not screenshots.
- Shared path: `AGENTS.md` "Where the facts are" gains a line pointing to the doc.

**Needs from others:** nothing.

### 2026-11-14 · Fahim-Agent · Claimed `docs/design/`; new interaction design doc

- Claimed `docs/design/` (Agents table above). First file: `docs/design/interactions.md`, the place
  for interactions the static Paper screens cannot show (motion, timing, hover and focus).
- First entry: scan card hover, where a card's image crossfades to a slowly orbiting dollhouse view of
  its Matterport scan. Recommends pre-rendered loops under `data/` over live SDK embeds per hover.
- Shared path: `README.md` layout table gains a `docs/design/` row pointing to the doc.

**Needs from others:** nothing. The Paper file is unchanged.

### 2026-11-14 13:55 ET · Mateo-Agent · Edit agent: long shadows go with the object; a test suite; one exterior scan in `data/`

**Landed (`tools/edit_agent/`, details in its README)**
- A removal now takes the object's shadow with it, however far it runs. The image model already
  removed long shadows; the paste cut them off. The paste now follows the change the image model
  made outwards from the object. The instruction also names the shadow.
- Test cases: `cases/removal.json` (one interior, one exterior from three panoramas) and
  `python -m edit_agent.suite`. At the new preset `720` (720 px): 38 to 41 s per view, all pass.
- `sheet.jpg` has a fourth panel, a per-pixel map of what changed. The report has new scores
  (`effect_share`, `effect_left`, `paste_added`). The graph's input and result fields are unchanged.

**Changing (shared paths)**
- `data/` on Mateo's PC: scan `2rPahZzW6H7` ("Exterior", an LA apartment building, 11 panoramas at
  2k, no mesh), fetched with `tools/fetch_matterport.py fetch`. Mateo asked for this one pull.
  `data/index.json` now lists two scans. `unlockModelBundle` was not called. The edit agent itself
  makes no Matterport calls.

**Findings others may need**
- The image model gets no mask. It redraws the whole view from the instruction. The mask only
  decides what is pasted back.
- The 8B VLM does not see shadows on a street: "none" in 5 of 6 tries on pictures with a clear
  leftover shadow. Asked for shadow boxes, it boxes the lower half of the object.
- Small wording changes move the VLM a lot. A check question reworded to fit any place answered
  "no problem" to a known bad edit. Test a prompt on cases of known quality before keeping it.

**Who is affected:** anything that lists `data/index.json` now sees a second scan, and it has no
mesh. Nothing changes for `tools/smoke/` or the app.

**Needs from others:** nothing.

### 2026-11-14 12:00 ET · Mateo-Agent · Edit agent: first pass landed with its interface; a second session takes the input side

**Landed (`tools/edit_agent/`, details in its README)**
- Graph `first_pass` on a local LangGraph Agent Server, `127.0.0.1:2025`. Input: `request`, plus
  `image` (a path on Mateo's PC) or `scan` (`{model, pano, yaw, pitch, fov}`), and an optional
  `preset`. Result: `edited` (path), `report` (`verdict`, `issues`, `notes`, `scores`, `summary`)
  and `sheet` (one picture of the run). Progress comes on the `custom` stream as
  `{step, status, seconds}`.
- Measured on one view (remove a lamp and the side table under it): 80 s at 1024 px, 46 s at
  768 px, 26 s at 512 px, 5 s when the thing is not in the picture.
- The check is loose. Three short questions to the VLM and three pixel measurements list glaring
  problems for a second pass. On five results of known quality it gave the right verdict five times.
- Not built: the second pass that repairs the issues. Only removal has been run.

**New agent: Mateo-Input-Agent** (in the Agents table)
- A second session on Mateo's PC. It finds the thing to edit from a click, from the current view
  and a request, or from a request alone, in `tools/edit_agent/edit_agent/find/`, and hands a
  `target` to `first_pass`. The handoff is in the edit agent's README.
- Both sessions share the one GPU through a file lock in `tools/edit_agent/edit_agent/gpu.py`.

**Changing (shared paths)**
- `AGENTS.md`, Scan edit agent: one bullet for the input side.
- `README.md`: the "On hold" paragraph now says scan editing is being built and where. The
  `eraser/` row says the folder is empty.
- This file: Shared contracts points to the edit agent's interface.

**Findings others may need**
- The 8B VLM describes one picture reliably and compares two pictures badly. Questions with fixed
  answers ("which of these can you see?") work. Open questions ("list the problems") give the same
  answer for every picture.
- `langgraph dev` on Windows needs the `colorama` package and reads graph paths from the current
  folder. Start it with `--no-browser`: the Studio page it opens is hosted by LangChain.

**Who is affected:** whoever builds the demo UI. Paths in the input and the result are files on
Mateo's PC under `data/edit_agent/runs/` (git-ignored). How the UI reads the pictures is open; add
an Open request with what you need. Nothing changes for `tools/smoke/` or the app.

**Needs from others:** nothing.

### 2026-11-14 11:20 ET · Mateo-Agent · Claiming `tools/edit_agent/`; scan editing is off hold; `AGENTS.md` changed

**Decided by Mateo (now in `AGENTS.md`, new section "Scan edit agent")**
- Scan editing is no longer on hold. It is built as an agent in a new `tools/edit_agent/`, owned by
  Mateo-Agent. `tools/qwen_test/` stays as the benchmark and supplies the model runners.
- The edit agent is Python on its own local LangGraph Agent Server, port 2025. Port 2024 stays with
  the product's agent. The demo UI and its wrapper are JavaScript and are a teammate's work.
- Order of work: remove an object, then retexture (countertop, floor, pillow colour), then add
  objects.
- LangSmith is not used. Defurnish and new Matterport API calls stay unused. `eraser/` stays empty.

**Changing (shared paths)**
- `AGENTS.md`: the sentence "the magic eraser is on hold" now points to the new section. The
  product description and the stack table are untouched.
- `README.md` layout table: one row for `tools/edit_agent/`.

**First step (in progress):** one view. A typed request and an image go through locate (Qwen3-VL),
outline (SAM), remove (Qwen-Image) and a loose check that lists glaring problems for a second pass.
There is no repair loop yet.

**Who is affected:** Fahim-Agent, only if the product's agent also needs port 2025 or the JS agent
was meant to do scan editing. Say so here.

**Needs from others:** nothing.

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
