# Propstar server

## Build the property data

`pnpm build:data` picks the 50 Los Angeles properties Propstar shows and writes them to
`data/propstar/propstar.duckdb`.

```
pnpm install
pnpm build:data
```

The build reads these inputs:

- `kit/costar-hackathon-kit/data/commercial-property.jsonl` and `residential-listings.jsonl`, streamed.
- `kit/costar-hackathon-kit/commercial-properties.csv` and `residential-listings.csv`, for the
  Matterport model ids of each property.
- `MP_TOKEN_ID` and `MP_TOKEN_SECRET` from the repo `.env`, to check which models our token can read.

The build keeps 35 commercial properties in the Los Angeles market, spread across types by the
`COMMERCIAL_QUOTA` table, and 15 public homes by the `RESIDENTIAL_QUOTA` table. Within each type it
ranks properties by how many display fields they fill and how many scans they have, and breaks ties
by id. A property is kept only when at least one of its Matterport models is readable. It keeps at
most four scans per property.

The build writes these outputs:

- `data/propstar/propstar.duckdb`, recreated on every run. The `properties` table has one row per
  `Property` (`app/shared/property.ts`) plus raw numeric columns for SQL. The `scans` table has one
  row per readable model. The top comment of `pipeline/build.ts` lists the columns.
- `data/propstar/cache/matterport/<modelId>.json`, one cached GraphQL answer per model.

## Rerun

Rerun `pnpm build:data` at any time. It gives the same database, and it calls Matterport only for
models that are not in the cache. Delete the cache folder to check every model again. The build
never calls `unlockModelBundle`.

## Run the API

`pnpm dev` starts the API on `http://127.0.0.1:8787` and restarts it when a file changes. `pnpm start`
runs it without the watcher. Both load the repo-root `.env`, and the server exits at once when
`VEXCEL_API_KEY` is missing. `pnpm test` runs the unit tests and `pnpm typecheck` checks types.

```
pnpm install
pnpm dev
```

The server reads `data/propstar/propstar.duckdb` once at startup and then closes it, so restart the
server after `pnpm build:data`. It binds to `127.0.0.1` only and answers only under `/api`. Every other
path gets an empty 404, so it never serves files. The routes and their shapes are in
`app/shared/api.ts` and `app/shared/property.ts`.

| Route | Answer |
| --- | --- |
| `GET /api/properties` | `Property[]`, ordered by `id` |
| `GET /api/tiles/:z/:x/:y` | Vexcel `urban` ortho tile, z 0 to 21, JPEG or PNG; 404 when Vexcel has none |
| `GET /api/thumb/:id` | 256x256 ortho JPEG of the parcel |
| `GET /api/oblique/:id` | `ObliqueIndex`, the directions of the newest oblique collection |
| `GET /api/oblique/:id/:dir` | Full-resolution oblique JPEG from that collection; 404 when absent |

Bad parameters get 400 and unknown ids get 404, both before any Vexcel call. A Vexcel failure gets 502,
or 503 after repeated rate limiting. Error bodies are always `{ error }` and never carry anything
from Vexcel.

## Vexcel cache

Every Vexcel answer is cached under `data/propstar/cache/vexcel/`, because Vexcel sends
`no-store` and its cost per call is unknown. Each entry is `<key>.meta`, which holds the status and
content type, plus `<key>.body` for a 200. A 404 is cached too, so a missing tile is asked for only
once. Failures (429, 5xx, timeouts) are not cached.

| Key | Vexcel call |
| --- | --- |
| `tiles/urban/<z>/<x>/<y>` | WMTS `getTile` |
| `parcel/<id>` | `property/extract` at the property's point; the newest parcel outlines the other calls |
| `thumb/<id>-256` | `ortho/extract` |
| `oblique-coverage/<id>` | `oriented/collections` |
| `oblique/<id>/<collection>/<direction>` | `oriented/extract` |

Delete a file or folder to fetch it again. At most four Vexcel calls run at once, and identical
requests that arrive together share one call. The server never prefetches and never calls
`GetCapabilities`, which writes the key into its response.
