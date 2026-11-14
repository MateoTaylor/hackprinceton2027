# Proppy agent

Proppy is the Propstar agent. It runs as a local LangGraph server on port 2024. The web client reaches it through `useStream` from `@langchain/react` and never talks to the model provider directly.

## Run it

1. Build the property database first. The agent reads `data/propstar/propstar.duckdb` read-only.
2. Start the Hono server in `app/server` if you want aerial images. Without it `view_aerial` returns an error message and the scorer works from the CoStar record alone.
3. Start the agent.

```
cd app/agent
pnpm install
pnpm dev
```

`pnpm dev` turns LangSmith tracing and CLI analytics off. Check with `curl http://localhost:2024/info`, which reports `"langsmith": false`. Use `localhost` and not `127.0.0.1`, because the server binds the IPv6 loopback.

## Add the model key

Put the key in the repo-root `.env`. `langgraph.json` loads that file.

```
ANTHROPIC_API_KEY=...
PROPPY_MODEL=anthropic:claude-sonnet-5-5
```

`PROPPY_MODEL` is optional and takes any `provider:model` string that LangChain accepts. The model is resolved on the first run, so the server boots without a key. A run without a key fails with `Anthropic API key not found`.

## How it works

The coordinator narrows the candidates with `query_properties`, a read-only SQL tool over DuckDB. It then sends one parallel `task` call per property to the `score-property` subagent. Each subagent reads the record with `get_property`, looks at the ortho with `view_aerial`, and returns a `PropertyScore`. Both agents read the `accessibility-audit` skill from `skills/`.

The client receives pin updates as custom stream events. A pin goes from `scoring` to `scored`, or to `failed` if its scorer errors. `src/contract.ts` defines `PinEvent` and `PropertyScore`. Import them as types from the web client. Pin events come from inside the subagents, so the client must stream subgraphs (`streamSubgraphs: true` on submit) to see them.

`place_object` pauses the run for an approve or reject decision. Resume with `{ decisions: [{ type: 'approve' }] }` or `{ type: 'reject' }`.

## Real and stubbed

| Part | State |
| --- | --- |
| `query_properties` | Real. Allows one SELECT or WITH statement, caps results at 100 rows and blocks file access. |
| `get_property` | Real. Reads one row from the `properties` table. |
| `view_aerial` | Real. Fetches the 256 px thumbnail from the Hono server. |
| Matterport panoramas | Out of scope. The scorer is told not to claim anything about interiors. |
| `place_object` | Stub. It returns the request after approval. The fly-through owns real placement. |
| Filesystem | Rooted at `data/propstar/agent-fs/` in virtual mode, so paths cannot climb out. Skills are read-only. |

## Test

```
pnpm typecheck
pnpm test
```

The tests use a fake model and need no key. They need the local `data/propstar/propstar.duckdb`. They cover two parallel scores with pin events, the `place_object` interrupt and resume, SQL write and file-read refusal, and filesystem path escape.
