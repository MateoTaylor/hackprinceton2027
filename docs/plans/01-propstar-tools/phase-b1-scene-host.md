# Phase b1: Scene host

Part of [the plan overview](overview.md).

Lane B, scene track, phase 1. It depends on [f7](phase-f7-web-scaffolds.md). It uses API port
8789 and web port 5175. Read `docs/design/design.md` and run the **frontend-design** skill first.

## Goal

After this phase a user picks a demo space, a kit scan or the property's own scan, looks around
it in the Scene panel, and the lane holds one handle on the viewer's three.js scene.

## Changes

- Create `app/web/src/scene/host.ts` with `mountScene(container, spaceId)`. It reads the key from
  `GET /api/scene/config`, mounts `@matterport/webcomponent` and resolves to a `SceneHandle`. Take
  the element name, its attributes and the way to reach the Scene context from the package README
  in `app/web/node_modules/@matterport/webcomponent`. Do not guess an attribute.
- Keep the key in a local variable inside `mountScene`. It never enters React state, a prop, a log
  or an error message. On a 503 the panel shows "The Showcase key is not set. Add MP_SDK_KEY to
  .env."
- `meshes()` returns every `Mesh` in `scene` whose geometry has a `boundsTree`. `mountScene`
  resolves once that count is above zero and equal on two checks 500 ms apart.
- The viewer bundles three r184. Build every object for its scene with `handle.three`. Create
  `app/web/src/scene/imports.test.ts`. It fails when a file in `app/web/src/scene/` imports
  `three`, `three/addons` or `three-mesh-bvh` without `import type`.
- Create `app/web/src/scene/spaces.ts` with `SPACES` and `isSpaceId`, which tests
  `^[A-Za-z0-9]{11}$`.
- Fill `app/web/src/scene/ScenePanel.tsx` with a space picker and the viewer. The picker lists
  `SPACES`, then each entry of `property.scans` by `name`. A new pick calls `dispose()` on the old
  handle first. A status line shows the mesh and triangle counts. Keep the CSS in `scene.css`.
- Scan geometry stays in the browser. Nothing here writes it to disk or sends it anywhere.

## Data structures

- `SceneHandle`: `{three, scene, camera, renderer, meshes(), dispose()}`. `three` is the viewer's
  module, typed `typeof import('three')`. `dispose` removes the element and its listeners.
- `SpaceEntry`: `{id, label, kind: 'demo' | 'kit' | 'property'}`. `SPACES` holds `L3sdz2m7jxp`
  (plant, demo), `18TRzZNyxvU` (office, demo), `35LT5s1GSfA` (kit scan, untried) and
  `2rPahZzW6H7` (kit scan of a building from outside, untried).
- The Signage panel opens the selected property's own scans (`property.scans`), not a fixed scan.
- The frame of `handle.scene` is the scene frame, stated as Y up in
  [b2](phase-b2-scene-document.md). Check which axis is up and record it in `decisions-lane-b.tsv`.

## Verification

1. Run `pnpm --dir app/web typecheck` and `pnpm --dir app/web test`.
2. Start the API on port 8789 and the web app on port 5175. Record both PIDs.
3. Run `node -e "fetch('http://127.0.0.1:8789/api/scene/config').then(r =>
   console.log(r.status))"`. It prints 200. Print the status only, never the body.
4. Open `http://localhost:5175`, select `commercial-248243` and open the Scene panel. Use
   `browser_take_screenshot` only. No DOM snapshot, console read or network log.
5. Pick the plant and take a screenshot at 1440 by 900. The status line reads 27 meshes and about
   1,030,018 triangles. Pick the office. It reads 35 meshes.
6. Pick `35LT5s1GSfA` and record whether it opens. If it fails, remove it from `SPACES`.
7. Pick `2rPahZzW6H7`, look at the building from outside and take a screenshot. Record whether it
   opens and whether the mesh count is above zero. If it fails, set `EXTERIOR_SPACE_ID` to the
   plant, record that, and tell the main session.
8. Check the screenshots in your scratchpad against `docs/design/design.md`. Stop both PIDs. Run
   the ownership check with `--lane lane-b`.
