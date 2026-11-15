# Phase f7: Web scaffolds

Part of [the plan overview](overview.md).

Foundation phase 7. It depends on [f6](phase-f6-server-scaffolds.md). It uses API port 8788 and
web port 5174. Read `docs/design/design.md` and run the **frontend-design** skill first.

## Goal

The property card opens any of seven panels, and each lane fills its own panel file. After this
phase a lane adds UI without touching `App.tsx`.

## Changes

- Add the web packages at exact versions: `three` 0.187.0, `three-mesh-bvh` 0.9.18,
  `@dimforge/rapier3d-compat` 0.21.0, `@matterport/webcomponent` 0.1.47, `n8ao` 2.0.2,
  `postprocessing` 6.39.6 and `@types/three`.
- Change the web `test` script to `node --test "src/**/*.test.ts"`.
- Add `callOp<Result, Detail>(name, input, {detail})` and `OpCallError` to `api.ts`. `callOp`
  posts to `/api/ops/:name`, returns `{result, detail}` on success and throws `OpCallError` with
  `code`, `message` and `hint` on failure. It trusts the type the caller names, because the
  server already validated the result against the op's schema.
- Create `app/web/src/tools.ts` with `TOOLS`, one entry per tool with `id`, `label`, `icon` and a
  lazy `panel`. Create the seven stub panels that the entries import:
  `dollhouse/DollhousePanel.tsx`, `route/RoutePanel.tsx`, `scene/ScenePanel.tsx`,
  `signage/SignagePanel.tsx`, `area/AreaPanel.tsx`, `features/FeaturesPanel.tsx` and
  `edit/EditPanel.tsx`. A stub shows the tool's name and "Not built yet".
- Create `app/web/src/ToolPanel.tsx`. It draws the panel frame (title, close button, loading and
  error states) around the lazy panel inside `Suspense`. The panel docks on the right of the map
  frame at full height and `min(760px, 62%)` wide, so the map stays visible on its left. The
  Area panel needs that map. It exports `useOp(name, input,
  {detail})`, which calls `callOp` and returns `{status, result, detail, error}`. A panel that
  draws geometry passes `{detail: true}`. The error state shows the `hint`.
- Add a `tool` variant to `View` in `App.tsx`, which holds the property id and the tool id. Add a
  tool row to `QuickView.tsx` with one button per entry of `TOOLS`.
- Change `vite.config.ts` to read `PROPSTAR_WEB_PORT` (default 5173) and `PROPSTAR_PORT` (default
  8787) for the proxy target. Add `../server/src/model` to `server.fs.allow`, so the web app can
  import fixtures, furnishing kinds and the equipment table. Allow that one folder only. The rule
  that the dev server reads no other path outside its package stays.
- Create `api.test.ts`. It tests `callOp` against a fake `fetch` for success, an error envelope
  and a response that is not JSON.

## Data structures

- `Tool`: `{id: 'dollhouse' | 'route' | 'scene' | 'signage' | 'area' | 'features' | 'edit',
  label, icon, panel}`.
- `PanelProps`: `{property}`. Every panel receives the selected `Property` and nothing else.
- `View`: gains `{kind: 'tool', propertyId, tool}`.
- `OpState`: `{status: 'loading' | 'ready' | 'error', result?, detail?, error?}`.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`.
2. Start the API on port 8788 and the web app on port 5174. Record both PIDs.
3. Open `http://localhost:5174`, select a property and open each of the seven panels. Take one
   screenshot at 1440 by 900 of the tool row and one of an open stub panel. Save them to your
   scratchpad. Check both against `docs/design/design.md`.
4. Stop both PIDs.
5. Run the ownership check with `--lane foundation --lane lane-a --lane lane-b --lane lane-c`,
   because foundation creates the stub panels.
6. Stop here. The main session hands the foundation diff to a reviewer subagent and runs
   **interrogate** on `Op` and `BuildingModel`. No lane starts until both finish.
