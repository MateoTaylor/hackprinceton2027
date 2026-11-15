# Phase f1: Op contract

Part of [the plan overview](overview.md).

Foundation phase 1. It depends on nothing and starts no server. Run the **architect** skill on
this phase and [f3](phase-f3-building-model.md) together before you write code.

## Goal

Every op has one shape and one way to fail, so a model learns the API once. After this phase a
lane writes an op as a single `defineOp` call and tests it without HTTP.

## Changes

- Create `app/server/src/ops/op.ts`. It exports `defineOp`, `runOp`, `OpError`, `OP_ERROR_CODES`,
  `RESULT_MAX_CHARS`, `requireProperty` and the Zod schemas `Source`, `Confidence` and
  `Assumptions`.
- `defineOp` returns its argument. It exists so that TypeScript infers the input of `run` from
  `input` and checks what `run` returns against `output` and `detail`.
- `runOp(op, ctx, rawInput, {detail})` never throws. It returns an `OpEnvelope`.
  - It parses `rawInput` with `op.input`. A failure returns `invalid_input`, names the first
    failing path and points the hint at `GET /api/ops`.
  - It returns the code, message and hint of any `OpError` that `run` throws.
  - It turns every other exception into `internal` with a fixed message. It never echoes
    exception text, because that text can hold a file path, a URL with a key or part of a record.
    It logs the op name and the error's class name. To read the full error, call `op.run` in a test.
  - It parses `result` with `op.output`. It returns `internal` when the parse fails or when
    `JSON.stringify(result)` is longer than `RESULT_MAX_CHARS`, which is 6,000.
  - It drops `detail` unless the caller asked for it.
- `requireProperty(ctx, id)` returns the `Property` or throws `not_found` with a hint that names
  `GET /api/properties`.
- `OpContext.call(name, input)` runs another op and resolves to `{result, detail}` typed as
  `unknown`. It throws the other op's `OpError`. The caller parses what it needs with a schema from
  `app/server/src/model/`. This phase declares `call`. [f2](phase-f2-ops-http.md) implements it.
- Change the `test` script in `app/server/package.json` to `node --test "src/**/*.test.ts"`, so
  that tests in subfolders run.
- Create `app/server/src/ops/op.test.ts` with one test per branch of `runOp`.

## Data structures

- `Op`: `{name, summary, effect: 'read' | 'write', input, output, detail?, run(ctx, input)}`, where
  `run` resolves to `{result, detail?}`.
- `OpEnvelope`: `{ok: true, result, detail?}` or `{ok: false, error: {code, message, hint}}`.
- `OpErrorCode`, derived from `OP_ERROR_CODES`: `invalid_input`, `not_found`, `not_ready` (a build
  step or a key is missing, and the hint names it), `no_data` (the source has nothing for this
  property), `upstream`, `conflict` (a write lost to a newer version) and `internal` (a bug).
- `OpContext`: `{properties, vexcel, dataDir, call}`. f5 adds `matterport`. f6 adds `buildingFacts`.
- `Source`: `costar`, `vexcel`, `scan`, `mesh`, `overture`, `maker` or `inferred`.
- `Confidence`: a number from 0 to 1. `Assumptions`: at most 8 sentences of at most 200 characters.

## Verification

1. Run `pnpm --dir app/server typecheck`.
2. Run `pnpm --dir app/server test`. `op.test.ts` passes, and the six tests in `server.test.ts`
   still run under the new glob.
3. Run `node docs/plans/01-propstar-tools/check-ownership.mjs --files <changed files> --lane
   foundation`.
