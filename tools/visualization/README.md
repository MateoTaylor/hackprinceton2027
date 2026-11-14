# tools/visualization

Look at a downloaded Matterport scan in the browser: walk through the textured mesh and compare it
with the panorama photos from the same spot. No build step, no dependencies beyond Python's standard
library (three.js 0.170 loads from the jsdelivr CDN, so the first load needs internet).

## Run

```bash
py tools/visualization/serve.py            # then open http://localhost:8000/
py tools/visualization/serve.py --port 8001
```

It needs a scan in `data/<model id>/` (see "Get a scan" in the repo README). The model picker reads
`data/index.json`; `?model=<id>` picks one directly. The address bar keeps your pose, so a URL can
be shared with a teammate who has the same data.

## Pages

- **`/` (walk-through, `index.html`)**: two views that share one camera.
  - **Panorama photo**: the real photo, pinned to where it was taken. Look only.
  - **3D render**: the MatterPak mesh with its own textures, unlit. Walk anywhere.
- **`alignment.html`**: checks that panoramas and mesh line up, and re-measures the panorama
  conventions on a new model (Detect faces, Detect yaw).

## Walk-through controls

| Input | Action |
| --- | --- |
| `F` or the View button | Switch between panorama photo and 3D render, same position and direction |
| hold `Space` | Peek at the other view |
| `W` `A` `S` `D` | Walk (in photo view this switches to the 3D render first) |
| `Shift` | Walk 3× faster |
| `Q` / `E` | Down / up |
| `R` | Back to the scan's camera height |
| drag, arrow keys | Look around |
| mouse wheel | Zoom (field of view 20–110°) |
| `L` | Mouse look with a locked pointer (`Esc` leaves) |
| `1`–`9`, `[` `]`, a floor ring, a panel number | Go to that panorama, in photo view |
| `C` | Compare at a panorama: off → blend → split wipe (drag the divider) |
| `M` | Surface: textured → untextured (normals) → wireframe |
| `B` | Cull back faces |
| `T` | Raw texels (no smoothing when magnified) |
| `P` | Floor markers on / off |
| `H` | Hide all panels |
| `X` | Photo version: original, then each edit set that changes this panorama (only when `data/<model>/edits/index.json` exists) |

Switching to the photo after walking snaps to the nearest panorama and says which one. Keys are
ignored while a form control has focus. The top-right readout shows position (scan frame, meters),
heading, nearest panorama, FPS, triangle count and the texture maps with their pixel sizes.

In the browser console, `walk` exposes the same actions for scripting, for example
`walk.goTo(4)`, `walk.look(270, -10)`, `walk.moveTo([x, y, z])`, `walk.pose()`, `walk.info()`.

## Files

| File | What |
| --- | --- |
| `serve.py` | Localhost-only static server. Serves this folder and `data/`, nothing else |
| `index.html` | Walk-through page (markup and styles) |
| `js/walk.js` | Walk-through logic |
| `js/scan.js` | Shared: data paths, panorama conventions and shader, manifest / texture / mesh loading |
| `alignment.html` | Alignment checks (uses `js/scan.js`) |

`serve.py` binds 127.0.0.1, refuses any path with a dot-prefixed part, and returns 404 for anything
outside `tools/visualization/` and `data/`, so `.env` and the rest of the repo are never served.
Don't replace it with `python -m http.server` from the repo root.

## Known limits

- No collision: you can walk through walls and furniture.
- "Nearest panorama" is straight-line distance and ignores walls.
- Presets are grouped by Matterport room id as Room A/B/C; the scan has no room names.
- Memory: the full mesh's 18 texture maps (2048×2048 each) take about 400 MB on the GPU, plus about
  100 MB for each cached panorama (up to 3). The 33 MB OBJ takes a few seconds to parse.
- The walk-through uses the measured panorama conventions as fixed values. If a new model looks
  rotated, check it in `alignment.html`.
- Only checked on model `zzvymDx5ty7` in a Chromium browser.
