# Phase p1: Op adapter

Part of [the plan overview](overview.md).

Phase 4. It depends on [v1](phase-v1-view-ops.md). Its tests need no server and no key.

## Goal

Proppy's tools are the ops. After this phase Proppy builds one tool per manifest entry, asks the
user before every write op, and reads the view before every model call. It holds no database
connection and no hand-written tool except `view_aerial`.

## Changes

- Create `app/agent/src/ops.ts`.
  - `connectOps(baseUrl)` reads `GET /api/ops` under a 3 s timeout and returns an `Ops`. The base
    URL is `http://127.0.0.1:` plus `PROPSTAR_PORT`, or 8787 without it.
  - `Ops.call(name, input)` sends one `POST /api/ops/:name` with the header
    `x-propstar-client: agent` and resolves to the envelope. It never adds `?detail=full`, so a
    tool result stays under `RESULT_MAX_CHARS`. A request that fails resolves to an `upstream`
    error with the hint "Start the Propstar API with `pnpm --dir app/server start`."
  - `opTools(ops)` returns one `tool()` per entry, except an op whose name starts with `edit_`.
    Fahim cut calls to the edit API on 2026-11-15. The name is the op's name, the description is
    its `summary` and the schema is its `input` JSON Schema. An `ok` envelope returns
    `JSON.stringify(result)`. An error returns "`code`: message Hint: hint" as text and never
    throws, so the model reads the hint and corrects its call.
  - `approvals(ops)` returns the `interruptOn` map: one entry per op with `effect: 'write'`, with
    `allowedDecisions: ['approve', 'reject']`.
  - `viewNote(ops)` returns a `dynamicSystemPromptMiddleware`. It calls `view_get` and returns
    "What the user sees now:" plus the screen, the camera, `inView`, the filter and the highlight
    count. It leaves out `version` and the highlight list. The system message then changes only
    when the screen or the camera changes. A message that changed on every call would miss the
    prompt cache during a scoring run. When `view_get` fails, the note says "The view is
    unavailable."
- In `app/agent/src/proppy.ts`:
  - Delete `db`, `queryProperties`, `getProperty`, `placeObject` and the DuckDB import. The main
    session removes `@duckdb/node-api` from `app/agent/package.json`.
  - `createProppy` takes `{ops, model, subagentModel, checkpointer}`. The coordinator gets
    `opTools(ops)`, `approvals(ops)` and `viewNote(ops)`. The scorer keeps working on
    `property_get` and `view_aerial` until [p2](phase-p2-skills-scorer.md).
  - `viewAerial` builds its URL from the same base URL as `connectOps`.
  - Export `graph` as an async function. It caches the promise of `connectOps` and
    `createProppy`, and clears the cache when the promise rejects. The server calls the export on
    every run and every state read, so a missing cache would rebuild the agent each time.
    When the API is down, the error message is "The Propstar API is not reachable."
  - Replace step 1 of `COORDINATOR_PROMPT` with "Find candidates with `property_query`." p2
    rewrites the rest.
- In `proppy.test.ts`, replace the `queryProperties` tests, which moved to s1. Add tests on an
  invented `Ops` with one read op and one write op:
  - Each manifest entry becomes a tool with the op's name.
  - An error envelope reaches the model as text that holds the code and the hint.
  - An op named `edit_start` becomes no tool.
  - A write op interrupts. `approve` calls the op once, and `reject` never calls it.
  - The system message of a model call holds the view note.
  - Two `graph()` calls connect once, and a failed connect is retried on the next call.

## Data structures

- `Ops`: `{manifest: OpManifestEntry[], call(name: string, input: unknown): Promise<OpEnvelope>}`.
  Import `OpManifestEntry` and `OpEnvelope` with `import type` from `app/server/src/ops/`.
- `createProppy` options: `{ops: Ops, model?, subagentModel?, checkpointer?}`.
- View note, one line of JSON after the heading: `{screen, camera, inView, filter,
  highlightCount}`.

## Verification

1. Run `pnpm --dir app/agent typecheck` and `pnpm --dir app/agent test`. Both pass with no API
   running and no key.
2. Start the API on port 8791 and record its PID. Run a script in the scratchpad that calls
   `connectOps('http://127.0.0.1:8791')` and prints `manifest.length` and the names from
   `approvals`. The names are `scene_move`, `scene_place` and `scene_remove`.
   Record both lines in `decisions.tsv`.
3. Check that no file under `app/agent/src/` imports `@duckdb/node-api`. Run
   `grep -rn duckdb app/agent/src` and expect no line.
4. Stop the PID you recorded. Delete the script.
