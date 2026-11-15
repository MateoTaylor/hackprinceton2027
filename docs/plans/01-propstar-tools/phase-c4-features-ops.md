# Phase c4: `features_get`

Part of [the plan overview](overview.md).

Lane C, features track, phase 1. It depends on [f5](phase-f5-upstream-clients.md). It uses API
port 8790 and web port 5176. Read `docs/design/design.md` before you fill the panel.

## Goal

A model or a user reads what Vexcel sees on the property from the air, and when. After this phase
`features_get` returns the newest capture's grouped attributes and the Features panel shows them.

## Changes

- Create `app/server/src/ops/features/groups.ts` with `FEATURE_GROUPS`, an ordered list of `{group,
  prefix}`. The groups are `pool`, `roof-characteristics`, `roof-objects`, `roof-defects`,
  `building-type`, `vehicles` and `parcel-tree-cover`, each with its name and a dot as the prefix.
  Its `groupAttributes(attributes)` returns them in that order with keys sorted. It drops nulls and
  keys that match no group, and leaves empty groups out.
- Replace the stub in `app/server/src/ops/features/index.ts`. `features_get` calls
  `requireProperty`, then `ctx.vexcel.extract(lat, lon, {include})` with `precomputed` and
  `calculated` in the form f5 defines, and no `bufferM`. It uses the newest capture by
  `capturedAt`, and on a tie the feature with `primary` true.
- Turn `UpstreamError` into `upstream`, with the status only and the hint "Vexcel did not answer.
  Try again in a minute." No attribute after grouping throws `no_data` with the hint "Vexcel has no
  attributes at this point. Try a property with a larger building."
- `result` carries the first 40 attributes and `omittedCount`. `detail.groups` carries them all.
- Every result sets `source: 'vexcel'` and lists these assumptions. "Attributes come from the Vexcel
  capture of `<capturedAt>`." "Vexcel derives them from aerial imagery, so they can lag the
  building." "Vexcel has no roof age field."
- Create `features.test.ts` beside it with a fake `vexcel` and invented features. Check that the
  newest capture wins when listed second, that stray keys, nulls and empty groups drop, the
  `no_data` and `upstream` cases, and that 200 attributes stay under `RESULT_MAX_CHARS`.
- Fill `app/web/src/features/FeaturesPanel.tsx` with `useOp('features_get', {propertyId})`. Show the
  capture date as a caption under the title and one `--surface-2` card per group. A row shows the
  key without its prefix, dashes as spaces, and the value. Booleans read "Yes" or "No" and numbers
  keep at most two decimals. The assumptions sit at the foot. The CSS lives in `features.css`.

## Data structures

- `FeatureGroupId` is a `group` of `FEATURE_GROUPS`. `FeatureValue` is a string, number or boolean.
- `features_get` input `{propertyId}`. Result: `{capturedAt, groups: [{group, attributes: [{key,
  value}]}], omittedCount, source, assumptions}`. `detail`: `{groups}`, complete.

## Verification

1. Run `pnpm typecheck` and `pnpm test` with `--dir app/server`, then with `--dir app/web`. Start
   the API on port 8790 and the web app on port 5176. Record both PIDs.
2. Run `node docs/plans/01-propstar-tools/probe-op.mjs features_get propertyId=commercial-248243
   --port 8790`, then with `propertyId=nope`, which exits 1 with `not_found`. Record the printed
   lines in `decisions-lane-c.tsv`.
3. Open the Features panel for `commercial-248243`. Take a screenshot at 1440 by 900, save it to
   your scratchpad and check it against `docs/design/design.md`.
4. Stop both PIDs. A reviewer subagent from the main session takes the lane C diff after this.
5. Run the ownership check with `--lane lane-c`.
