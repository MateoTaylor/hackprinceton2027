# tools/smoke

Owner: Fahim-Agent. A TypeScript check that CoStar, Matterport and Vexcel all answer for the same building, plus a Showcase SDK viewer. `smoke.ts` is the reference for all three sources: copy its helpers before you write new ones.

## Setup

1. Unzip the CoStar kit into `kit/costar-hackathon-kit/`. The Vexcel vendor guide goes in `kit/vexcel/`. `kit/` is git-ignored.
2. Fill in `.env` at the repo root (see `.env.example`).
3. In this folder, run `pnpm install`. Node 24+ runs the `.ts` files directly.

## Run (from this folder)

```sh
pnpm smoke 23296   # CoStar + Matterport + Vexcel for one property; writes data/smoke/<propertyId>/
pnpm showcase      # SDK viewer at http://localhost:8000/showcase/?m=<modelId>; `window.sdk` is the SDK
```

## How the sources join

The overlap is built in: the kit is CoStar's own list of buildings that have Matterport scans.

- **CoStar → Matterport**: `kit/costar-hackathon-kit/commercial-properties.csv` (`PropertyId → MatterportModelId`) and `residential-listings.csv` (`ResidentialListingId → MatterportModelId`). These have one row per model. A commercial property averages ~4 models (one per unit or suite), so a model is usually a *piece* of the building and its floor area can be a fraction of the property's RBA. Our token can open 98.5% of commercial properties and 99.9% of homes in these CSVs. Model ids also appear as `videoKey` on attachments/media (`externalReferenceType` 36 or 234).
- **CoStar → Vexcel**: by coordinates. Commercial: `primaryAddress.latitude/longitude`. Residential: `property.address.latitude/longitude`. Vexcel covers whole areas rather than a property list, so any point in either city works, including buildings outside the kit (neighbours, comps).
- The CSV `City` column has mixed casing (`LOS ANGELES`, `houston`). Normalise it before grouping.

## CoStar kit

Read `kit/costar-hackathon-kit/index.md` first. Per-dataset field docs are in `kit/costar-hackathon-kit/models/*.md`, and the domain terms (RBA, cap rate, comps) are in `kit/costar-hackathon-kit/concepts/`.

- The JSONL files are large (`commercial-property.jsonl` is 184 MB, one record per line). Stream them or `grep` for an id. Reading a whole file blows the context window.
- To decode a commercial `propertyType`, use `kit/costar-hackathon-kit/schemas/commercial-property.schema.json` → `$defs.PropertyType` → `x-enum-varnames`. `enums.json`'s `PropertyType` is the *residential* enum and gives wrong labels.
- 2,765 of the 3,339 commercial properties are apartments.
- Emails and phone numbers are fake, but broker and contact names are real. Keep records out of git and logs. To get photos, swap the `/112/` size segment in an `attachmentUri` for a larger one.
- The kit is licensed and git-ignored under `kit/`. Keep it out of commits.

## Matterport

- GraphQL: `POST https://api.matterport.com/api/models/graph` with HTTP Basic `tokenId:secret`. The rate limit is 10 req/s. Explore the schema at https://api.matterport.com/model/graphiql.
- To list models, call `models(pageSize: 1000, offset: $o) { totalResults nextOffset results { id } }`. `nextOffset` is an opaque cursor and is `null` on the last page. We can see 14,944 models.
- `measurements` and `dimensions` are deprecated, and `dimensionEstimates` is restricted. Area comes from `floors`/`rooms` `dimensions.areaFloor`.
- The Showcase SDK key is bound to the hostname `localhost` (any port, http or https). From `127.0.0.1`, a LAN IP or a deployed domain, the SDK script returns 400 and the viewer hangs on "Connecting". `showcase.ts` serves the SDK viewer and pins the SDK version.
- A plain embed without the key (`https://my.matterport.com/show?m=<modelId>&play=1` in an iframe) plays from any origin. It gives the walkthrough only: SDK control (camera, sweeps, scene objects) needs `localhost`.

## Vexcel

- REST at `https://api.vexcelgroup.com/v2` with the `X-API-KEY` header. The vendor guide is `kit/vexcel/Vexcel_API_Hackathon_Tutorial.pdf` and `kit/vexcel/vexcel_quickstart.py`.
- WKT is **lon lat**: `POINT(-95.53 29.85)`.
- `property/extract` returns **one feature per capture** (collection), even with `latest=true`. One property can return several captures spread over years. They are not sorted, so sort by `metadata.ortho-date-estimate` yourself. That gives a change-over-time series for free.
- All 32 kit coordinates we sampled returned parcels. If a point ever 404s, `smoke.ts` falls back to a ~100 m box.
- Oblique (angled) imagery exists only in the `urban` layer.

