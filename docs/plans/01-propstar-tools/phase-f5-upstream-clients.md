# Phase f5: Upstream clients

Part of [the plan overview](overview.md).

Foundation phase 5. It depends on [f1](phase-f1-op-contract.md) and starts no server. Run the
**how** skill on `app/server/src/vexcel.ts` before you edit it.

## Goal

Lanes get building footprints from Vexcel and floor plans from Matterport through two clients
that cache, rate-limit and cannot spend money. After this phase no lane writes its own `fetch` to
either service.

## Changes

- Add `extract(lat, lon, {bufferM, include})` to the Vexcel client in `vexcel.ts`. It calls
  `property/extract` with `wkt=POINT(lon lat)`, `srid=4326` and `latest=true` through the existing
  `json` and `limiter`, so it shares the disk cache and the request limit. It returns every
  feature. The caller picks the capture.
- Create `app/server/src/matterport.ts` with `createMatterport({tokenId, tokenSecret, cache,
  fetch})`.
  - A private `graphql(query, variables)` sends one request with basic auth and caches the answer
    on disk by a hash of the query and the variables.
  - Before it sends, `graphql` throws when the query text contains `mutation` or
    `unlockModelBundle`. The client can then never buy a bundle, whatever a caller passes.
  - The one public method is `floorPlan(modelId)`. It rejects an id that fails
    `^[A-Za-z0-9]{11}$`, runs the floor-plan query from [findings.md](findings.md) and returns
    floors and rooms parsed with Zod.
  - `floorPlan` asks for geometry and labels only. It never asks for an asset URL, because
    Matterport signs those URLs.
  - Every failure becomes an `OpError` with code `upstream`. The message names the service and
    the HTTP status. It never includes the response body or the request headers.
- Add `matterport` to `OpContext`. It is `null` when `MP_TOKEN_ID` or `MP_TOKEN_SECRET` is
  missing. An op that needs it throws `not_ready` with a hint that names the two key names.
- Change `main.ts` to build the Matterport client from the environment.
- Create `vexcel.test.ts` cases for `extract` and create `matterport.test.ts`. Both use a fake
  `fetch` and invented responses. Test that `graphql` refuses a mutation, that a bad id never
  reaches `fetch` and that a second call reads the cache.
- Create `app/server/src/upstream.live.test.ts`. It makes one `extract` call and one `floorPlan`
  call against the real services. It skips when a key is missing, so `pnpm test` never calls out.
  It prints counts only.

## Data structures

- `ExtractFeature`: `{id, ring, capturedAt, primary, attributes}`, where `attributes` is a map of
  the calculated and precomputed values that Vexcel filled.
- `FloorPlan`: `{floors: [{id, label, sequence, vertices, edges}], rooms: [{id, label, floorId,
  boundaryEdgeIds, holeEdgeIds, classifications, ceiling}]}`.
- `edges[]`: `{id, type, thickness, vertexIds, openings: [{id, type, widthM, heightM,
  lowerElevationM, relativeCenter}]}`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`. The live test reports
   as skipped.
2. From `app/server`, run `node --env-file=../../.env --test src/upstream.live.test.ts`. It passes
   and prints a feature count and a room count. Record the two counts. Record nothing else.
3. Run `git grep -n unlockModelBundle -- app/`. The only matches are the refusal in
   `matterport.ts` and its test.
4. Run the ownership check with `--lane foundation`.
