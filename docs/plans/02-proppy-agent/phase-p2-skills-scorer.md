# Phase p2: Skills and scorer

Part of [the plan overview](overview.md).

Phase 5. It depends on [p1](phase-p1-op-adapter.md) and [s1](phase-s1-property-query.md). Its
tests need no server and no key.

## Goal

Proppy knows when to use each op. After this phase four skills hold the domain knowledge, the
coordinator prompt names the order of work, and the coordinator scores many properties from
records alone. The `score-property` subagent studies one property, and only when the user
focuses on it and asks for a deeper look.

## Changes

- Rewrite `app/agent/skills/accessibility-audit/SKILL.md` for the op names. The scan enters as
  `building_get` storeys and doors and as `route_solve` verdicts with the `wheelchair` payload. The
  skill says to repeat each `source`, `confidence` and assumption that an op returned.
  - Across many properties, score from `property_query` columns only, such as `stories`,
    `year_built` and `type_label`. Say that the score is a first pass from the record.
  - The aerial, `features_get`, `building_get` and `route_solve` are for one property in focus.
- Create `app/agent/skills/property-search/SKILL.md`.
  - Read `bounds` and `filter` from the view note. "These" and "here" mean the properties in
    view. A question with no place word covers every property.
  - A highway is a `near_roads` row whose `class` is `motorway` or `trunk`. "Away from" means no
    such row under 300 m, unless the user names a distance.
  - Both area tables reach 1000 m. A property with no row is far only when its `area_covered`
    is true.
  - Select `id` and the columns the answer needs. Leave out `name` and `address` unless the user
    asked for them. A query returns at most 100 rows.
- Create `app/agent/skills/sign-and-lift/SKILL.md`.
  - The Signage panel shows the kit's one outdoor scan. Say that it stands in for the property.
  - Read `aim` from the view note. Without it, ask the user to face the wall or to click it.
  - `scene_place` with `sign_panel` and a wall `anchor`, then `signage_measure`, then
    `scene_place` for the lift on the ground under the sign. Take ids from `equipment_list`.
  - When `signage_measure` cannot find the ground, ask the user to move the sign and measure
    again. Do not guess a height.
  - End every answer with "The sign is a blank placeholder. No sign rule, zone or permit was
    checked."
- Create `app/agent/skills/scan-edit/SKILL.md`.
  - The demo holds one prepared edit, on one panorama. Proppy makes no edit itself.
  - Read the scan and the panorama from the view note. When they match the prepared edit, call
    `view_open` on the Edit panel with `edited: true`.
  - Otherwise say where the prepared edit is and offer to open it.
- Give each skill a `description` that names its trigger words. Proppy picks a skill from the
  description alone.
- In `contract.ts`, the evidence `source` becomes `costar`, `aerial`, `vexcel`, `scan` or
  `overture`. Delete `PinEvent`.
- In `proppy.ts`:
  - The scorer gets the tools of every op with `effect: 'read'` except `view_get` and
    `property_query`, plus `view_aerial`. Its `skills` list stays `['/skills/']`.
  - `SCORER_PROMPT` says to call `property_get` first, then the ops the skill names, and to stop
    after 8 tool calls. Delete the sentence about panoramas.
  - Replace `pinOutcome` with `postScore(ops)`. Its `afterAgent` hook parses `PropertyScore` and
    calls `view_highlight` with `mode: 'add'`, the score and the first 80 characters of the
    summary. A response that fails to parse posts nothing, and the pin stays unscored.
  - Rewrite `COORDINATOR_PROMPT`: read the matching skill, find candidates with `property_query`,
    score the rows from their columns, post the scores with one `view_highlight` and `replace`,
    fit the map with `view_frame`, then answer. It sends a `task` to `score-property` only when
    the user focuses on one property and asks for a deeper look. It says that a write
    op asks the user first, and that Proppy repeats every assumption an op returned.
- In `proppy.test.ts`, add: the scorer's tool list holds no write op and no view op, a valid
  `PropertyScore` posts one `view_highlight` call, and an invalid one posts none.

## Data structures

- `PropertyScore`: `{propertyId, score, summary, evidence: [{source: 'costar' | 'aerial' |
  'vexcel' | 'scan' | 'overture', detail}]}`.
- Skill frontmatter: `name` and `description`. The body holds criteria and order of work, and no
  op schema.

## Verification

1. Run `pnpm --dir app/agent typecheck` and `pnpm --dir app/agent test`.
2. Run `wc -l app/agent/skills/*/SKILL.md`. Each skill is under 80 lines.
3. Read each skill against `pstack:writing-for-agents`. A reviewer subagent that has not seen
   this plan reads the four skills and says what each op call would be for the three demo
   questions. Fix every step it gets wrong.
4. Record the test counts in `decisions.tsv`. This phase calls no real model.
