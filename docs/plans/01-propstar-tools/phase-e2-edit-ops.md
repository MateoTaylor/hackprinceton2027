# Phase e2: Edit ops

Part of [the plan overview](overview.md).

Lane C, edit track, phase 2. It depends on [e1](phase-e1-edit-link.md) and uses API port 8790.

## Goal

A model starts an edit of a scan from a sentence and follows the job to its end. After this phase
[e3](phase-e3-edit-panel.md) and the deep agent call three ops, and no picture enters a model.

## Changes

- Fill the stubs in `app/server/src/ops/edit/index.ts` with `createEditClient(ctx.edit)`. Leave
  every failure to `editError`. Id inputs match `^[A-Za-z0-9_-]+$`, so none can alter a path.
- `edit_places` (read), input `{propertyId}`. No scans throws `no_data`. It calls `place(modelId)`
  for every scan in parallel. `result` holds `scanCount` and the first 3 scans as `{modelId,
  downloaded, hasMesh, panoCount, panos}`, with at most 20 panoramas of `{panoId, index, label,
  floor}` each. `detail.scans` holds every scan and panorama, with `position` and `rotation`.
- The API answers a scan it has not downloaded with `downloaded: false`, `has_mesh: null` and no
  panoramas. Report it so, with `panoCount: 0` and "Scan <modelId> is not on the edit PC yet."
- `edit_start` (write), input `{propertyId, modelId, panoId, yawDeg, pitchDeg, fovDeg = 70,
  command, preset?}`. `pitchDeg` is -89 to 89, `fovDeg` 30 to 120, `command` 3 to 300 characters
  and `preset` `720`, `fast`, `draft` or `quality`. A `modelId` outside `scans` is `invalid_input`.
- Post `{place: {model_id}, start: {pano_id, yaw, pitch, fov}, command, preset}`, without `preset`
  when absent. Never send `property_id`, because the PC answers 501 for it. No CoStar field goes
  into the request. `result` is `{jobId, status, queuePosition, assumptions}`. The assumptions say
  yaw and pitch use the API's world frame (Z up, `yaw = atan2(forward.y, forward.x)` in degrees).
- `edit_get` (read), input `{jobId}`. `result` is `{jobId, status, queuePosition, stepCount,
  verdict, summary, changedPanoCount, changedFaceCount, singleView, skippedCount}`, the last six
  null until `done`. `summary` is `report.summary`, which also explains a job that found nothing.
  `detail` is `EditGetDetail`, with every face path rewritten to start with `/api/edit`.
- A failed job throws the op code `editError` gives its `error.code`. A `fix` verdict adds "The
  check is loose, so look at the pictures." A stub result adds "This is a stub case."
- An edit takes 5 s to 9 min, so both summaries say to poll `edit_get`. No op branches on a step
  name or returns picture bytes. `interruptOn` covers `edit_start`.
- Create `index.test.ts` with `fakeEdit`. Test `no_data`, both caps, an undownloaded scan, an
  unknown `modelId`, the exact posted body, the face prefix, an empty result, a failed job, and
  that 3 scans of 20 panoramas with 8-character labels fit `RESULT_MAX_CHARS`.

## Data structures

- `EditGetDetail`: `{modelId, panos: [{panoId, index, position, rotation, faces: string[6],
  changed: number[], verdict}]}`. `changed` lists face numbers from 0 to 5.

## Verification

1. Run `pnpm --dir app/server typecheck` and `pnpm --dir app/server test`. Start the API on port
   8790 and record its PID.
2. Run `node docs/plans/01-propstar-tools/probe-op.mjs edit_places propertyId=commercial-248243
   --port 8790 --show result.scans.0.downloaded`. Until it prints `true`, try other ids with scans.
3. Probe `edit_get jobId=nope`. It exits 1 with `not_found`, or `not_ready` or `upstream` offline.
4. Only with the link up, probe `edit_start` with a remove command, then `edit_get` every 30 s
   until it ends. Record each status and the counts in `decisions-lane-c.tsv`. Stop the PID.
5. Run the ownership check with `--lane lane-c`.
