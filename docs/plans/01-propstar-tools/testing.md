# Testing

Part of [the plan overview](overview.md).

Every phase file ends with a Verification list. This page has the commands those lists use.

## Typecheck and test

Run these in each package you touched.

```
pnpm --dir app/server typecheck
pnpm --dir app/server test
pnpm --dir app/web typecheck
pnpm --dir app/web test
```

`pnpm test` loads no `.env`, so a test sees no key and calls no outside service. A test that
needs a key ends in `.live.test.ts`, skips without the key and runs only by hand.

## Start and stop a server

Use your lane's ports. Pass them inline. Never put them in `.env`.

| Who | API port | Web port |
| --- | --- | --- |
| Fahim's own dev servers | 8787 | 5173 |
| Foundation and lane A | 8788 | 5174 |
| Lane B | 8789 | 5175 |
| Lane C | 8790 | 5176 |

Start the API with `start`, not `dev`. `dev` restarts on every file change, which changes the PID
you recorded.

```
# macOS
PROPSTAR_PORT=8788 pnpm --dir app/server start
PROPSTAR_WEB_PORT=5174 PROPSTAR_PORT=8788 pnpm --dir app/web dev

# Windows PowerShell
$env:PROPSTAR_PORT = "8788"; pnpm --dir app/server start
$env:PROPSTAR_WEB_PORT = "5174"; $env:PROPSTAR_PORT = "8788"; pnpm --dir app/web dev
```

Find the PID of the process that listens on your port, and stop that PID only.

```
# macOS
lsof -ti tcp:8788
kill <pid>

# Windows PowerShell
(Get-NetTCPConnection -LocalPort 8788 -State Listen).OwningProcess
Stop-Process -Id <pid>
```

Never stop a process on a port that is not yours. Ports 8000, 5183, 2024, 2025 and 8021 belong to
other processes. Port 2026 is the edit API on Mateo's PC. Nothing on this laptop listens on it.

## Call an op

Op results derive from licensed data. Call an op with the probe script, which prints the status,
the size of `result` and an outline of keys and counts.

```
node docs/plans/01-propstar-tools/probe-op.mjs building_get propertyId=commercial-248243 --port 8788
node docs/plans/01-propstar-tools/probe-op.mjs building_get propertyId=commercial-248243 --port 8788 --detail
node docs/plans/01-propstar-tools/probe-op.mjs building_get propertyId=commercial-248243 --port 8788 --show result.heightM
```

- A dotted key nests (`target.spaceId=s1`), and a JSON value parses (`widthM=0.8`).
- `--show <path>` prints one value. Use it for numbers and counts. Never use it on a name, an
  address or a whole object.
- Probe one error case per op, such as `propertyId=nope`. The script exits 1 and prints the code
  and the hint.
- Record the printed lines in your decision log. Do not call an op with `curl`, and do not paste a
  response body into a log, a commit message or a reply.

## Check the edit link

The Edit tool reaches Mateo's PC over the campus VPN. Check the link from the repo root.

```
node --env-file=.env tools/edit_api/client_test.ts --check
```

- The output holds the PC's address. Record only the words `link ok` and `key ok` in your
  decision log, or the name of the step that failed.
- Never add `--save`. It writes licensed scan pictures to disk.
- With the link down, build and test against the fake. Do not retry in a loop, because an edit
  holds the GPU on Mateo's PC and its queue runs one job at a time.
- Start a real edit only where a phase file says so.

## Check pixels

- Take screenshots at 1440 by 900 and save them to your scratchpad, never to the repo.
- Check each one against `docs/design/design.md`.
- A page that hosts the Matterport viewer holds `MP_SDK_KEY` in its DOM, its iframe URL, its
  console and its network log. On those pages use `browser_take_screenshot` only. Do not take a
  DOM snapshot, read the console, list network requests or save the page.
- If a `.playwright-mcp/` folder appears in the repo, report it to the main session. Do not
  delete it yourself.
- A screenshot of the Edit panel shows a licensed scan picture. It stays in your scratchpad and
  goes to no outside service.

## What never to print or save

- A key, or any line of `.env`. That includes the values of `EDIT_API_URL` and `EDIT_API_TOKEN`.
- A CoStar record, a broker or contact name, or an op response body.
- A signed Matterport URL. `data/<scan>/raw_locations.json` holds them.
- Mesh geometry from the two demo spaces.
- A scan picture or an edited scan picture from the edit API. It stays in the browser's memory.

## Check ownership

```
node docs/plans/01-propstar-tools/check-ownership.mjs --changed --lane lane-a
node docs/plans/01-propstar-tools/check-ownership.mjs --staged --lane lane-a
```

The script exits 1 when a file belongs to another owner or to nobody. Fix the cause. Do not add
a row to [ownership.tsv](ownership.tsv) yourself, because the main session owns that file.

## End-to-end demo script

Run this by hand once all three lanes land, on ports 8787 and 5173.

1. Select the worked example, `commercial-248243`, on the map. The property card shows the tool row.
2. Open **Dollhouse**. The tower stands in grey grid surroundings with one storey cut away.
   Scanned rooms are in colour, and the legend separates scanned space from inferred space.
3. Open **Routing**. Pick a space and the payload "grand piano". A dot trail runs from the
   entrance, each door shows a tick or a cross, and hover shows the confidence.
4. Open **Area**. Switch to the street basemap. Places within 800 m appear by category.
5. Open **Features**. Vexcel attributes appear with their capture date.
6. Open **Signage**. The facade shows a blank sign, the allowed area with its section numbers and
   the lift class, with "subject to overlays".
7. Open **Scene** on the manufacturing demo space. Place a scissor lift and drive it with WASD.
8. On the campus VPN, open **Edit** on a property whose scan is on the edit PC. Look at an
   object, type "remove the floor lamp" and wait. The panel shows the queue, the steps and the
   panorama before and after.
9. Run `node docs/plans/01-propstar-tools/probe-op.mjs signage_plan propertyId=commercial-248243`.
   It prints `200 ok`, which shows that an agent can make the same call.
