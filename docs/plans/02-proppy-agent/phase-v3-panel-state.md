# Phase v3: Panel state

Part of [the plan overview](overview.md).

Phase 7. It depends on [v2](phase-v2-browser-view.md) and on the panels of
[r4](../01-propstar-tools/phase-r4-route-overlay.md),
[b9](../01-propstar-tools/phase-b9-signage-panel.md) and
[e3](../01-propstar-tools/phase-e3-edit-panel.md) of the tools plan. It uses API port 8791 and
web port 5177.

## Goal

Proppy knows what the user picked inside a tool panel, and can set it. After this phase "remove
this lamp" swaps in the prepared picture on the panorama the user stands in, "hang the sign
here" works without a click, and a write that Proppy makes shows in the open panel at once.

## Changes

- In `app/shared/view.ts` and `app/server/src/view/schema.ts`, the `tool` screen gains `state?`.
  It is a union keyed by `tool`, with the shapes under Data structures. `view_open` gains
  `state?` with the same union, and `PUT /api/view` accepts it inside `screen`.
- In `view_get`, return `state` inside `screen`. Round every number to 3 decimals so the view
  note stays short.
- In `ToolPanel.tsx`, pass each panel `state` and `onState(state)`. `onState` calls `setScreen`
  with the new state, at most once every 250 ms.
- In `edit/EditPanel.tsx`:
  - Report `{modelId, panoId, edited}` when the user changes the panorama or the Before and
    After toggle.
  - When `state` arrives from another writer, show that panorama, and the prepared picture when
    `edited` is true.
- In `scene/ScenePanel.tsx`:
  - Report `{spaceId, selectedObjectId}` on a space change and on a selection.
  - Report `aim` when the camera stops moving. `aim` is the hit under the centre of the screen
    from the panel's own raycast: the position, the normal and the surface kind. It is absent
    when the ray hits nothing.
  - Subscribe with `onWrite`. A `write` event for a `scene_` op from another writer calls the
    scene's `load()`, so the panel shows what Proppy placed.
- `signage/SignagePanel.tsx` renders `ScenePanel`, so it reports the same state. Check that a
  sign placed by Proppy gets its ground and its measure line after the reload.
- In `route/RoutePanel.tsx`, report `{payload, target}` when the user picks them. When `state`
  arrives from another writer, solve and draw that route.
- These four files belong to lanes R, B and E. Start only after r4, b9 and e3 have landed, and
  get each change from the main session or the lane's owner in writing.
- Add tests for the schema union: each tool id accepts its own state and rejects another's.

## Data structures

- Edit state: `{modelId, panoId, edited: boolean}`. `edited` is true while the panel shows the
  prepared picture.
- Scene and signage state: `{spaceId, selectedObjectId?, aim?: {position: [x, y, z], normal: [x,
  y, z], kind: 'floor' | 'wall' | 'ceiling'}}`. `position`, `normal` and `kind` are the names of
  `scene_place`'s `position` and `anchor`.
- Route state: `{payload, target, storeyIndex?}`, the names of `route_solve`'s input.
- Dollhouse, area and features panels report no state.

## Verification

1. Run `pnpm typecheck` and `pnpm test` in `app/server` and `app/web`. Start the API on port
   8791 and the web app on port 5177. Record both PIDs.
2. Open the Edit panel by hand. Probe `view_open` with the Edit panel and `edited: true`, then
   `view_get --port 8791 --show result.screen.state.edited`. It prints `true`, and a screenshot
   shows the prepared picture.
3. Open the Signage panel and face a wall. Probe `view_get --show result.screen.state.aim.kind`.
   It prints `wall`.
4. Probe `scene_place` with the space id, `sign_panel`, and the `aim` position and normal from
   step 3. Take a screenshot with `browser_take_screenshot`. The sign is on the wall with no
   page reload.
5. Probe `view_open` with the Routing panel and a `state` that holds the `wheelchair` payload
   and a space from `building_get`. Take a screenshot. The panel shows that route.
6. Remove the sign from step 4 with `scene_remove`. Stop both PIDs.
