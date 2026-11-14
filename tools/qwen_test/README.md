# qwen_test

Benchmark: can a local image model (Qwen-Image) fill in the background after one item is removed
from a panorama crop? Owner: Mateo-Agent. Status: Qwen-Image-2.1 run at 4-bit and 8-bit on the three
`lamp_table` views, and at 4-bit with three input styles on `island_decor` and `corner_plant`
(results below). An agent stack (`agent_edit.py`: SAM 2.1 + Qwen3-VL as a chat model + the image
model) turns a typed request into an edit case over several panoramas; passing one view's edit to the
next view is under test (last results section).

Everything this folder generates (`cases/`, `outputs/`, `models/`, `bin/`, `.venv/`) is git-ignored,
because the crops are licensed scan imagery.

## Setup

```bash
py -3.12 -m venv tools/qwen_test/.venv
tools/qwen_test/.venv/Scripts/python -m pip install pillow numpy
```

Only for the agent stack (`agent_edit.py`, below): a second environment for the segmenter, the
llama.cpp server and the SAM weights. Install SAM 2 from Meta's repository; the `sam2` package on the
Python package index is a third-party upload.

```bash
py -3.12 -m venv tools/qwen_test/.venv-sam
tools/qwen_test/.venv-sam/Scripts/python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
tools/qwen_test/.venv-sam/Scripts/python -m pip install numpy pillow tqdm hydra-core iopath
curl -L -o sam2-main.zip https://github.com/facebookresearch/sam2/archive/refs/heads/main.zip && unzip -q sam2-main.zip
SAM2_BUILD_CUDA=0 tools/qwen_test/.venv-sam/Scripts/python -m pip install --no-build-isolation --no-deps ./sam2-main
bash tools/qwen_test/download_models.sh agent   # llama.cpp b12380 (CUDA 12.4) into bin/llama/, SAM 2.1 large into models/
```

## Build the test case

Needs the scan already downloaded under `data/` (see the top-level README). No API calls.

```bash
tools/qwen_test/.venv/Scripts/python -I tools/qwen_test/build_case.py --case lamp_table
```

Cases (all in scan `zzvymDx5ty7`, defined in `CASES` at the top of `build_case.py`):

| Case | Item | Views (0-based panoramas) | What it tests |
| --- | --- | --- | --- |
| `lamp_table` | floor lamp and side table against a wall | 1, 2, 4 | plain wall behind; the lamp's light and shadow |
| `island_decor` | two woven balls on the kitchen island | 4, 1, 0 | no wall behind: doors, kitchen or sofa depending on the side; other panoramas see 88–90% of the hidden background |
| `corner_plant` | tall plant in the corner behind the sofa | 4, 1, 7 | occluded by the sofa and cushions; leaves over curtain and blinds; no other panorama sees behind it |
| `sofa` | the sofa with its cushions (a 3D box, not cylinders) | 1, 4, 7 | large item; coffee table in front, door in front in panorama 7 |
| `sofa_pillows` | same shape as `sofa`; the edit recolours the teal pillows red | 1, 4, 7 | texture swap; the mask only limits where the result is pasted |

This writes `cases/<case>/`:

| File | What |
| --- | --- |
| `p<N>/target.png` | 1024×1024 perspective crop from panorama N (0-based manifest index), framed on the item |
| `p<N>/mask.png` | white = remove |
| `p<N>/preview.jpg` | crop with the mask tinted |
| `p<N>/prefill.png` | masked area filled with real pixels from other panoramas where they see the background; magenta = no panorama sees it |
| `p<N>/refs/ref_p<J>.png` | crops from the panoramas that see the most hidden background |
| `review.jpg` | all of the above on one sheet |
| `case.json` | camera poses, mask size, how much hidden background each panorama sees |

## How it works

- `pano.py`: perspective views from the cube-face panoramas (using the measured conventions in the
  manifest) and a brute-force numpy ray caster for the mesh.
- `build_case.py`: the item is described once in 3D as stacked vertical cylinders. Each view's mask is
  that shape projected into the view and dilated, so the masks agree across panoramas. The hidden
  background is found by ray casting the mesh with the item's triangles removed.
- `scout.py`: look around the scan to choose an item (`at X Y Z`, `view PANO YAW PITCH`, `hit ...`).

## Run the model

```bash
bash tools/qwen_test/download_models.sh q4    # runner + 4-bit files, about 11 GB
bash tools/qwen_test/download_models.sh q8    # 8-bit files, about 16 GB more
cd tools/qwen_test
.venv/Scripts/python run_qwen.py run --quant q4     # or q8; --variant plain|outlined|refs|prefill
.venv/Scripts/python run_qwen.py sheet              # outputs/lamp_table/comparison.jpg (--zoom: mask area only)
.venv/Scripts/python run_qwen.py grow --quant q8 --pcts 50 100 --match   # larger paste mask, tone-matched
.venv/Scripts/python -I paste_pano.py --view 1      # write those into copies of the cube faces
.venv/Scripts/python -I paste_pano.py --view 1 --export   # ...and add them to data/<model>/edits/
```

Another case goes before the subcommand: `run_qwen.py --case island_decor run --quant q4 --variant
prefill --views 4 1 0`, then `grow --quant q4 --variant prefill --views 4 1 0 --pcts 100 --match` and
`paste_pano.py --case island_decor --quant q4 --variants plain prefill --view 4 --pcts 100 --export`.

Input styles (`--variant`): `plain` sends only the crop. `refs` adds the raw crop from the panorama
that sees the most hidden background. `prefill` adds `prefill.png` (the crop with the masked area
patched from other panoramas, magenta where nobody sees it) and tells the model it is a rough guide.
`known_bg_error` in `results.json` is the mean difference (0-255) between the output and the prefill's
real pixels inside the mask; compare it between styles on one view, not as an absolute error.

With `--export`, the walk-through viewer (`tools/visualization/`) shows the edited photos: stand on
a panorama that has edits (the viewer counts from 1, so `--view 4` is panorama 5), switch to the photo
with `F`, and press `X` to step through the original and each edit set that changes that panorama.
Each set is the original photo with one item removed; sets do not stack. Only the photos change; the
3D render still has the items.

The runner is stable-diffusion.cpp (`sd-cli.exe`, release `master-1094-3bad892`, CUDA 12 build),
unpacked to `bin/sd/`. `run_qwen.py` calls it once per view with the crop as the reference image and
a text instruction, then pastes only the masked area of the output back into the crop.

## Agent stack: a typed request to an edit case

```bash
cd tools/qwen_test
.venv/Scripts/python -I agent_edit.py pick --name sofa_agent --pano 1 --yaw 215 --pitch -15 --fov 75 --text "remove the couch"
.venv/Scripts/python -I agent_edit.py views --name sofa_agent      # no VLM: finds the item in the other panoramas
.venv/Scripts/python run_qwen.py --case sofa_agent run --quant q4 --variant chain --views 1 4 6 7
```

`agent_edit.py all ...` runs pick, views, the `chain` edits, the +100% tone-matched paste and the
export for the viewer. The three models run one after another, so each has the GPU to itself.

| Step | Model | What it does | Time |
| --- | --- | --- | --- |
| 1 | SAM 2.1 large (`segment.py auto`) | cuts the view you are looking at into segments | 11 s |
| 2 | Qwen3-VL-8B as a chat model (`vlm.py`, llama.cpp server on 127.0.0.1:8081) | reads the request and the view; answers in JSON with a box around the thing, remove or change, what is behind it, and one instruction that every view's prompt shares | 5 s with server start |
| 3 | SAM (`segment.py prompt`) | outlines the object inside the box | 4.5 s |
| 4 | mesh (`lift.py`) | lifts the outline to 3D: rays through its pixels hit the mesh, and the item is stored as 5 cm voxels. For a removal, segments from step 1 that lie in the box and within 0.25 m of the item in 3D are added (loose pillows on a sofa) | 10 s |
| 5 | mesh + SAM | per other panorama: does it see the item, a crop framed on it, a mask from the mesh (first surface along the ray is an item voxel), sharpened by SAM | 5 s for 4 views |
| 6 | Qwen-Image-2.1 (`run_qwen.py`) | edits each view | 45-60 s per view |

Picking by numbered segments ("which of these 56 numbers is the couch") failed with the 8B model (it
listed numbers up to 79). Asking it for a box and letting SAM outline the object in the box works.

`--variant chain` edits the views in `case.json` order and gives each one the output of an
already-edited view as a second picture, kept at 768 px. `chain_both` also adds an unedited crop from
the panorama that sees the most of what the item hides.

## Results (2026-11-14, RTX 5070 Ti 16 GB, 1024×1024, 20 steps, cfg 6.0, `plain` variant)

| | 4-bit (Q4_K_M + Q4 text encoder) | 8-bit (Q8_0 + Q8 text encoder) |
| --- | --- | --- |
| Files on disk (image model + text encoder) | 8.9 GB | 15.6 GB |
| Whole call, including load | 45 s | 44 s |
| Sampling | 39.8 s | 35.8 s |
| Per step | 1.54 s | 1.50 s |
| Peak GPU memory | 15.4–15.7 GB | 15.3–15.5 GB |
| Where the weights sit | all on the GPU | image model on the GPU, text encoder and VAE in RAM |

- Both remove the lamp and table in all three views and draw a plausible wall, baseboard and floor.
  No visible quality difference between 4-bit and 8-bit on this case.
- The model returns the whole frame redrawn. Geometry stays put (best alignment is a 0 px shift), but
  it also removes the lamp's light and shadow on the wall and changes overall brightness (up to +10
  of 255). Pasting only the masked area back therefore leaves a visible patch, because the original
  outside the mask still has the lamp's light.
- Growing the paste mask (`run_qwen.py grow`, no new model runs, 8-bit outputs, 6 px feather): at
  +20% (edges out about 45 px) the patch is still obvious; at +50% (about 110 px, 37–42% of the crop)
  only a faint box edge remains on the wall, plus leftover lamp light on the side wall in panorama 4;
  at +100% (66–74% of the crop) it is hard to tell from the whole model output.
- Tone matching at the mask border (`grow --match`; the smooth correction used in Poisson blending,
  no model): at +50% the box edge is gone in all three views (mean correction 4–12 of 255); leftover
  lamp light outside the mask stays (side wall in panorama 4). At +20% the seam also goes, but the
  correction is large (9–26) and pulls the lamp's glow and shadow into the patch as a ghost.
- Written back into copies of the cube faces (`paste_pano.py`, +50% and +100% tone-matched):
  panorama 1 (crop 49° wide, about 21 px per degree against the panorama's 23) blends in with only
  slightly softer floor grain; +50% changes 2.1% of the panorama's pixels, +100% 3.9%. Panorama 4
  (crop 113° wide, about 9 px per degree, lamp 0.95 m away) is clean in a wide view but visibly soft
  up close: wall texture is lost and floor grain is blurred; +50% changes 14.6%, +100% 21.5%.
- Not run: the `outlined` variant, `--mask` inpainting, the Turbo sampler (8 steps).

## Results: harder cases and conditioning (2026-11-14, 4-bit, same settings, 18 runs)

- Two input images need the 4-bit model on a 16 GB card. 8-bit with one extra image: 187 s of
  sampling (9.4 s per step) because it runs out of GPU memory. 4-bit: 58 s of sampling (1.9 s per
  step), 66 s per call, peak 15.0 GB. One image at 4-bit: 40 s of sampling, 46 s per call.
- `island_decor` (nothing solid behind the item): all three styles remove both balls in all three
  views and continue the doors, the drawers and oven, or the sofa cushions behind them. No visible
  difference between styles. `known_bg_error` plain / refs / prefill: panorama 4: 24 / 25 / 25;
  panorama 1: 50 / 50 / 51; panorama 0: 34 / 34 / 31.
- `corner_plant` (occluded, unseen background): all three styles remove the plant and leave the sofa,
  the cushions and the flower arrangement in front of it intact, although the mask covers parts of
  them. The prefill is almost all magenta here (the plant fills the corner, so no panorama sees behind
  it; the 43-50% "seen" is mostly the sofa in front), and no magenta appears in any output. The
  curtain panel drawn behind the plant differs in width and in whether it has a dark edge, both
  between styles and between the three views of one style.
- The prefill itself is rough where the mesh is rough: on the island it smears a stretched oven over
  the drawers (panorama 1). The model did not copy that.
- Conclusion so far: conditioning on other panoramas did not improve these two cases. Where the
  background is visible elsewhere, the crop already had enough context; where it would matter (the
  plant), nobody sees the background. Not tested: a case where the hidden content cannot be guessed
  from the crop but is seen elsewhere, and conditioning one view on another view's output so that
  invented content agrees between panoramas.
- Written back at +100% tone-matched (`paste_pano.py`): no visible seam in any of the six views.
  Pixels changed: 0.9-4.1% of a panorama. The plant from panorama 4 (crop 70 degrees wide, about
  15 px per degree against the panorama's 23) is slightly soft on the blinds up close.

## Results: large item and recolour (2026-11-14, 4-bit, `plain`, 46-50 s per call)

- `sofa` removed in all three views: floor, baseboard and wall are continued, and the coffee table,
  the lamp and the door in front are kept. The plant's pot, which the sofa hid, is invented and
  differs between views (square, tapered, round). Pasted at +50% tone-matched (not +100%: a mask this
  large would reach the crop border): no visible seam; 0.9-11% of a panorama changes. Crops are 73
  and 78 degrees wide for panoramas 1 and 4, so the pasted area is softer than the panorama.
- `sofa_pillows` by the model: the teal pillows turn red in all three views, but the fabric pattern
  is lost (plain red), the painting on the wall is recoloured too in panoramas 1 and 4, and in
  panorama 7 grey pillows turn red as well. Pasting with the item mask at +0% keeps the painting
  change out of the panorama.
- `sofa_pillows` by hue shift (`recolor.py`, no model): a pixel changes only if its ray hits the mesh
  inside the sofa's box and its hue is teal (150-200 degrees). Pattern and shading are kept, the teal
  tray in front and the painting are untouched, it runs on the cube faces at full resolution, and the
  same rule gives the same red in every panorama. About 21,000 pixels change in panoramas 1 and 4.
- Finding from the plant case: the `prefill` output dropped a moss ball of the flower arrangement
  that stands in front of the plant (panorama 1). The mask covers it and the prefill patches it away,
  so the model followed the guide. The model does use the second image; the mask is the weak point.

```bash
.venv/Scripts/python -I recolor.py --case sofa_pillows --views 1 4 7 --export
```

## Results: passing one view's edit to the next (2026-11-14, `sofa_agent`, 4-bit, 20 steps)

Case: "remove the couch" typed while looking at panorama 1. Views chosen by how much of the item
each panorama sees: 1 (97%), 4 (74%), 6 (51%), 7 (49%); panoramas 2, 5 and 0 see 38%, 27% and 16%
and are not edited (cap of 4 views). View 1 is edited first; the tests below are all on view 4.

| Second (and third) picture given with view 4's crop | Wording | Sampling | Result |
| --- | --- | --- | --- |
| none (`plain`) | | 43 s | sofa removed, drift 12.5 |
| view 1's edit + unedited view, both enlarged to 1024 by the runner | "the first / second / third image" | 197 s | returns view 1's picture, not view 4 (drift 73.6) |
| same two, kept at 768 | same | 127 s | same failure (72.7) |
| view 1's edit alone, 1024 | same | 94 s | same failure (60.2) |
| view 1's edit + unedited view, kept at 768 | `image1`, `image2`, `image3` | 128 s | view 4 kept, sofa removed; floor darker with a fine grid pattern (30.5) |
| same two, kept at 512 | same | 48 s | same as the row above (29.4) |
| view 1's edit alone, kept at 768 (`--variant chain` now) | `image1`, `image2` | 43-48 s | view 4 kept, sofa removed, clean (18.3-19.0) |
| view 4's own crop with the sofa's area filled from view 1's edit through the mesh | `image1`, `image2` | 53 s | view 4 kept, sofa removed, clean, no magenta or blocky edges (13.5) |

"Drift" is the mean difference (0-255) between output and crop outside the mask; the clean edits in
this case are between 9 and 19.

- A picture of the same room from another position that already shows the finished edit is a trap:
  with "the first image / the second image" wording the model returned that picture instead of editing
  the crop (3 of 3 runs on view 4). In view 6, whose framing is very different, the viewpoint was
  kept but a coffee table from the other picture was drawn where view 6 cannot see one.
- Naming the pictures the way the model's prompt template tags them (`image1`, `image2`) and saying
  "the result is image1 seen from image1's own camera position" fixed it on view 4 (4 of 4 runs).
- The runner enlarges every input picture to the output size unless `--ref-image-args
  resize_before_vae=0` is passed (an undocumented switch; no weights change). `run_qwen.py` passes it
  for the `chain` variants, so context pictures stay at `CONTEXT_PX`.
- `--offload` (weights in RAM between stages) did not help three full-size pictures: 197 s of
  sampling with it (view 4) and 209 s without (view 6), both at a 15 GB peak.
- The unedited view as a third picture made the result worse here (darker floor, grid pattern), at
  512 px as well as 768 px.
- Last row (scratch test, not in `run_qwen.py` yet): the mesh carries view 1's edited pixels into
  view 4's masked area, so the guide has view 4's own viewpoint and copying it is correct. The mesh
  has a hole behind the sofa (rays through the removed sofa reach a surface for only 39% of the
  masked area), so missing rays stop at the floor or the nearest wall plane read off the mesh; 82% of
  the area is then filled from view 1's edit, against 4% from unedited panoramas.
- The plain run also draws a black square planter behind the sofa in view 4, like view 1's edit, so
  this case does not show whether the second picture improved agreement between views.

## Known limits

- Masks ignore occluders in front of the item. The model kept the sofa in front of the plant, but a
  thin occluder may not survive (panorama 0 sees the lamp through the kitchen faucet, so that view is
  left out).
- With every variant except `chain`, each panorama is edited on its own, so content the model invents
  (the curtain behind the plant) can differ from one panorama to the next.
- The cylinder outline is loose; it removes more background than a tight segmentation would.
- Visibility numbers depend on the mesh, which is rough on thin and glass objects.
