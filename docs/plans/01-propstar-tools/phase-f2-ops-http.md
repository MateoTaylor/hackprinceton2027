# Phase f2: Ops over HTTP

Part of [the plan overview](overview.md).

Foundation phase 2. It depends on [f1](phase-f1-op-contract.md). It uses API port 8788.

## Goal

A model reads one manifest and calls any op with one request shape. After this phase
`GET /api/ops` lists the ops and `POST /api/ops/property_get` answers for a real property.

## Changes

- Create `app/server/src/ops/registry.ts` with `createRegistry(ops, base)`.
  - It throws at startup when a name fails `^[a-z][a-z0-9_]{2,40}$` or appears twice.
  - `manifest()` returns `{name, summary, effect, input, output}` per op, with both schemas
    converted by `z.toJSONSchema`.
  - `run(name, rawInput, {detail})` calls `runOp` with a context of `{...base, call}`.
  - It builds `call`. `call` runs the named op with `detail` on and throws an `OpError` when the
    envelope is a failure. It counts depth and fails with `internal` past depth 4, so a cycle
    cannot hang the server.
- Create `app/server/src/ops/index.ts`. It exports `OPS`, which spreads the array that each tool
  folder exports from its `index.ts`. In this phase `OPS` holds `property_get` only.
- Create `app/server/src/ops/http.ts` with `mountOps(app, registry)`.
  - `GET /api/ops` returns `{ops: [...]}`.
  - `POST /api/ops/:name` reads a JSON object body, capped at 64 KB with Hono's `bodyLimit`. It
    passes `detail: true` only for `?detail=full`.
  - An unknown name returns 404 with `not_found` and a hint that names `GET /api/ops`.
  - The status table is `invalid_input` 400, `not_found` 404, `not_ready` 503, `no_data` 404,
    `upstream` 502, `conflict` 409 and `internal` 500. Write it with `satisfies
    Record<OpErrorCode, number>`, so a new code fails the build until it has a status.
- Create `app/server/src/ops/property/index.ts` with `property_get`. Its output schema mirrors
  `Property` from `app/shared/property.ts` and carries `satisfies z.ZodType<Property>`, so the two
  cannot drift.
- Change `createApp` in `app.ts` to `createApp({base, ops = OPS})`. `base` is `OpContext` without
  `call`. The existing routes read `base.properties` and `base.vexcel`. The host check and the
  cross-site check already cover the new routes, because they run before every route.
- Change `main.ts` to read `PROPSTAR_PORT`, with 8787 as the default, and to pass `dataDir`.
- Update the six `createApp` calls in `server.test.ts`. Give each a `dataDir` from `mkdtemp`.
- Create `registry.test.ts`, `http.test.ts` and `guard.test.ts` in `app/server/src/ops/`.
  `guard.test.ts` loops over `OPS` and fails when a name breaks the pattern, a summary is empty or
  longer than 160 characters, a schema does not convert to JSON Schema, or an output or detail
  schema has a property named like `broker`, `contact`, `email` or `phone`.

## Data structures

- `Registry`: `{get(name), manifest(), run(name, rawInput, options)}`.
- `OpManifestEntry`: `{name, summary, effect, input, output}`, where both schemas are JSON Schema.
- `property_get` input: `{propertyId}`. Result: the curated `Property`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. Start the API on port 8788 as [testing.md](testing.md) shows, and record its PID.
3. Run `node docs/plans/01-propstar-tools/probe-op.mjs property_get propertyId=commercial-248243
   --port 8788`. The first line is `POST /api/ops/property_get 200 ok`.
4. Run the same command with `propertyId=nope`. It exits 1 and prints `not_found` with a hint.
5. Stop the PID you recorded. Run the ownership check with `--lane foundation`.
