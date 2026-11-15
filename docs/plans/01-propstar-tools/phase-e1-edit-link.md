# Phase e1: Edit link

Part of [the plan overview](overview.md).

Lane C, edit track, phase 1, after the c phases. It depends on [f6](phase-f6-server-scaffolds.md)
and uses API port 8790. Read `tools/edit_api/README.md` in full first. It is the contract.

## Goal

The server reaches Mateo's edit API through one typed client. After this phase
[e2](phase-e2-edit-ops.md) writes each edit op against `createEditClient` and a fake.

## Changes

- Check four preconditions. `origin/main` is merged, so `tools/edit_api/` exists. `.env` holds
  `EDIT_API_URL` and `EDIT_API_TOKEN`, which Fahim adds and nobody prints. The laptop is on the
  campus VPN. Mateo's firewall lets the laptop in, which his log says is not checked yet.
- Run `node --env-file=.env tools/edit_api/client_test.ts --check` from the repo root. Record only
  `link ok` and `key ok` in `decisions-lane-c.tsv`, because the line holds the PC's address. Never
  drop `--check` or add `--save`. On a failure, report it, build on the fake and leave the PC be.
- Create `app/server/src/ops/edit/client.ts` with `createEditClient(edit)`. `edit` is `ctx.edit`,
  and its `path` is the edit API's own path, such as `/places/<modelId>`. Its methods `places()`,
  `place(modelId)`, `startEdit(body)` and `job(jobId)` parse with Zod, keep only the fields the
  ops use in camelCase and throw `upstream` when the parse fails.
- Create `editError(status, code)` in `client.ts`, the one map from an edit API error to an
  `OpError`. It reads `{error: {code}}`. A body that is not JSON gives the code `http_<status>`.
  - `edit_api_not_configured` is `not_ready`, and the hint names `EDIT_API_URL` and
    `EDIT_API_TOKEN`. `edit_api_unreachable` is `upstream`, and the hint says to join the VPN.
  - `bad_request` is `invalid_input`. `unknown_pano`, `unknown_job`, `unknown_place` and
    `not_found` are `not_found`. `busy` is `not_ready`, with a hint to retry when the queue is
    shorter.
  - `unauthorized`, `forbidden` and every other code are `upstream`. A message names a key name,
    never a value, and never holds a response body, a header or the API's own message.
- Create `app/server/src/ops/edit/fakeEdit.ts`. `fakeEdit(routes)` returns `{edit, calls}`, and
  `routes` maps a key such as `"GET /places/m1"` to a status and a JSON body.
- Create `client.test.ts` with invented answers. Test extra fields, every mapping row, a body with
  `SECRET-SENTINEL` that reaches no message or hint, a non-JSON 502 and a malformed answer.

## Data structures

- `EditPlace`: `{modelId, downloaded, hasMesh: boolean | null, panos: [{panoId, index, label,
  floor, position, rotation: [x, y, z, w]}]}`. `panoId` is the API's `id`.
- `EditJob`: `{jobId, status, queuePosition | null, stepCount, result: EditResult | null, error:
  {code} | null}`. `status` is `queued`, `fetching`, `running`, `done`, `failed` or `cancelled`.
- `EditResult`: `{stub, modelId, panos: [{panoId, index, position, rotation, faces, changed,
  verdict}], verdict, summary, skippedCount, singleView | null}`, from `report` and `skipped`.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`.
2. If the check printed both words, tell the main session. It ticks Output-Agent's open request.
3. Start the API on port 8790 and record its PID. Print the health route's status with
   `node -e "fetch('http://127.0.0.1:8790/api/edit/health').then(r => console.log(r.status))"`.
   It prints 200, 502 with no link or 503 with no keys. Stop the PID you recorded.
4. Run the ownership check with `--lane lane-c`.
