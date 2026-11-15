# Phase f6: Server scaffolds

Part of [the plan overview](overview.md).

Foundation phase 6. It depends on [f2](phase-f2-ops-http.md), [f4](phase-f4-equipment.md) and
[f5](phase-f5-upstream-clients.md). It uses API port 8788. It needs `origin/main` merged, which is
step 1 of Before kickoff in the overview, because it copies `tools/edit_api/proxy.ts`.

## Goal

Every lane finds its folder, its ops and its packages already in place. After this phase
`GET /api/ops` lists all 16 ops, and a lane never edits a file outside its own folders.

## Changes

- Add a `building_facts` table to `app/server/pipeline/build.ts`. Its columns are `property_id`,
  `stories`, `slab_to_slab_ft`, `building_sf` and `floors`, a list of `{code, sizeSf}`. Select
  those named fields from the CoStar record and nothing else. The pipeline prints the row count.
- Add `loadBuildingFacts` to `properties.ts` and add `buildingFacts` to `OpContext`. It is a map
  from property id to `BuildingFacts`.
- Create one `index.ts` per tool folder. Each exports an array of stub ops with final names,
  summaries, effects and input schemas. Each stub throws `not_ready` with the hint "This op is
  not built yet."
  - `ops/building/`: `building_get`.
  - `ops/route/`: `route_solve`.
  - `ops/scene/`: `scene_get`, `scene_place`, `scene_move`, `scene_remove`.
  - `ops/signage/`: `lift_choose`, `signage_measure`.
  - `ops/area/`: `area_places`, `area_summary`.
  - `ops/features/`: `features_get`.
  - `ops/edit/`: `edit_places`, `edit_start`, `edit_get`.
- Spread the seven arrays into `OPS` in `ops/index.ts`. `OPS` then holds 16 ops.
- Add `GET /api/scene/config` to `app.ts`. It returns `{sdkKey}` with `Cache-Control: no-store`
  and answers 503 when the key is missing. It is a plain route and not an op, so the key never
  appears in the manifest or in an op result. `createApp` gains `sdkKey = null`, and `main.ts`
  reads `MP_SDK_KEY`.
- Mount the edit proxy in `app.ts` with `app.all('/api/edit/*', (c) => forwardEdit(c.req.raw,
  editLink))`. Copy `tools/edit_api/proxy.ts` to `app/server/src/editProxy.ts` byte for byte and
  import `forwardEdit` and `PREFIX` from the copy. Its README allows a copy or an import. An
  import fails `typecheck`, because `tools/edit_api/` has no `package.json` and tsc then reads the
  file as CommonJS. Add a test to `server.test.ts` that the copy equals the original, so a change
  on Mateo's side shows up as a failing test. Change nothing in `tools/edit_api/`. Mount the
  route after the host check and the cross-site check, so both cover it.
  `createApp` gains `editLink = {}`, and `main.ts` fills it from `EDIT_API_URL` and
  `EDIT_API_TOKEN`. Without them the proxy itself answers 503 `edit_api_not_configured`. Never
  log either value.
- Add `edit` to `OpContext`. `main.ts` builds it as `(path, init) => forwardEdit(new
  Request('http://127.0.0.1' + PREFIX + path, init), editLink)`. `path` is the edit API's own
  path, such as `/places/<modelId>`. An op then reaches the PC through the same function as the
  browser, and no op holds the token.
- Add the server packages that the lanes need. Pin exact versions: `ngraph.graph`, `ngraph.path`
  1.6.1, `clipper2-ts` 2.0.1-19, `three` 0.187.0, `three-mesh-bvh` 0.9.18 and `@types/three`.
  The last three serve [r5](phase-r5-mesh-clearance.md).
- Add the script `build:area` to `app/server/package.json`. It runs `pipeline/area.ts` without
  `--env-file`, because it needs no key. Create the file as a stub that prints "not built yet"
  and exits 1.
- Extend `guard.test.ts` to expect 16 ops, and add a test that `/api/scene/config` answers 503
  without a key and sets `no-store` with one. Add a test that `/api/edit/health` answers 503
  `edit_api_not_configured` when `editLink` is empty. The test calls no outside service.

## Data structures

- `BuildingFacts`: `{propertyId, stories | null, slabToSlabFt | null, buildingSf | null, floors:
  [{code, sizeSf}]}`.
- `OpContext`: `{properties, vexcel, matterport, buildingFacts, dataDir, call, edit}`.
- `EditLink`: `{base?: string, key?: string}`, the options that `forwardEdit` takes.
- `edit`: `(path: string, init?: RequestInit) => Promise<Response>`.
- Scene config response: `{sdkKey}`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. Run `pnpm --dir app/server build:data`. Record the `building_facts` row count it prints.
3. Start the API on port 8788 and record its PID.
4. Run `node -e "fetch('http://127.0.0.1:8788/api/ops').then(r => r.json()).then(b =>
   console.log(b.ops.length))"`. It prints 16.
5. Run `node -e "fetch('http://127.0.0.1:8788/api/scene/config').then(r =>
   console.log(r.status))"`. It prints 200. Print the status only, never the body.
6. Run `node docs/plans/01-propstar-tools/probe-op.mjs building_get
   propertyId=commercial-248243 --port 8788`. It exits 1 with `not_ready`.
7. Stop the PID you recorded.
8. Run `node docs/plans/01-propstar-tools/check-ownership.mjs --changed --lane foundation --lane
   lane-a --lane lane-b --lane lane-c`. Foundation creates the lanes' stub files, so this one
   check passes all four names.
