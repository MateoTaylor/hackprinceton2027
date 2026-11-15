# Edit API

The web app runs on another laptop. It uses this API to send edit commands into the scan edit
pipeline on Mateo's PC, and gets the edited panoramas back as cube faces with each panorama's pose,
so it can put them back in place.

A command carries a **place** (a Matterport scan), a **start** (one panorama of that scan and the
direction the user was looking) and a **command** in words ("remove the throw pillows from the bed").
The API downloads the scan if this PC does not have it, runs the edit, turns the edited views back
into cube faces, and serves them.

**State: Phase 2.** Edits run the real pipeline: Mateo-Agent's `all_views` graph on
`127.0.0.1:2025`, which edits the starting view and then every other panorama that sees the thing
(up to four views). Results say `"stub": false`. The contract is the one the stub served, plus
`skipped`, `single_view` and a `preview` that is null when nothing was edited.

Owner: Output-Agent. Python 3.12, FastAPI, port **2026**.

## For the web app (Fahim-Agent): start here

1. **Get the address and the key from Mateo**, privately. Put them in the repo-root `.env` on the
   web app laptop. They never go in code, logs, commits, screenshots or `AGENT_COMMS.md`.

   ```
   EDIT_API_URL=http://<the PC's address>:2026
   EDIT_API_TOKEN=<the key>
   ```

2. **Join the campus VPN, then test the link** from the repo root. It needs only Node 24:

   ```
   node --env-file=.env tools/edit_api/client_test.ts --check
   node --env-file=.env tools/edit_api/client_test.ts
   ```

   The first prints `link ok` and `key ok`. The second runs one edit and prints each step and the
   result. When something fails, it says which part: the address, the key, or the caller's address.
3. **Call the API from the Hono server, not from the browser.** `proxy.ts` forwards `/api/edit/*`
   to the PC and adds the key on the server, as the server already does with the Vexcel key. It
   uses web standards only and needs no package. Copy it into `app/server/src/` or import it, and
   add one route in `createApp`:

   ```ts
   app.all('/api/edit/*', (c) =>
     forwardEdit(c.req.raw, { base: process.env.EDIT_API_URL, key: process.env.EDIT_API_TOKEN }))
   ```

   Vite already sends `/api` to the Hono server, so the browser puts `/api/edit` in front of every
   path in this README: `POST /api/edit/edits`, `new EventSource('/api/edit/edits/<id>/events')`,
   and `<img>` or three.js `TextureLoader` on `'/api/edit' + url` for any picture URL in a result.
   Without the two `.env` names the route answers 503 `edit_api_not_configured`. With the PC out of
   reach it answers 502 `edit_api_unreachable`.
4. **Send** the Matterport model id the fly-through shows as `place.model_id`, and the sweep the
   user stands in as `start.pano_id` (its `id` or `location_id` from `GET /places/{model_id}`). Send
   the direction they look along as world-frame `yaw` and `pitch` (see The frame), and their words as
   `command`.
5. **Show progress** from the event stream: `status`, then `step` events with `pano` and `view`.
   The `plan` step's `chosen` event lists the panoramas the edit will reach, so you know how many
   views are coming. Then **draw the result**: each changed panorama's six faces on a cube at its `position`, turned
   by its `rotation` (The frame has the three.js steps).
6. **Show the pictures whatever the verdict.** `fix` comes often on right pictures, because the
   pipeline's check is loose and misreads things. When the pipeline finds nothing to edit, `panos`
   is empty, `preview` is null, and `report.summary` and `single_view` say why. Tell the user and
   let them rephrase.

The questions at the end of this README are still open. The API follows the default given with
each one.

## Run it (Mateo's PC)

```
py -3.12 -m venv tools/edit_api/.venv
tools/edit_api/.venv/Scripts/python -m pip install -r tools/edit_api/requirements.txt
tools/edit_api/.venv/Scripts/python tools/edit_api/server.py --make-token
```

`--make-token` writes a random `EDIT_API_TOKEN` into `.env` if it has none, and never prints it. In
Claude Code, start the server with `preview_start` name `edit-api` (`.claude/launch.json`). By hand,
run `tools\edit_api\.venv\Scripts\python tools\edit_api\server.py` (the graph runner, the
default). The edit graph's Agent Server on `127.0.0.1:2025` must be running (Mateo-Agent's
`tools/edit_agent/`). `--runner stub` serves finished cases instead, with no GPU, marked `"stub": true`.

| `.env` name | Meaning |
| --- | --- |
| `EDIT_API_TOKEN` | The API key, 24 characters or more. Required. Share it with the web app's laptop privately, never in chat, git or notes. On the web app laptop, the same name holds the same key, and the Hono server sends it |
| `EDIT_API_URL` | **Web app laptop only:** `http://<the PC's address>:2026`, from Mateo |
| `EDIT_API_HOST` | The second address to bind, besides `127.0.0.1`: this PC's Wi-Fi address (see below). Never `0.0.0.0` (refused) |
| `EDIT_API_ALLOW` | Client addresses allowed besides this PC, comma-separated: IPs, CIDR ranges such as `10.0.0.0/8`, or `*` for any address (the key is then the only gate) |
| `EDIT_API_CORS` | Optional. Browser origins allowed to call the API directly, comma-separated. Leave empty when the web app's server calls it |

**The link (Mateo, 2026-11-14):** both laptops are on the campus network. The PC is on the campus
Wi-Fi, and the web app laptop joins the campus VPN, the same path Mateo uses for Moonlight. So
`EDIT_API_HOST` is the PC's Wi-Fi address, and `EDIT_API_ALLOW` is `*`: anyone who can reach the
port must still send the key. The server prints each new caller's address once. After Fahim's first
request, his VPN address can go into `EDIT_API_ALLOW` in place of `*`. The Wi-Fi address comes from
DHCP. If it changes, the server refuses to start and lists this PC's current addresses. Put the new
one in `.env` and tell Fahim.

The firewall is Mateo's to change, from an administrator PowerShell in the repo root. On the Public
profile that Windows gives eduroam, every inbound connection is blocked unless a rule allows it:

```
Get-NetFirewallRule -DisplayName "python.exe" | Where-Object Action -eq Block | Disable-NetFirewallRule
$py = & tools\edit_api\.venv\Scripts\python.exe -c "import sys; print(sys._base_executable)"
New-NetFirewallRule -DisplayName "Edit API 2026" -Direction Inbound -Protocol TCP -LocalPort 2026 -InterfaceAlias "Wi-Fi" -Program $py -Profile Public,Private -Action Allow
```

- **Line 1** is needed if Windows once asked whether this Python may use the network and the prompt
  was cancelled. Cancelling leaves Block rules named `python.exe`, and a Block rule beats any Allow
  rule. With the profile blocking by default, disabling them opens nothing by itself.
- **Lines 2 and 3** open TCP 2026 for the venv's Python only, on the Wi-Fi adapter only. If Windows
  asks again whether Python may use the network, close the prompt and check the rules with
  `netsh advfirewall firewall show rule name="Edit API 2026"` (no administrator needed). Allowing
  the prompt would open every port Python listens on.
- **After the event**: `Remove-NetFirewallRule -DisplayName "Edit API 2026"`, then line 1 with
  `Enable-NetFirewallRule` in place of `Disable-NetFirewallRule`.

## Security

- **The key is the gate.** Every request except `GET /health` needs the key, as
  `Authorization: Bearer <key>` or `X-API-Key: <key>` (401 without it). The server binds
  `127.0.0.1` and `EDIT_API_HOST`, and answers only the addresses in `EDIT_API_ALLOW` (403 for anyone
  else, `*` for any). The link is the campus network through its VPN (see Run it). The traffic is
  plain HTTP inside it.
- **No paths from the network.** Requests are validated strictly, and unknown fields are refused
  (400). Ids must match `^[A-Za-z0-9_-]+$`. The API builds every pipeline input itself, from those ids
  and from numbers it has range-checked. The command text is the one free string, cleaned of control
  characters and limited to 300 characters.
- **What is served:** a job's own output files by job id and a fixed name pattern, and original faces
  looked up through `data/<model_id>/manifest.json`. Dotfiles, `..` and anything else answer 404.
  Ports 2025 (pipeline) and 8000 (viewer) stay on `127.0.0.1`.
- **What leaves this PC:** scan pictures and geometry, to the web app laptop only (`AGENTS.md`, Data and
  secrets). No CoStar record field is ever in a response. A `property_id` is used only to find
  Matterport model ids.
- **Downloads:** `tools/fetch_matterport.py fetch <id> --resolution 2k` for panoramas, and once per
  model, a MatterPak that is **already** unlocked. The code reads the bundle list and downloads only
  assets that already have a URL. It never calls `unlockModelBundle` and never spends money.

## The contract

Base URL: `http://<the PC's campus Wi-Fi address>:2026`, reached from the campus VPN. Mateo gives
the address. Every URL in a response is a path such as `/edits/<id>/files/p6_f3.jpg`. Join it with
the base URL and send the same key header.

### The frame

The scan contract from `AGENT_COMMS.md`, repeated in every result as `frame`:

- **World:** right-handed, Z up, metres. The same frame as the MatterPak OBJ.
- **Panorama pose:** `position` `[x, y, z]` in metres, and `rotation` `[x, y, z, w]`, a quaternion
  that turns panorama-local directions into world directions. Use it as given.
- **Faces:** 0 up (+Z), 1 +X, 2 −Y, 3 −X, 4 +Y, 5 down (−Z), in the panorama's own frame.
  `frame.face_basis` gives each face's `forward`, `up` and `right` vectors. Pixel `(i, j)` (column,
  row) of a face of size `s` looks along `forward + a·right + b·up`, with `a = (i + 0.5)/s·2 − 1` and
  `b = 1 − (j + 0.5)/s·2`. Face 0's image top points along local −X, and face 5's along local +X.
- **Camera direction:** `yaw = atan2(forward.y, forward.x)` in degrees, from +X towards +Y, and
  `pitch` in degrees up from level, both in the **world** frame. `fov` is the horizontal field of
  view of the square view the pipeline edits (default 70). It does not need to match the web app's
  own view.

For three.js: put the six faces on a cube around the panorama's position, orient it with the
quaternion, and convert Z-up to three.js's Y-up once for the whole scene (for example a parent
rotated −90° about X). Faces are 2048 px JPEGs at the `2k` resolution.

### Endpoints

| Method and path | What it does |
| --- | --- |
| `GET /health` | `{ok, runner, pipeline}`. No token needed. Use it to test the link. `pipeline` is false when the edit graph on this PC is down |
| `GET /places` | The downloaded scans: `{places: [{model_id, panos, has_mesh}]}` |
| `GET /places/{model_id}` | One scan, whether downloaded or not (see below). Never calls Matterport |
| `POST /places/{model_id}/fetch` | Download a scan ahead of time. A job like an edit (202), with `kind: "fetch"` |
| `GET /places/{model_id}/panos/{pano_id}/faces/{n}` | An original face, `n` = 0 to 5, JPEG |
| `POST /edits` | Start an edit. 202 with the job at once |
| `GET /edits` | The 50 newest jobs, short |
| `GET /edits/{job_id}` | A job: status, place in the queue, steps, result or error |
| `GET /edits/{job_id}/events` | The same job as server-sent events |
| `DELETE /edits/{job_id}` | Cancel a job that is still queued |
| `GET /edits/{job_id}/files/{name}` | A job's pictures: faces, views, masks, preview |

### `GET /places/{model_id}`

```json
{"model_id": "zzvymDx5ty7", "downloaded": true, "has_mesh": true, "resolution": "2k", "face_size": 2048,
 "frame": {"...": "see The frame"},
 "panos": [{"id": "6zup806u9qfn91xq0hbdk5yna", "location_id": "6zup806u9qfn91xq0hbdk5yna", "index": 6,
            "label": "7", "floor": "Floor 1", "position": [x, y, z], "rotation": [x, y, z, w],
            "faces": ["/places/zzvymDx5ty7/panos/6zup806u9qfn91xq0hbdk5yna/faces/0", "... 6 in all"]}]}
```

A scan that is not on this PC answers `{"model_id", "downloaded": false, "has_mesh": null, "panos": []}`.
**`has_mesh` decides how far an edit reaches.** With a mesh, the pipeline carries the edit to every
panorama that sees the thing. Without one, only the starting panorama is edited.

### `POST /edits`

```json
{"place": {"model_id": "zzvymDx5ty7"},
 "start": {"pano_id": "6zup806u9qfn91xq0hbdk5yna", "yaw": 270, "pitch": -14, "fov": 70},
 "command": "remove the throw pillows and the tray from the bed"}
```

- `place`: exactly one of `model_id` or `property_id` (a CoStar `PropertyId` or
  `ResidentialListingId`). A property usually has several scans, one per unit. Then the answer is 409
  `several_models` with `candidates: [{model_id, downloaded}]`, and you send one of them as
  `model_id`. **On this PC the CoStar kit is missing**, so `property_id` answers 501
  `property_lookup_unavailable`. Send `model_id`.
- `start.pano_id`: the panorama's `id`, or its `location_id` (the sweep id). `yaw` is any number,
  wrapped to 0 to 360. `pitch` is from −89 to 89, default 0. `fov` is from 30 to 120, default 70.
- `command`: 3 to 300 characters.
- `preset` (optional): `720` (default), `fast`, `draft` or `quality`. Resolution against time.

Answer (202), the same shape as `GET /edits/{id}`:

```json
{"job_id": "20261114-213356-87310b", "kind": "edit", "status": "queued", "queue_position": 1,
 "created": "2026-11-14T21:33:56-0500", "started": null, "finished": null,
 "place": {"model_id": "zzvymDx5ty7"}, "start": {"pano_id": "...", "yaw": 270.0, "pitch": -14.0, "fov": 70.0},
 "command": "remove the throw pillows and the tray from the bed", "steps": [], "result": null, "error": null}
```

### A job

`status` moves through `queued`, then `fetching` (downloading the scan or mesh if needed), then
`running`, and ends `done` or `failed` (or `cancelled`). **One job runs at a time**, because the GPU
runs one edit at a time. `queue_position` is 1 for the next job to run, and null once the job has
started. A job takes about 5 s when nothing is found, about 3 min for two views and about 6 min
for four (the starting view 50 to 95 s, the plan about 20 s, each other view 65 to 95 s). The worst
case is about 9 min. A second job waits in the queue. The stub takes 5 to 15 s.

`steps` lists `{step, status: "started" | "done", seconds, pano, view, at}` in order. `pano` is the
panorama index, and `view` counts the views of the run from 0 (the start view). Both are absent on
steps that belong to no single view: the pipeline's `plan` and `finish`, and the API's own. One
pipeline run covers every panorama the edit reaches. Each view is a `first_view` or
`other_view_<n>` step with that view's own steps inside it (`prepare`, `locate`, `segment`,
`generate`, `paste`, `measure`, `inspect`, `report`, `repair`, …, which can carry suffixes such as
`measure_2`). `plan` also sends `{"step": "plan", "status": "chosen", "panos": [6, 2, 8, 1]}`, and
a view's `done` and `finish`'s `done` carry its `verdict`. The API adds `fetch_panos`, `fetch_mesh`
and `faces`. Show the steps as they come, and do not branch on the names.

### The result (`status: "done"`)

```json
{"job_id": "...", "stub": false, "model_id": "zzvymDx5ty7", "command": "...", "has_mesh": true,
 "frame": {"...": "see The frame"},
 "start": {"pano_id": "6zup806u9qfn91xq0hbdk5yna", "index": 6, "yaw": 270.0, "pitch": -14.0, "fov": 70.0},
 "panos": [
   {"id": "7ip402xq438eb6h34r7qw9i3d", "location_id": "7ip402xq438eb6h34r7qw9i3d", "index": 2,
    "position": [x, y, z], "rotation": [x, y, z, w],
    "faces": ["/places/zzvymDx5ty7/panos/7ip402xq438eb6h34r7qw9i3d/faces/0",
              "/edits/<job>/files/p2_f1.jpg", "/edits/<job>/files/p2_f2.jpg",
              "/places/.../faces/3", "/places/.../faces/4", "/edits/<job>/files/p2_f5.jpg"],
    "changed": [1, 2, 5], "verdict": "fix",
    "views": [{"yaw": 298.0, "pitch": -14.0, "fov": 70.0, "width": 720, "height": 720,
               "before": "/edits/<job>/files/p2_v1_before.jpg", "edited": "/edits/<job>/files/p2_v1_edited.jpg",
               "mask": "/edits/<job>/files/p2_v1_mask.png",
               "report": {"verdict": "fix", "issues": ["..."], "notes": ["..."], "summary": "..."}}]}
 ],
 "report": {"verdict": "fix", "issues": [{"kind": "object_remains", "severity": 2, "pano": 2, "...": "..."}],
            "notes": ["..."], "summary": "Panorama 6: ... Panorama 2: ..."},
 "preview": "/edits/<job>/files/preview.jpg",
 "skipped": [{"id": "...", "index": 3, "why": "closer than 0.8 m"}],
 "single_view": null}
```

- `panos` lists only the panoramas the edit changed. The starting panorama comes first.
- `faces` always has six URLs. A face that changed points to the job's file. A face that did not
  change points to the original, so it can be cached across jobs. `changed` lists the numbers of the
  changed faces.
- `views` are the flat pictures the pipeline edited (before, after, and the mask of changed pixels,
  white = changed), with the camera each was taken from. Use them for a 2D before/after, or to check
  placement.
- `verdict` is `pass` or `fix`. `fix` means the pipeline's loose check found something glaring
  (`issues`). The edit is still returned. Each issue is `{kind, severity, source, evidence, region,
  repair, action, what, pano}`, and `region` is `[x0, y0, x1, y1]` in pixels of that panorama's view.
- Issue kinds include `object_remains`, `shadow_left`, `object_added` (the image model drew
  something new) and `not_found` (nothing to edit in that view; that view is then not in `panos`).
- `preview` is one JPEG with before and after for every view, one row per view. It is null when
  nothing was edited.
- `skipped` lists panoramas that see the thing but were left out (closer than 0.8 m, or the thing
  is hidden in the framed view). `single_view` says why only the starting view was edited, when so
  (nothing edited there, no mesh), and is null otherwise.
- `stub` is true only with `--runner stub`. A stub result is a finished case of the same scan,
  chosen to match the command's words, and **not** an edit of the requested view. `note` says which.

### Errors

Every error is `{"error": {"code", "message", ...}}`.

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `bad_request` | A field is missing, out of range or not allowed, or an id has other characters |
| 401 | `unauthorized` | No bearer token, or the wrong one |
| 403 | `forbidden` | The caller's address is not allowed |
| 404 | `unknown_pano` | No panorama with that id in a downloaded scan |
| 404 | `unknown_job`, `not_found` | No such job, file or face |
| 409 | `several_models` | A `property_id` with several scans. `candidates` lists them |
| 409 | `not_cancellable` | Only a queued job can be cancelled |
| 501 | `property_lookup_unavailable` | The CoStar kit is not on this PC |
| 503 | `busy` | 8 jobs are already waiting. Try again later |

A job that fails has `status: "failed"` and `error: {code, message}`, with one of these codes:
`unknown_place` (Matterport has no scan with that id that this account can read), `unknown_pano`
(the scan had to be downloaded first, and has no such panorama), `download_failed`,
`pipeline_unavailable`, `edit_failed`, `cancelled`, or `interrupted` (the API restarted mid-job).

### Server-sent events

`GET /edits/{id}/events` sends the job's history, then follows it live:

```
id: 0
event: status
data: {"status": "queued", "queue_position": 1}

id: 5
event: step
data: {"step": "generate", "status": "done", "pano": 6, "seconds": 18.8, "at": "..."}

id: 41
event: done
data: {...the result...}
```

The events are `status`, `step`, `done` (the result) and `failed` (the error). The stream ends after
`done` or `failed`. Send `Last-Event-ID` to resume after an event. A comment line arrives every 15 s
while nothing happens. Through `proxy.ts`, a browser's `EventSource('/api/edit/edits/<id>/events')`
works as is. Without the proxy, `EventSource` cannot send the key, so read the stream with `fetch`
and a stream reader, as `client_test.ts` does.

### Pictures in the browser

Through `proxy.ts`, a picture is a plain URL: `'/api/edit' + url`. Without the proxy, every picture
needs the key header: call `fetch(url, {headers})`, then `URL.createObjectURL(await res.blob())`,
and give that URL to three.js's `TextureLoader`. All picture URLs are immutable and can be cached.

## Test from the other laptop

`client_test.ts` needs only Node 24, and reads `EDIT_API_URL` and `EDIT_API_TOKEN` from `.env`
(see the start of this README). Add `--model`, `--pano`, `--yaw`, `--pitch`, `--fov` or `--command`
to change the edit, and `--save <folder>` to keep the preview and the changed faces.

`client_test.py` does the same with only Python's standard library (3.9 or newer):

```
export EDIT_API_TOKEN=...            # PowerShell: $env:EDIT_API_TOKEN = "..."
python3 client_test.py --base http://<PC>:2026 --stream
python3 client_test.py --base http://<PC>:2026 --model 2rPahZzW6H7 --command "remove the trash bins" --save out/
```

Or with curl:

```
curl -s http://<PC>:2026/health
curl -s -H "Authorization: Bearer $EDIT_API_TOKEN" http://<PC>:2026/places/zzvymDx5ty7
curl -s -X POST -H "Authorization: Bearer $EDIT_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"place":{"model_id":"zzvymDx5ty7"},"start":{"pano_id":"6zup806u9qfn91xq0hbdk5yna","yaw":270,"pitch":-14},"command":"remove the throw pillows from the bed"}' \
  http://<PC>:2026/edits
curl -s -H "Authorization: Bearer $EDIT_API_TOKEN" http://<PC>:2026/edits/<job_id>
curl -sN -H "Authorization: Bearer $EDIT_API_TOKEN" http://<PC>:2026/edits/<job_id>/events
```

Pictures saved with `--save` are licensed scan pictures. Keep them out of git and off any upload.

## Questions for the web app side

Until these are answered, the API follows the default given with each question.

1. **Who calls the API: the browser or the web app's server?** *Default: the Hono server, through
   `proxy.ts` (see the start of this README).* The key then stays on the server, and pictures and
   the event stream work as plain URLs. A browser can also call the PC directly, with
   `EDIT_API_CORS` set to the page's origin, but then it holds the key and fetches every picture by
   hand.
2. **Does the web app show the panoramas itself (three.js, from our cube faces), or does it need
   equirectangular images?** *Default: cube faces only. An equirectangular export can be added.*
3. **Where does the camera direction come from?** If it comes from the Matterport Showcase SDK, its
   pose is in Showcase's own Y-up frame. The conversion to our Z-up world frame has to be measured on
   one panorama, not guessed. *Default: the web app sends yaw and pitch in our world frame (see The
   frame), and its sweep id as `pano_id`.* The SDK only works on `localhost`, so the plain embed may
   not report a pose at all.
4. **What does the web app show while a job runs** (minutes for several panoramas)? *Default:
   `queue_position` and the step stream, with `pano` on each step.*
5. ~~Which link connects the two laptops?~~ Answered by Mateo: the campus VPN, with the API key as
   the gate (see Run it).

## Files

| File | What it does |
| --- | --- |
| `server.py` | FastAPI app, auth, routes, SSE and binding |
| `jobs.py` | The one-at-a-time queue, a job's life, mapping a run into the result |
| `runners.py` | `GraphRunner` (the `all_views` graph on 2025) and `StubRunner` (finished cases) |
| `places.py` | Place to scan, scan summaries, downloads on demand, the frame |
| `faces.py` | An edited view back into cube faces (`python faces.py check <run_dir>`) |
| `config.py` | Settings from `.env`, paths, limits |
| `client_test.ts` | The client test for the web app laptop (Node 24, nothing to install) |
| `client_test.py` | The same test with Python's standard library |
| `proxy.ts` | For the web app's Hono server: forwards `/api/edit/*` to this API and adds the key |

Outputs go to `data/edit_api/` (git-ignored): `jobs/<id>/` holds `job.json`, `job.log` and `files/`,
which is everything a client may fetch. `checks/` holds `faces.py check` results, and
`mesh_checks.json` records which scans were checked for an unlocked MatterPak.

## How `faces.py` works, and how well

Each face pixel becomes a world direction, using the inverse of `pano.Scan.sample`, and is projected
into the edited view's camera, which `edit_agent.steps.prepare` builds the same way. Under the paste
mask, feathered about 3 px outwards, the edit is blended in. Everywhere else the face keeps the
original. Faces are about twice as dense as a 720 px view, so where the edit barely moved a pixel,
the face keeps its own fine detail and takes only the edit's change of tone.

Checked on three finished runs. The test pastes each run, renders the view again from the new faces,
and compares the result with the edited view:

| Run | Faces changed | Inside the mask, against the edit | The edit's own change there | Outside the mask, against the original |
| --- | --- | --- | --- | --- |
| bed, clutter, p6 | 3 | 1.45 | 24.9 | 0.23 |
| bed, regenerated, p6 | 3 | 1.49 | 23.7 | 0.23 |
| exterior bins, p6 | 1, 2 | 2.74 | 29.4 | 0.57 |

Values are mean absolute differences on a 0 to 255 scale. The faces were also compared by eye with
the originals. The bed's pillows and tray, and the bins on the street, are gone in the faces, in the
right place and without a visible edge. About 1 s per view.

Not checked: a view that is not square, and faces at a resolution other than 2k.
