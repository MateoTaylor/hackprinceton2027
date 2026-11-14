# Propstar interactions

Owner: Fahim-Agent. Interactions that the static Paper screens cannot show: motion, timing, hover
and focus states. One section per interaction. Each one says what triggers it, what the user sees,
how we could build it, and how we know it is done.

## Scan card hover: slow rotate

The sidebar property cards show an image on top and text below. Cards for properties with a
Matterport scan carry a small icon-only 3D-scan badge at the bottom left of the image. Hovering the
image previews the scan.

### Trigger

- The pointer rests on a card's image, or the card receives keyboard focus.
- An intent delay of 150–250 ms (start at 200 ms) must pass first, so scrolling the list past a
  card does not start it. Leaving before the delay ends cancels it.
- Only cards with a scan respond. Cards without the badge do nothing.

### Behaviour

1. The static thumbnail crossfades (about 300 ms) to a dollhouse view of that property's scan.
2. The dollhouse slowly orbits around the vertical axis, one full turn in 20–30 s (start at 24 s).
   The rotation eases in from rest over about 1 s; it never starts at full speed.
3. On pointer leave or blur, the rotation eases out (about 500 ms) and the view crossfades back to
   the thumbnail.
4. Only one card animates at a time. Starting a new card stops the previous one at once.
5. With `prefers-reduced-motion: reduce`, nothing rotates: the thumbnail crossfades to a still
   dollhouse frame, and back on leave.
6. If the scan view is not ready when the delay ends, the thumbnail stays put. No spinner on the
   card; the preview simply appears when it is ready, or not at all.

### Implementation options

| Option | How | Cost |
| --- | --- | --- |
| (a) Showcase SDK embed | Mount the SDK viewer lazily on hover, switch to dollhouse mode, drive a slow camera rotation. `MP_SDK_KEY` is in `.env`. | Each embed is an iframe that loads the full Showcase app: expect seconds of spin-up, not milliseconds, so the preview often arrives after the user has moved on. Keep one live embed at most; several at once will stutter. The key only works on `localhost` (see `tools/smoke/README.md`). Exact SDK calls for dollhouse mode and camera rotation are **to verify** against developer.matterport.com. |
| (b) Pre-rendered loop | Offline, render each scan's dollhouse orbit once into a short looping video or a sprite of frames, saved under `data/`. The card plays it on hover. | Cheapest at runtime: instant start, smooth, no iframe, any number of cards. Costs an offline render step per model and some disk. The still frame for reduced motion comes free. |
| (c) Our own three.js viewer | Load the downloaded MatterPak mesh into a small three.js canvas and orbit it. Same stack as the fly-through. | Needs the MatterPak mesh, which `tools/fetch_matterport.py` gets only for models whose bundle is already unlocked (checked so far: `zzvymDx5ty7`). Parsing and uploading a full textured mesh per hover is heavy, and many WebGL contexts in a list are fragile. |

**Recommendation: (b), pre-rendered loops.** It is the only option that starts inside the intent
delay and stays smooth while the list scrolls, and it keeps the card a plain `<video>` or image.
Generate the loops with an offline script that drives the same dollhouse orbit through the SDK
viewer from (a), or through the three.js viewer from (c) where a mesh exists. Cards without a loop
fall back to the static thumbnail. Keep (a) for the property detail view, where one live embed is
worth its load time.

Rules that apply to every option:

- All scan data and rendered loops stay on the laptop under the git-ignored `data/`, served by our
  `localhost` server. Never commit them or put them on a CDN.
- Nothing calls `unlockModelBundle` or anything else that spends money. Option (c) uses only bundles
  that are already unlocked.
- Confirm with a Matterport mentor that capturing frames from the viewer for local use is allowed
  (to verify).

### Acceptance criteria

- [ ] Scrolling the list quickly past cards starts no preview.
- [ ] Resting on an image for the intent delay starts the crossfade; leaving earlier starts nothing.
- [ ] Keyboard focus on a card starts the preview; blur stops it.
- [ ] One full turn takes 20–30 s, with a visible ease-in and ease-out.
- [ ] At most one card animates at any moment.
- [ ] With reduced motion on, the card shows a still dollhouse frame and nothing rotates.
- [ ] Cards without a scan or without a ready preview keep the static thumbnail, with no spinner.
- [ ] The network tab shows only `localhost` requests during hover, and no `unlockModelBundle` call.
