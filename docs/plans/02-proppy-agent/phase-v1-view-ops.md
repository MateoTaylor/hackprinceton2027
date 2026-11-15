# Phase v1: View ops

Part of [the plan overview](overview.md).

Phase 1. It depends on [f2](../01-propstar-tools/phase-f2-ops-http.md) of the tools plan. It uses
API port 8791.

## Goal

A model reads what the user sees and changes it through ops. After this phase the server holds
the view, five ops read and write it, and `GET /api/events` streams every change. No browser
follows the view yet.

## Changes

- Create `app/shared/view.ts` with the types under Data structures. It holds types only, like the
  other files in `app/shared/`.
- Create `app/server/src/view/schema.ts` with one Zod schema per type. End each schema with
  `satisfies z.ZodType<...>` against the shared type, so the two cannot drift.
- Create `app/server/src/view/store.ts` with `createViewStore()`. It returns `get()`,
  `apply(change, by, move?)`, `publishWrite(op, by)`, `subscribe(listener)` and `attached()`.
  `apply` merges the change, adds 1 to `version` and sends a `view` event to every listener.
- Create `app/server/src/view/routes.ts` with `mountView(app, store)`.
  - `GET /api/events` answers with `streamSSE` from `hono/streaming`. It sends the current view
    first, then every event, and a comment line every 20 s so the connection stays open.
  - `PUT /api/view` takes `{screen?, camera?, bounds?, filter?}` under a 64 KB limit. It reads the
    tab's id from the `x-propstar-client` header and answers 400 when the body fails the schema.
- In `op.ts`, `effect` becomes `'read' | 'write' | 'view'` and `OpContext` gains
  `view: ViewStore`. `main.ts` creates the store and passes it in `base`.
- In `http.ts`, `mountOps` takes an `onWrite(name, by)` callback and calls it after a `write` op
  answers `ok`. `by` is the `x-propstar-client` header, or `unknown`. `app.ts` passes
  `store.publishWrite` and calls `mountView`.
- Create `app/server/src/ops/view/index.ts` with `VIEW_OPS`, and add it to `OPS`.
  - `view_get` returns the view. `inView` counts the properties inside `bounds` and lists the
    first 20 ids. It is `null` while `bounds` is `null`. `detail` holds every highlight.
  - `view_open` checks the property with `requireProperty`. `card` gives a `selected` screen.
    `flythrough` takes `modelId` or the property's first scan, and throws `no_data` when the
    property has no scan. A tool id gives a `tool` screen.
  - `view_frame` sets `screen` to `browse` and sends `move: {fit}`, the box around the given
    properties. With no ids it fits every property.
  - `view_camera` sends `move: {lat, lon, zoom}`. A missing value keeps the reported one. With
    no reported camera and a missing value it throws `not_ready`.
  - `view_highlight` replaces the list, upserts by `propertyId` or clears. An unknown id throws
    `not_found` and names it. A list past 200 throws `invalid_input`.
- Create `store.test.ts` and `view.test.ts` beside them. Check the version count, the event order,
  the `attached` count, each error above and the size cap on `view_get` with 200 highlights.

## Data structures

- `Screen`: `{kind: 'browse'} | {kind: 'selected', propertyId} | {kind: 'flythrough', propertyId,
  modelId} | {kind: 'tool', propertyId, tool: ToolId}`. `ToolId` is one of `dollhouse`, `route`,
  `scene`, `signage`, `area`, `features` and `edit`.
- `View`: `{version, screen, camera: {lat, lon, zoom} | null, bounds: {west, south, east, north} |
  null, filter: {kind, type, sort, savedOnly}, highlights: Highlight[]}`.
- `Highlight`: `{propertyId, score: number | null, note?}`. `score` is 0 to 100 and `note` is at
  most 80 characters.
- `ViewEvent`: `{type: 'view', view, by, move?}`. `by` is `op`, `server` or a tab's id. `move` is
  `{fit: Bounds} | {lat, lon, zoom}`.
- `WriteEvent`: `{type: 'write', op, by}`.
- `view_open` input: `{propertyId, panel: 'card' | 'flythrough' | ToolId, modelId?}`.
- `view_frame` input: `{propertyIds?}`, at most 200 ids. `view_camera` input: `{lat?, lon?,
  zoom?}`, at least one, `zoom` from 2 to 21.
- `view_highlight` input: `{mode: 'replace' | 'add' | 'clear', items?: Highlight[]}`.
- `view_get` result: `{version, screen, camera, bounds, inView: {count, propertyIds} | null,
  filter, highlightCount, highlights, attached}`, with the first 20 highlights.
- Every other view op result: `{screen, highlightCount, attached, assumptions}`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`. Start the API on port
   8791 and record its PID.
2. Run `node docs/plans/01-propstar-tools/probe-op.mjs view_open propertyId=commercial-248243
   panel=card --port 8791`, then `view_get --port 8791 --show result.version`. The version is 1.
3. Probe `view_highlight mode=add items=[{"propertyId":"commercial-248243","score":80}]`, then
   `view_get --show result.highlightCount`. It prints 1.
4. Probe `view_open propertyId=nope panel=card` and `view_camera zoom=30`. Both exit 1.
5. Check that the manifest lists the five ops with `effect` `read` or `view`. Record every
   printed line in `decisions.tsv`. Stop the PID you recorded.
