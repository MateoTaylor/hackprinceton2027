# Phase l4: Inferred style

Part of [the plan overview](overview.md).

Lane A, look track, phase 4. It depends on [l3](phase-l3-furniture-kit.md). It uses web port 5174.

## Goal

A viewer can tell scanned space from generated space without reading a word. After this phase
scanned space is in colour, every inferred space is grey with the sharp 1 m prototype grid, and a
legend says what the two styles mean.

## Changes

- Create `app/web/src/dollhouse/inferredStyle.ts` with the pure `protoTone(confidence)` and with
  `styleFor(source, confidence, look)`. `styleFor` returns the floor, wall and furniture
  treatment for a space.
- A space with `source: 'scan'` keeps the colours from [l2](phase-l2-cutaway.md) and
  [l3](phase-l3-furniture-kit.md): the floor colour of its use, light walls and coloured
  furniture.
- A space with `source: 'inferred'` gets `protoMaterial(protoTone(confidence), look)` from
  [l1](phase-l1-look-page.md) on its floor. Its wall stubs and its furniture take the tone's
  `line` grey, with no colour.
- Everything stays fully opaque with solid outlines. The difference is colour against grey and
  flat against grid, so no transparency and no dashed line is needed.
- Lower confidence gives a darker grid. Use the three tones and not a smooth ramp, because small
  differences in tone do not read.
- A furnishing follows the space it stands in. In `buildFurnishings`, an instance in an inferred
  space gets the grey from `styleFor` through `setColorAt`, so the kit still draws once per kind.
- Use `styleFor` in `buildStorey` and `buildFurnishings`. `protoMaterial` already caches one
  material per tone, so the number of draw calls stays flat.
- Create `Legend.tsx` with two swatches, "Scanned" and "Inferred", and the share of the building
  that is inferred. The "Inferred" swatch draws the grid with a CSS `linear-gradient`, in the
  `high` tone's two greys. The share comes from `result.inferredShare` of `building_get`. On the
  look page, pass a fixed number.
- Put the legend's CSS in `dollhouse/dollhouse.css` and import it from the component.
- If time runs short, the overview cuts the legend first. Keep the grid.
- Create `inferredStyle.test.ts`. Check `protoTone` at 0, 0.19, 0.2, 0.39, 0.4 and 1.

## Data structures

- `SpaceStyle`: `{floor, wallColor, furnitureColor: string | null}`. `floor` is a three.js
  material. `furnitureColor: null` means each furnishing keeps its kit colour.
- `CONFIDENCE_STEPS`: `[0.2, 0.4]`. A confidence of 0.4 or more is `high`, 0.2 or more is `mid`
  and anything lower is `low`.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`.
2. Start the web app on port 5174 and record its PID.
3. Open the look page on the office tower, which has one scanned storey, and on the apartment,
   which has one scanned unit. Take one screenshot of each at 1440 by 900 and save them to your
   scratchpad.
4. Check both screenshots yourself. The scanned part is the only part in colour, the grid lines
   are sharp and the three greys differ. If two greys read as one, widen the gap between their
   `fill` values in `looks.ts`. Record the change in `decisions-lane-a.tsv`.
5. Stop the PID you recorded. Run the ownership check with `--lane lane-a`.
