# Phase l1: Look page

Part of [the plan overview](overview.md).

Lane A, look track, phase 1. It depends on [f7](phase-f7-web-scaffolds.md). It uses web port 5174
and needs no API. Read `docs/design/design.md` and the art direction in the overview first.

## Goal

The dollhouse gets its camera, its lighting and its one look. After this phase a dev page draws
the three fixture buildings as grey prototype massing at the fixed isometric angle.

## Changes

- Create `app/web/src/dollhouse/looks.ts` with `DEFAULT_LOOK`, the one look. Its values are under
  Data structures. Fahim set the direction, so build it and do not stop to ask. Copy no asset,
  texture or palette from any game.
- Create `protoGrid.ts` with `protoMaterial(tone, look)`. It draws one 1 m tile into a 128 px
  canvas, the tone's `fill` plus a 2 px line in the tone's `line` on two edges, and wraps it in a
  `CanvasTexture`. Set `RepeatWrapping` on both axes, `SRGBColorSpace`, mipmaps and anisotropy 16,
  so the lines stay sharp at the camera's angle. Cache one `MeshStandardMaterial` per tone.
- Create `stage.ts` with `createStage(canvas, look)`. It builds an `OrthographicCamera` at the
  look's azimuth and elevation, a `HemisphereLight`, one `DirectionalLight` with `PCFShadowMap`
  and ambient occlusion from `n8ao` through `postprocessing`. The camera never orbits. The stage
  only zooms and pans, because the request is one fixed angle.
- The stage returns `{setLayers, resize, dispose}`. `dispose` stops the frame loop and frees
  every geometry, material, texture and render target.
- Create `massing.ts` with `massingParts(building)`, `buildMassing(building, look)` and `toScene`.
  `massingParts` is pure. It returns one part per shell volume, from `baseM` to `topM` in the
  `high` tone, and one per `context` entry, from 0 to its `heightM` in the `context` tone.
- `buildMassing` extrudes each part with `protoMaterial` and adds an `EdgesGeometry` outline in
  `palette.outline`. Every part casts shadows. Keep the geometry in metres, so that the UVs of
  `ExtrudeGeometry` are metres and one tile covers 1 m.
- `toScene(x, y, z)` is the one place that converts frames. The model is east, north, up, and
  three.js is y-up, so it returns `(x, z, -y)`.
- Create `look.html` and `lookPage.tsx` in the same folder. The page draws one canvas per entry
  of `FIXTURES`, which it imports from `../../../server/src/model/fixtures`. The dev server
  serves it at `http://localhost:5174/src/dollhouse/look.html`. The production build leaves it out.
- Create `massing.test.ts`. Check the part count for each fixture, that each part spans `baseM` to
  `topM` and that `toScene` maps north to negative z. The test runner has no canvas, so
  `protoMaterial` has no unit test. The check is the screenshot.

## Data structures

- `Look`: `{id, label, elevationDeg, azimuthDeg, wallStubM, roughness, palette}`. `DEFAULT_LOOK`
  has elevation 35.264, azimuth 45, `wallStubM` 0.3 and roughness 0.9.
- `palette`: `{background: '#0E0F11', outline: '#A1A7AE', wall: '#E6E4DE', cut: '#2A2D32',
  accent: '#3D8BDB', floors, furniture, proto}`.
- `floors`, by `FloorTone`: `work #D2B77C`, `meet #6F9BC0`, `living #C98A6B`, `wet #63B3A4`,
  `circulation #B9AE9E`, `storage #9C8AB8`, `other #A8B37A`.
- `furniture`: `wood #B58A5E`, `fabric #5E86B5`, `metal #9AA3AD`, `white #E6E4DE`,
  `green #6FA06B`.
- `proto`, by `ProtoTone`, each `{fill, line}`: `high #565B63 #8B929B`, `mid #43474E #6B717A`,
  `low #32353A #50555C`, `context #1F2226 #2A2D32`.
- `StageLayer`: `{id, object, onStorey?}`. `onStorey` is the storey index the layer belongs to.
  From [l2](phase-l2-cutaway.md) on, the stage hides a layer whose storey is not the one on show.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`.
2. Start the web app on port 5174 and record its PID.
3. Open the look page. Take one screenshot at 1440 by 900, save it to your scratchpad and check it
   against `docs/design/design.md`.
4. Count the grid cells along one fixture wall of known length. A 10 m wall shows 10 cells, and
   the lines are sharp. If they blur, raise the tile to 256 px before you change anything else.
5. Stop the PID you recorded. Run the ownership check with `--lane lane-a`.
