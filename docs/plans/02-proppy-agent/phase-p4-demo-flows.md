# Phase p4: Demo flows

Part of [the plan overview](overview.md).

Phase 8. It depends on every phase of this plan and on lanes A, R, B, C and E of the tools plan.
It uses ports 8787, 5173 and 2024, and it calls the real model.

## Goal

The three flows under [Demo flows](overview.md#demo-flows) run from one chat, start to end. After
this phase the prompts and skills are tuned on real runs, the README says how to start Proppy,
and the backup video can be recorded.

## Changes

- Run each flow in the browser. Fix what fails in the skill or the prompt that caused it. Change
  an op only when its summary or a hint misled the model, and then hand the change to the lane
  that owns the op.
- Tune from the tool calls, which the chat shows as quiet lines. Common faults and their fixes:
  - Proppy skips a skill. Sharpen the skill's `description`.
  - Proppy sends a `task` for a question across many properties. Move the rule into the first
    step of the prompt.
  - A scorer runs past 8 tool calls. Name the ops per question type in the skill.
- Update `app/agent/README.md`: the start order (API, then agent server, then web app), the
  `ANTHROPIC_API_KEY` and `PROPPY_MODEL` names, the three demo questions, and the rule that a new
  op needs an agent restart.
- Hand the main session the text for the three `AGENTS.md` lines under "Decisions to record" in
  the overview, with one `AGENT_COMMS.md` Log entry.
- Write the run sheet for the backup video into `decisions.tsv`: the property ids and the scan
  ids that worked, and the questions in order. It holds ids and no record value.

## Data structures

No new type. The run sheet rows are `flow`, `step`, `op`, `ids` and `outcome`.

## Verification

1. Ask Fahim before the first run. Each flow costs model calls.
2. Check that ports 8787, 5173 and 2024 are free. If one is taken, stop and ask Fahim. Start the
   three processes and record the PIDs.
3. Flow 1. Ask "Find wheelchair-friendly condos away from highways." Check each point:
   - Pins take colours with no reload, and the map fits the candidates.
   - No `task` call and no `view_aerial` call runs.
   - The answer says that the scores come from records, and repeats the area assumption.
   - "Look closer at the first one" runs one `task`, and that pin takes the new score.
   - The route follow-up opens the Routing panel with the wheelchair route, and the answer gives the
     verdict per door.
4. Flow 2. Ask "What kind of lift would a sign on this property need?" with a property selected.
   Check each point:
   - The Signage panel opens and Proppy says the scan stands in for the property.
   - Two approval cards appear, one for the sign and one for the lift.
   - The answer names the lift and its working height.
   - The answer ends with the sentence that no sign rule, zone or permit was checked.
5. Flow 3. Open the Edit panel on the chosen panorama and ask Proppy to remove the lamp. Check
   each point:
   - The panel swaps in the prepared picture, with no approval card.
   - The server log shows no request to the edit API.
6. Take screenshots at 1440 by 900 of each flow's last state. Use `browser_take_screenshot` only
   on a page that hosts the Matterport viewer. Save no screenshot that shows an edited picture
   into the repo.
7. Run `pnpm typecheck` and `pnpm test` in `app/server`, `app/web` and `app/agent`. Run
   `node docs/plans/01-propstar-tools/check-ownership.mjs --staged --lane lane-p` on the staged
   files.
8. Record each flow's outcome in `decisions.tsv`. Stop the three PIDs.
9. Stop here. The main session hands the full diff to a reviewer subagent, then asks Fahim
   before any commit.
