# AGENTS.md

Every coding agent in this repo works from this file. It holds the decisions. `AGENT_COMMS.md` holds
the log, the ownership table and the shared data contracts. Read both before you start.

## What we are building

A HackPrinceton Fall 2026 entry for two tracks. The CoStar track rules and judging weights are in
`README.md`. The LangChain track judges how complex the use case is, how well it uses Deep Agents
(subagents, file system, skills) and the demo.

The product is a map of the Houston and Los Angeles properties in the CoStar kit, with three parts:

1. **Aerial map.** Vexcel imagery with one pin per property, plus filter and sort.
2. **Agent.** The user asks a question such as "which of these are wheelchair-friendly?". The agent
   scores each property from its CoStar record, its aerial image and its Matterport panoramas, then
   colours the pins live and shows the evidence behind each score.
3. **Fly-through.** A WASD and mouse camera that flies outside a building and inside its 3D scan,
   where the user can place interactive objects such as a scissor lift or a grand piano.

The magic eraser in `README.md` is on hold.

## Stack

Nothing below has been built yet. `tools/smoke/` is the only running TypeScript.

| Part | Choice | Why, and what to watch |
| --- | --- | --- |
| Hosting | **Local-only**, on `localhost` | The data is licensed, so it stays on the laptop. The demo runs locally with a recorded backup video. |
| Language | TypeScript on Node 24, `pnpm` | Node 24 runs `.ts` files directly. The team uses Windows and macOS, so scripts must run on both. |
| Client | Vite + React, plain `fetch` | No Next.js, TanStack or other framework. |
| Map | MapLibre GL | Draws Vexcel tiles and one GeoJSON of about 5,200 points. |
| 3D | three.js with `three-mesh-bvh` | Same library as the visualization tools. Collision and picking use the BVH. |
| Server | Hono | Proxies Vexcel WMTS tiles with a disk cache and serves data endpoints. The Vexcel key stays on the server. |
| Data | One DuckDB file built from the CoStar JSONL | Pin `@duckdb/node-api` to the `1.4` LTS line. `latest` is `2.0`. |
| Agent | `deepagents` (JS) on a local LangGraph server, port 2024 | Run it with `@langchain/langgraph-cli`. The client reaches it through `useStream` from `@langchain/react`. |

The Hono server and the LangGraph server are two local processes. The client talks to the agent
only through port 2024, so the agent can change without touching the client.

## Agent design

- A coordinator narrows the candidates with a read-only SQL tool over DuckDB.
- It delegates one subagent per property through parallel `task` calls. Each subagent reads the
  CoStar fields, the Vexcel ortho and the Matterport panoramas, and returns a Zod `responseFormat`
  of score plus evidence.
- Tools emit progress through `config.writer`, so pins colour as results arrive.
- Domain knowledge lives in runtime skills such as `skills/accessibility-audit/SKILL.md`.
- `interruptOn` asks the user before the agent places an object.
- Root the agent's `FilesystemBackend` in a folder under `data/` with `virtualMode: true`. A backend
  rooted at the repo can read `.env`.

Check LangChain APIs against the live docs before you use them. The JS docs contain Python
leftovers, and `deepagents` needs `>=1.8.4` for structured subagent output. In Claude Code, the
docs servers and the LangChain skills install per person:

```
claude plugin marketplace add langchain-ai/langchain-plugins
claude plugin install langchain-skills@langchain-plugins --scope local
claude plugin install langchain-mcp@langchain-plugins --scope local
```

## Data and secrets

- Keys live only in `.env`. Add new key names to `.env.example` with a Log entry. Keys never appear
  in code, logs, commits, screenshots or `AGENT_COMMS.md`.
- `data/` and `kit/` hold licensed CoStar, Matterport and Vexcel data. They stay git-ignored and on
  the laptop. Commercial records carry real broker and contact names.
- Leave LangSmith tracing off until a CoStar mentor approves it. Traces upload the prompts, which
  contain CoStar records.
- Serve files through a server that binds to `localhost` and refuses dotfiles. `python -m
  http.server` from the repo root serves `.env` to the network.
- The Matterport fetcher never calls `unlockModelBundle`. Nothing in this repo spends money.

## Where the facts are

- `tools/smoke/README.md` has the join keys between the three sources, the CoStar kit traps and the
  Vexcel and Matterport API quirks. `tools/smoke/smoke.ts` is working reference code for all three.
- `kit/costar-hackathon-kit/index.md` describes the CoStar datasets. Stream the JSONL files. Reading
  one whole fills the context window.
- `AGENT_COMMS.md` Shared contracts defines the scan manifest, the world frame and the panorama
  face layout.
- `docs/design/design.md` is the design system. Read it before changing UI or UX.

## Working together

- **Stay in your lane.** The Agents table in `AGENT_COMMS.md` says who owns each path. Claim a new
  path there before you create it. The app's folder is unclaimed.
- **Log major updates.** Add a signed entry at the top of the `AGENT_COMMS.md` Log when you change a
  shared path or contract, land a feature or interface, change a decision in this file, hit a
  blocker, or learn something the other agent needs. Small edits inside your lane need no entry.
- **Change this file when a decision changes**, in the same step as the Log entry.
- **Verify before you report.** Run the check and show its output. Say which checks you skipped.
- Commit rules are in the `AGENT_COMMS.md` Protocol. Commit and push only when your human asks.
