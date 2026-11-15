# Proppy: a deep agent that drives Propstar through the op API

This plan rebuilds Proppy, the LangChain deep agent in `app/agent/`, on the op API of
[the tools plan](../01-propstar-tools/overview.md). It also adds the ops that Proppy needs and the
tools plan left out. Five ops read and change what the user sees, and one op searches across
properties.

Fahim asked on 2026-11-15 for the plan first. He decides when the build starts.

## Context

Proppy today has four hand-written tools and its own DuckDB connection in
`app/agent/src/proppy.ts`. It scores properties and colours pins. It cannot move the map, open a
property or call any of the seven tools.

The tools plan gives every tool an op. `GET /api/ops` lists the ops and `POST /api/ops/:name` runs
one. Its section "Agent adapter (later plan)" says how an agent connects. This plan is that later
plan.

| Fahim's requirement | What answers it |
| --- | --- |
| Move around the map and zoom in and out of properties | The view ops |
| Use the tools | One agent tool per manifest entry |
| Use the three CoStar products | `property_query` and `property_get` read CoStar records. `view_aerial` and `features_get` read Vexcel. `building_get`, `route_solve`, the scene ops and the edit ops read Matterport scans. |
| Remove an object from a scan | The Edit panel swaps in one picture that Mateo prepared. Proppy opens it with `view_open`. |

Fahim wrote "the 8 tools". The tools plan lists seven. Proppy builds its tools from the manifest,
so an eighth tool needs no change here.

## Scope

In scope:

- The view document, its event stream and the five view ops.
- The search tables and `property_query`.
- The adapter that turns the manifest into agent tools, with approval before every write op.
- Four skills, one scorer subagent and the coordinator prompt.
- The approval card in the chat panel, and pins drawn from the view.
- The three demo flows under [Demo flows](#demo-flows), end to end.

Out of scope:

- Sign rules, zoning and permits. Fahim cut them on 2026-11-15. The sign skill says so in every
  answer.
- Calls to Mateo's edit API. Fahim cut them on 2026-11-15. He picks one panorama, Mateo sends
  back one edited picture, and the Edit panel swaps it in.
- Image work across many properties. A question across many properties is answered from
  records and tables. Proppy studies pictures for one property, and only when the user asks.
- Panoramas and scan pictures in the model's context. Fahim chose aerials only on 2026-11-15.
- The sidebar filter. Proppy reads it and narrows the map with highlights. Two ways to narrow the
  map would give the model a choice with no right answer.
- The saved list. It stays in the browser.
- Memory across threads, LangSmith tracing and any new key.

## Constraints

Every constraint of the tools plan holds here. This plan adds three.

- **What reaches the hosted model.** The user's messages, op results and the 256 px aerial from
  `view_aerial`. Op results hold the curated `Property` fields that Proppy already sends today. The
  fact labels in the database are building attributes, and none names a broker or a contact. No
  panorama, scan picture or edited picture goes to the model.
- **A run spends Fahim's Anthropic credit.** Tests use a fake model. Only
  [p4](phase-p4-demo-flows.md) calls the real one. A question across many properties starts no
  subagent and sends no image.
- **LangSmith stays off.** `pnpm --dir app/agent dev` already sets the tracing variables to
  `false`. Do not remove them.

## The view

The view is one document that says what the user sees. The server holds it in memory. The agent
and the browser both write it, and the last write wins.

- `screen` is `browse`, `selected {propertyId}`, `flythrough {propertyId, modelId}` or
  `tool {propertyId, tool, state?}`. It replaces the `View` type in `App.tsx`.
- `camera {lat, lon, zoom}` and `bounds {west, south, east, north}` are what the map last
  reported. Both are `null` until a tab reports.
- `filter` is the sidebar's kind, type, sort and saved-only switch, as the tab reports them.
- `highlights` is a list of `{propertyId, score, note?}`, at most 200. `score` runs from 0 to 100.
  `null` marks a match that has no score yet. The pins draw from this list.
- `state` on a tool screen holds what the user picked in that panel. The Edit panel reports the
  panorama and the view direction. The Scene and Signage panels report the space, the selected
  object and `aim`, the surface under the centre of the screen. The Routing panel reports the
  payload and the target.
- `version` goes up by one on every change.

Two channels carry the view between the server and a tab.

- `GET /api/events` is one server-sent event stream per tab. A `view` event carries the whole
  document, who changed it and, for a camera move, a `move` request. A `write` event names a write
  op that just succeeded, so an open panel reloads.
- `PUT /api/view` is how a tab reports what the user did. It is a plain route and not an op,
  because no model calls it.

The camera fields are reported and never set. Only the browser knows the size of the map. So
`view_frame` and `view_camera` send a `move` request, the map moves, and the tab reports the
camera it reached.

## New ops

| Op | Effect | What it answers |
| --- | --- | --- |
| `view_get` | read | What the user sees: screen, camera, properties in view, filter and highlights |
| `view_open` | view | Open a property's card, its fly-through or one of its tool panels |
| `view_frame` | view | Return to the map and fit the camera to a set of properties |
| `view_camera` | view | Move the map to a point and a zoom |
| `view_highlight` | view | Replace, add to or clear the highlighted properties and their scores |
| `property_query` | read | The rows of one SELECT over the properties, the roads near each and the places near each |

`effect` gains a third value. A `view` op changes only what the screen shows, so it runs without
approval. A `write` op changes stored data or starts work on another machine, so it asks first.

Every view op result ends with `attached`, the number of open tabs. With no tab open, the result
adds the assumption "No browser tab is open. The change shows when one opens."

## How Proppy is built

- **One seam.** At startup Proppy reads `GET /api/ops` and creates one tool per entry from its
  JSON Schema. A tool call is one `POST /api/ops/:name`. On an error the tool returns the code, the
  message and the hint as text, so the model reads the hint and tries again. Proppy drops its own
  DuckDB connection.
- **One hand-written tool.** `view_aerial` stays, because an image does not fit the op envelope.
  It is the only picture the model sees.
- **The view note.** Before every model call, a middleware calls `view_get` and appends a short
  note to the system message: the screen, the camera, the properties in view and the filter.
  Proppy therefore knows what "this one" and "here" mean without a tool call.
- **Approvals.** `interruptOn` is built from the manifest: every op with `effect: 'write'` pauses
  for approve or reject. Those are `scene_place`, `scene_move` and `scene_remove`. Proppy gets
  no tool for an op whose name starts with `edit_`.
- **Scores across many properties.** The coordinator scores the rows of `property_query` itself,
  from the record and the area tables, and posts them in one `view_highlight` call. It starts no
  subagent and reads no image.
- **Scorer subagent.** `score-property` studies one property, and only when the user focuses on
  that property and asks for a deeper look. It gets the read ops and `view_aerial`, returns a
  `PropertyScore`, and a middleware posts the score through `view_highlight`.
- **Skills.** `accessibility-audit`, `property-search`, `sign-and-lift` and `scan-edit` live in
  `app/agent/skills/`. A skill holds domain knowledge. The op schemas already say how to call an op.
- **Files.** The `FilesystemBackend` keeps its root in `data/propstar/agent-fs` with
  `virtualMode: true`, and `/skills/` stays read-only.
- **Model.** `PROPPY_MODEL` picks it and defaults to `anthropic:claude-sonnet-5-5`. The key is
  `ANTHROPIC_API_KEY` in the repo-root `.env`. Both names are already in `.env.example`.

## Demo flows

These three flows are the acceptance test. [p4](phase-p4-demo-flows.md) runs them.

**"Find wheelchair-friendly condos away from highways."**

1. Proppy reads the bounds and the filter from the view note, then reads the `property-search`
   and `accessibility-audit` skills.
2. `property_query` returns the condos with no `motorway` or `trunk` row in `near_roads` under
   300 m, with the record columns that the accessibility skill names.
3. Proppy scores each row from those columns. One `view_highlight` call with `replace` colours
   the pins, and `view_frame` fits the map to them.
4. Proppy answers with the ranked list. It says that the scores come from records only, and it
   offers a deeper look at one property.
5. Follow-up: "Look closer at the first one." Proppy opens it with `view_open` and sends one
   `task` call to `score-property`, which reads the aerial, the Vexcel features and the scan.
   The pin takes the new score.
6. Follow-up: "Can a wheelchair reach the lobby?" Proppy calls `building_get`,
   then `route_solve` with the wheelchair payload, then `view_open` on the Routing panel with the
   same payload and target. It answers with the verdict per door and the confidence.

**"What kind of lift would a sign on this property need?"**

1. Proppy reads the `sign-and-lift` skill and calls `view_open` with the Signage panel. The panel
   shows the kit's one outdoor scan, and Proppy says that this scan stands in for the property.
2. Proppy asks the user to face the wall. It reads `aim` from the view note and calls
   `scene_place` with `sign_panel` and a wall anchor. The approval card appears. On approve, the
   panel reloads and shows the sign.
3. `signage_measure` returns the size, the height above the ground and the lift.
4. Proppy names the lift and its working height. It repeats "The sign is a blank placeholder. No
   sign rule, zone or permit was checked."
5. Proppy offers to place the lift. A second `scene_place` puts it on the ground under the sign,
   after a second approval.

**"Remove the floor lamp."** The user says it while the Edit panel shows the chosen panorama.

1. Proppy reads the `scan-edit` skill. The view note holds the scan and the panorama.
2. Proppy calls `view_open` on the Edit panel with `edited: true`. The panel swaps in the picture
   that Mateo prepared. No request leaves the laptop and no approval is needed.
3. On any other panorama, Proppy says that the demo holds one prepared edit and names where.

## Alternatives

- **A hand-written tool per op.** Rejected. The manifest already holds the name, the summary and
  the schema. A hand-written list goes stale the day a lane adds an op.
- **Map control as stream events from the agent**, the way pins travel today. Rejected. The agent
  could not read back what the user sees, a reload would lose the state, and the browser would
  have a second path beside the ops. `probe-op.mjs` could not test it either.
- **The browser as the source of truth**, with the server relaying each request and waiting for
  the tab's reply. Rejected. An op would then block on a tab that may be closed.
- **Search as a fixed list of filter fields.** Rejected. Every new question would need a new field.
  Three described tables and one guarded SELECT answer questions nobody listed. The guard exists
  today in `proppy.ts` and has tests.
- **One column per area question, such as `highway_m`.** Dropped after Fahim asked on 2026-11-15
  why it was hardcoded. Each new road or place question would need a new column. `near_roads` and
  `near_places` hold every road class and every place group, at any distance up to 1000 m.
- **Spatial SQL over the area extract at query time.** Rejected. A guarded query would then run
  with the `spatial` extension loaded, which adds functions such as `ST_Read` that the guard has
  no tests against. A join that the model forgets to filter can also run past the 2 s limit. The
  build does the joins once.
- **Panoramas to the hosted model for interior scoring.** Rejected by Fahim. Interior facts reach
  Proppy as `building_get` and `route_solve` results, which carry `source` and `confidence`.
- **One scorer subagent per candidate.** Rejected by Fahim on 2026-11-15. It sent an aerial per
  candidate to the model. Records and tables answer a question across many properties.
- **A subagent for map control.** Rejected. A view op is one call with a small result.

## Checked LangChain facts

`AGENTS.md` says to check LangChain APIs before use. These were checked on 2026-11-15 against the
live docs and the packages in `app/agent/node_modules`.

- `tool()` from `langchain` accepts a JSON Schema as `schema`, so a manifest `input` passes in
  unchanged.
- `deepagents` 1.16.5 passes the top-level `interruptOn` to every subagent. A custom subagent
  needs its own `skills` list.
- `dynamicSystemPromptMiddleware` from `langchain` 1.6.5 runs before every model call and appends
  its text to `request.systemMessage`.
- `@langchain/langgraph-api` 1.7.2 accepts a function as the graph export and calls it on every
  run (`dist/graph/load.mjs`). The factory must cache the agent it builds.
- `interruptOn[name].description` may be a function of the tool call.
- In `@langchain/react` 1.2.14, `stream.interrupt` holds `actionRequests`, and
  `stream.submit(null, {command: {resume: {decisions}}})` resumes the run.

## Applicable skills

- **architect** before [v1](phase-v1-view-ops.md). The view types reach the server, the browser
  and the agent.
- `langchain-skills:deep-agents-core`, `langchain-skills:langchain-middleware` and
  `langchain-skills:langgraph-human-in-the-loop` before the p phases, with the LangChain docs
  server for anything this plan did not check.
- **how** before a phase edits `App.tsx`, `MapView.tsx` or a lane's panel.
- **frontend-design** and `docs/design/design.md` for the approval card.
- **writing-for-agents** for the four skills and the coordinator prompt.
- **show-me-your-work**, with the decision log in `decisions.tsv` in this folder.
- `/deslop` and `/no-comments` before each commit.

## Phases

One agent builds the phases in this order. Each line names what the phase needs first.

1. [v1 View ops](phase-v1-view-ops.md). Needs f2 of the tools plan.
2. [v2 The browser follows the view](phase-v2-browser-view.md). Needs v1 and f7.
3. [s1 `property_query`](phase-s1-property-query.md). Needs f2, and c2 for the area tables.
4. [p1 Op adapter](phase-p1-op-adapter.md). Needs v1.
5. [p2 Skills and scorer](phase-p2-skills-scorer.md). Needs p1 and s1.
6. [p3 Chat panel and pins](phase-p3-chat-panel.md). Needs p2 and v2.
7. [v3 Panel state](phase-v3-panel-state.md). Needs v2 and the panels of r4, b9 and e3.
8. [p4 Demo flows](phase-p4-demo-flows.md). Needs every phase above and the three lanes.

Two agents can split the work. One takes `app/agent/` and `app/web/src/Proppy.tsx` (p1, p2, p3).
The other takes the rest (v1, v2, s1, v3). They meet at p4.

What to cut first if time runs short, in this order: `aim` in v3, the Routing panel's state in
v3, `view_camera`, `inView` in `view_get`. Each demo flow still works without them. Without
`aim`, the user clicks the wall to hang the sign and Proppy reads it with `scene_get`.

## Verification

[The tools plan's testing page](../01-propstar-tools/testing.md) has the commands. In short:

- Every phase ends with `pnpm typecheck` and `pnpm test` in each package it touched.
  `pnpm --dir app/agent test` uses a fake model and needs no key.
- Every op phase ends with `node docs/plans/01-propstar-tools/probe-op.mjs <op> ... --port 8791`.
  Record the printed lines in `decisions.tsv`. Use `--show` on counts and numbers only.
- Every phase that ends in pixels takes a screenshot at 1440 by 900 and checks it against
  `docs/design/design.md`. A page that hosts the Matterport viewer allows
  `browser_take_screenshot` and nothing else.
- Never print a response body, a chat transcript that holds op results, or a line of `.env`.

## Implementation guidance

- **Ports.** Phases without the agent server use API port 8791 and web port 5177, passed inline.
  The agent server allows only the web origin `http://localhost:5173`, so p3 and p4 run on ports
  8787, 5173 and 2024. Those are Fahim's ports. Start on them only when all three are free, and
  ask Fahim when one is taken. Record every PID you start and stop only that PID.
- **Ownership.** The main session adds these rows to the tools plan's `ownership.tsv` before the
  build starts, with the new owner `lane-p`: `docs/plans/02-proppy-agent/`,
  `app/shared/view.ts`, `app/server/src/view/`, `app/server/src/ops/view/`,
  `app/server/src/ops/search/`, `app/server/pipeline/search.ts`, `app/web/src/view.ts`,
  `app/web/src/approval.ts`, `app/web/src/Proppy.tsx` and `app/web/src/pins.ts`. The row for
  `app/agent/` moves from `main` to `lane-p`. The main session also adds `lane-p` to `OWNERS` in
  `check-ownership.mjs`, which rejects an owner it does not list.
- **Files that belong to someone else.** This plan changes `op.ts`, `http.ts`, `ops/index.ts`,
  `app.ts`, `main.ts`, `App.tsx`, `MapView.tsx`, `api.ts`, `ToolPanel.tsx`, two `package.json`
  files and four lane panels. Each phase file names its changes. The main session makes them or
  hands them over in writing. v3 starts only after the lanes that own the panels have landed.
- **Decisions to record.** Three lines in `AGENTS.md` change, each with an `AGENT_COMMS.md` Log
  entry in the same step. The main session owns both files.
  - "Tools emit progress through `config.writer`" becomes "Proppy posts scores through
    `view_highlight`, so pin colours survive a reload." p3 makes it true.
  - Agent design gains "Proppy's tools come from `GET /api/ops`. `view_aerial` is the one
    hand-written tool." p1 makes it true.
  - Data and secrets gains "Proppy sends op results and the 256 px aerial to the hosted model, and
    no panorama (Fahim, 2026-11-15)."
- **A new op needs an agent restart.** Proppy reads the manifest once.
- **Commits.** One commit per finished phase with the `[Fahim-Agent]` prefix. The standing
  permission in the tools plan covered that plan's build. Ask Fahim before the first commit here.
- **Review.** No agent reviews its own phase. A reviewer subagent reads the diff after v2, after
  p3 and after p4.
- **A failed delegate.** Stop and ask Fahim. Do not move the work to another model or take it over.

## Open choices

Each has a default, so no phase blocks.

1. **When to build.** Fahim's call. v1, s1, p1 and p2 need only the tools plan's foundation, so
   they can start before the lanes land.
2. **`aim`.** Default is to build it in v3. It lets Proppy hang the sign where the user looks.
   Without it the user clicks the wall.
3. **A smaller model for the scorer.** Default is one model for both. `createProppy` already
   takes `subagentModel`. A second `.env` name would need a Log entry.
4. **Lane E of the tools plan.** Its phases e1, e2 and e3 build the edit ops and a panel that
   calls Mateo's API. Fahim decides what happens to them. This plan needs only a panel that shows
   one panorama and swaps in one prepared picture.
