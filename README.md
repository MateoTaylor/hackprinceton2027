# hackprinceton2027

HackPrinceton Fall 2026 · CoStar Group track, **"Inside and Out: AI for the Built World"**.

## The track in brief

- **Data:** three layers for the same Houston and Los Angeles addresses: CoStar building records,
  Matterport 3D scans, Vexcel aerial imagery. Each team gets API keys.
- **Rules:** use at least two of the three layers, be agentic (not a chat wrapper), and show real
  spatial or visual understanding.
- **Judging:** 30% use of the data · 30% agentic depth · 25% usefulness · 15% demo and polish.

## Direction

A map of the Houston and Los Angeles properties in the CoStar kit that you can question and fly
through:

- **Aerial map:** Vexcel imagery with one pin per property, plus filter and sort.
- **Agent:** ask a question such as "which of these are wheelchair-friendly?". The agent scores
  each property from its CoStar record, its aerial image and its Matterport panoramas, colours the
  pins and shows the evidence behind each score.
- **Fly-through:** a WASD and mouse camera that flies outside a building and inside its 3D scan,
  where you can place interactive objects such as a scissor lift or a grand piano.

The stack and the agent design are in [AGENTS.md](AGENTS.md). The app is not built yet. We also
enter the LangChain track, which judges the use of Deep Agents.

**Scan editing** is being built as its own agent in [`tools/edit_agent/`](tools/edit_agent/README.md):
a typed request removes one chosen object from a view of a scanned room and reports what is still
wrong. Retexturing and adding objects come next. Matterport's own Defurnish removes all furniture
by category; there is no single-object eraser. An earlier idea for it was an anomaly-spotting game
played in real scanned homes ("what changed in this room?").

## Repo layout

| Path | What | Owner |
| --- | --- | --- |
| `tools/fetch_matterport.py` | Download a model's panoramas, MatterPak mesh and a manifest (stdlib-only Python) | shared |
| `tools/visualization/` | Browser viewers for a downloaded scan, with their own [README](tools/visualization/README.md) | Mateo-Agent |
| `tools/visualization/serve.py` | Localhost-only server for the viewers and downloaded data | Mateo-Agent |
| `tools/visualization/index.html` | Walk-through: WASD through the textured mesh, compare with the panorama photos | Mateo-Agent |
| `tools/visualization/alignment.html` | Alignment checks: panoramas inside the mesh, convention detection | Mateo-Agent |
| `tools/qwen_test/` | Tests of removing or changing one item across a scan's panoramas with local models (SAM 2.1, Qwen3-VL, Qwen-Image). Python with its own environments; needs a 16 GB GPU. See its [README](tools/qwen_test/README.md) | Mateo-Agent |
| `tools/edit_agent/` | Scan edit agent: a typed request removes an object from one view and reports what a second pass should fix. A LangGraph graph in Python over the local models in `tools/qwen_test/`. See its [README](tools/edit_agent/README.md) | Mateo-Agent |
| `tools/smoke/` | TypeScript check that CoStar, Matterport and Vexcel answer for one building, plus the data notes | Fahim-Agent |
| `eraser/` | Empty. Scan editing is in `tools/edit_agent/` | Mateo-Agent |
| `docs/design/` | UI design notes. Interactions not shown in the static screens: see `docs/design/interactions.md` | Fahim-Agent |
| `AGENTS.md` | Direction, stack and working rules for every coding agent | everyone |
| `AGENT_COMMS.md` | Coordination between the coding agents: ownership, contracts, log | everyone |
| `data/` | Downloaded scans (git-ignored, licensed data: never commit) | local only |

## Working with agents

Two people, each with a coding agent. **Agents: read [AGENTS.md](AGENTS.md), then
[AGENT_COMMS.md](AGENT_COMMS.md), before starting work** and log major updates there.

## Setup

1. Python 3.10 or newer. The Python tools use only the standard library. On Windows run them with
   `py`, elsewhere with `python3`. The TypeScript tools need Node 24 or newer and `pnpm`; see
   `tools/smoke/README.md`.
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
py tools/visualization/serve.py        # then open http://localhost:8000/
```

- **Walk-through (the page that opens):** `W A S D` to walk through the textured mesh, drag to
  look, `F` to switch between the panorama photo and the 3D render at the same pose, `1`–`9` or a
  floor ring to jump to a panorama, `C` to blend or split-wipe photo against render. Full control
  list in [tools/visualization/README.md](tools/visualization/README.md).
- **Alignment checks (`alignment.html`, linked from the walk-through):** panorama inside the mesh
  with opacity and edge overlays, an orbit (dollhouse) view, and **Detect faces / Detect yaw** to
  re-measure the panorama conventions on a new model.
- `serve.py` binds to localhost only, refuses dotfiles and serves only `tools/visualization/` and
  `data/`, so `.env` is never served. Don't use `python -m http.server` from the repo root: it
  would serve `.env` to your whole network.

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
