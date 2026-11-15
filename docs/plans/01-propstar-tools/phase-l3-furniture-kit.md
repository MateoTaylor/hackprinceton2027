# Phase l3: Furniture kit

Part of [the plan overview](overview.md).

Lane A, look track, phase 3. It depends on [l2](phase-l2-cutaway.md). It uses web port 5174.

## Goal

Every furnishing kind has one model and one colour, so a desk looks the same in every room of
every building. After this phase the look page shows furnished storeys and a sheet of the kit.

## Changes

- Download Kenney's Furniture Kit and Factory Kit, which are CC0. Unpack each archive into its own
  new, empty directory in your scratchpad. Run nothing from inside those directories.
- Copy only the GLB files that `KIT` names into `app/web/public/kit/`. Add `LICENSE.txt` there
  with the kit names, the author and the CC0 statement. Keep the folder under 5 MB.
- Create `app/web/src/dollhouse/kit.ts` with `KIT`, `loadKit(look)` and
  `buildFurnishings(storey, kit)`.
- `KIT` has one entry for every kind in `FURNISHING_KINDS`. An entry names a GLB file or a
  function that builds the shape from boxes and cylinders. The kits have no racking, pallets or
  conference tables, so `rack`, `pallet` and `conference_table` are built shapes.
- `loadKit` loads each GLB once with `GLTFLoader`. It merges the model's meshes into one
  geometry with `mergeGeometries` and drops the kit's own materials, so the kit's palette never
  shows. It scales each model so that its footprint matches the entry for its kind in
  `FURNISHING_FOOTPRINTS`. The server placed the furnishings by those footprints, so a model at
  another size would cross a wall.
- `buildFurnishings` returns one `InstancedMesh` per kind, as a `StageLayer` with `onStorey` set.
  Each instance sits at the furnishing's `at` and `yawDeg`. All kinds share one white
  `MeshStandardMaterial` at `look.roughness`. `setColorAt` gives each instance the colour
  `look.palette.furniture[entry.tone]`.
- Add the furnishings to `buildCutaway`. Add a kit sheet to the look page that draws one of each
  kind in a row with its name.
- Create `kit.test.ts`. Check that `KIT` covers every kind, that every GLB file it names exists
  under `app/web/public/kit/` and that each built shape fills its footprint within 5%.

## Data structures

- `KitEntry`: `{kind, tone, file}` or `{kind, tone, build}`. `tone` is a key of
  `palette.furniture`. `file` is a name under `public/kit/`. `build` returns a `BufferGeometry`
  in metres with its origin at the centre of the footprint.
- `Kit`: a map from a kind to `{geometry, tone}`, ready to instance.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`.
2. Print the number of files in `app/web/public/kit/` and their total size. Record both in
   `decisions-lane-a.tsv`.
3. Start the web app on port 5174 and record its PID.
4. Open the look page. Take one screenshot of the kit sheet and one of a furnished storey at 1440
   by 900, and save them to your scratchpad. Every model takes its colour from
   `palette.furniture`, and all share one scale.
5. Stop the PID you recorded. Run the ownership check with `--lane lane-a`.
