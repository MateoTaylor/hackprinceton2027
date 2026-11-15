# Phase v2: The browser follows the view

Part of [the plan overview](overview.md).

Phase 2. It depends on [v1](phase-v1-view-ops.md) and on
[f7](../01-propstar-tools/phase-f7-web-scaffolds.md) of the tools plan. It uses API port 8791 and
web port 5177.

## Goal

After this phase a view op moves the user's screen, and what the user does reaches `view_get`.
A model that calls `view_open` sees the card open in the browser. A user who pans the map
changes the `camera` that the next `view_get` returns.

## Changes

- Create `app/web/src/view.ts` with `useView()`. It owns one `EventSource('/api/events')` and one
  `clientId` from `crypto.randomUUID()`. It returns `{view, setScreen, report, move, onWrite}`.
  - A `view` event from another writer replaces the local view. An event whose `by` equals
    `clientId` is this tab's own report coming back, so the hook drops it.
  - `setScreen(screen)` sets the local screen and sends `PUT /api/view`. `report({camera, bounds,
    filter})` sends the same route, at most once every 250 ms.
  - `move` is the last `move` request with a counter, so the map applies each request once.
  - `onWrite(listener)` subscribes a panel to `write` events from other writers.
  - `EventSource` reconnects on its own. After a reconnect the first event is the server's view,
    and the tab adopts it.
- In `api.ts`, `callOp` sends the header `x-propstar-client` with the same `clientId`.
- In `App.tsx`, delete the local `View` type and the `view` state. `screen` comes from
  `useView()`, and every `setView` call becomes `setScreen`. Rename `id` to `propertyId` in the
  `selected` and `flythrough` screens. Report `filter` when `kind`, `type`, `sort` or `savedOnly`
  changes.
- In `MapView.tsx`, report the camera and the bounds on `moveend`. Apply `move` with `fitBounds`
  for `{fit}`, capped at zoom 17 and padded by the chat inset the map already uses, and with
  `easeTo` for a point. The Header's frame button keeps working through the same path. Lane C
  owns this file until c3 lands, so wait for c3 or ask the main session.
- Keep the pins as they are. [p3](phase-p3-chat-panel.md) moves them to the highlights.
- Create `view.test.ts` beside the hook for the parts that need no browser: a `view` event by
  this tab is dropped, an event by another writer is adopted, and two reports inside 250 ms send
  one request.

## Data structures

- `useView()` result: `{view: View, setScreen(screen: Screen), report(change), move: {seq,
  request} | null, onWrite(listener): () => void}`. `View`, `Screen` and the events come from
  `app/shared/view.ts`.
- `MapView` props: `frameRequest` gives way to `move`. `onCamera(camera, bounds)` is new.

## Verification

1. Run `pnpm typecheck` and `pnpm test` in `app/web`. Start the API on port 8791 and the web app
   on port 5177. Record both PIDs.
2. Open the web app. Run `node docs/plans/01-propstar-tools/probe-op.mjs view_get --port 8791
   --show result.attached`. It prints 1.
3. Probe `view_open propertyId=commercial-248243 panel=card --port 8791`. Take a screenshot at
   1440 by 900. The card of that property is open.
4. Probe `view_frame --port 8791`, then take a screenshot. The map shows every pin. Probe
   `view_get --show result.inView.count` and record the number.
5. Pan the map by hand, then probe `view_get --show result.camera.zoom` twice, before and after a
   zoom. The two numbers differ.
6. Select a property by hand, then probe `view_get --show result.screen.kind`. It prints
   `selected`.
7. Check the screenshots against `docs/design/design.md`. Stop both PIDs.
8. Stop here. The main session hands the diff of v1 and v2 to a reviewer subagent.
