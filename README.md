# hackprinceton2027

HackPrinceton Fall 2026 · CoStar Group track, **"Inside and Out: AI for the Built World"**.

## The track in brief

- **Data:** three layers for the same Houston and Los Angeles addresses: CoStar building records,
  Matterport 3D scans, Vexcel aerial imagery. Each team gets API keys.
- **Rules:** use at least two of the three layers, be agentic (not a chat wrapper), and show real
  spatial or visual understanding.
- **Judging:** 30% use of the data · 30% agentic depth · 25% usefulness · 15% demo and polish.

## Direction (working, subject to change)

A **magic eraser** for Matterport scans: remove one chosen object from a scanned room so it is gone
from every panorama, not just one photo. Matterport's own Defurnish removes all furniture by
category; there is no single-object eraser. First planned use: an anomaly-spotting game played in
real scanned homes ("what changed in this room?").

## Repo layout

| Path | What | Owner |
| --- | --- | --- |
| `tools/fetch_matterport.py` | Download a model's panoramas, MatterPak mesh and a manifest (stdlib-only Python) | shared |
| `tools/serve.py` | Localhost-only server for the viewer and downloaded data | shared |
| `viewer/index.html` | three.js viewer: panoramas inside the mesh, alignment checks | shared |
| `eraser/` | Magic eraser module | Mateo-Agent |
| `AGENT_COMMS.md` | Coordination between the coding agents: ownership, contracts, log | everyone |
| `data/` | Downloaded scans (git-ignored, licensed data: never commit) | local only |

## Working with agents

Two people, each with a coding agent. **Agents: read [AGENT_COMMS.md](AGENT_COMMS.md) before
starting work** and log what you do there.

## Setup

1. Python 3.10 or newer. The tools use only the standard library. On Windows run them with `py`,
   elsewhere with `python3`.
2. Copy `.env.example` to `.env` and fill in the team's keys (get them from Mateo over a private
   channel). `.env` is git-ignored; never commit keys or paste them into issues, logs or this repo.

## Get a scan

```bash
py tools/fetch_matterport.py list --query 1BR                 # search the models we can read
py tools/fetch_matterport.py fetch zzvymDx5ty7                # panoramas (2k) + data/<id>/manifest.json
py tools/fetch_matterport.py bundles zzvymDx5ty7 --download   # MatterPak: mesh, point cloud, plans
py tools/fetch_matterport.py introspect Model                 # print a GraphQL type's real fields
```

The fetcher never buys anything (it does not call `unlockModelBundle`). Download URLs are signed and
expire about 5 minutes after the query; re-running a command resumes and skips finished files.

## View a scan

```bash
py tools/serve.py        # then open http://localhost:8000/
```

- **Inside panorama:** drag to look, wheel to zoom, `[` / `]` to switch panoramas. Mesh opacity and
  mesh edges overlays show how well the mesh matches the photo.
- **Orbit (dollhouse):** the mesh from outside, with the selected panorama projected onto it.
- **Detect faces / Detect yaw:** re-measure the panorama conventions on a new model (seam matching,
  then correlation against the mesh).
- `serve.py` binds to localhost only and refuses dotfiles, so `.env` is never served. Don't use
  `python -m http.server` from the repo root: it would serve `.env` to your whole network.

## What the data looks like (checked on model `zzvymDx5ty7`, a 1BR in the hackathon set)

- The hackathon Matterport account can read about 14.9k models (root folder "HackPrinceton 2026").
- Each panorama is six 2048×2048 cube-face JPGs (`0.jpg`–`5.jpg`), plus a position in meters and a
  rotation quaternion.
- The **MatterPak** is already unlocked: textured OBJ (~440k triangles), `cloud.xyz` colour point
  cloud and colour floor plans. **Defurnish** is also unlocked; how to download it is still open.
- Panoramas and the MatterPak share one frame: right-handed, Z up, meters. Matterport doesn't
  document the cube-face layout or quaternion meaning; the measured values are in every manifest's
  `conventions` block.
- The mesh is clean on walls, doors and counters and rough on soft furniture (sofas, plants).
