# Phase p3: Chat panel and pins

Part of [the plan overview](overview.md).

Phase 6. It depends on [p2](phase-p2-skills-scorer.md) and [v2](phase-v2-browser-view.md). Its
last check uses ports 8787, 5173 and 2024.

## Goal

The user approves a write in the chat, and the pins draw from the view. After this phase the
chat panel shows an approval card when Proppy wants to place, move or remove an object, and a
pin's colour survives a reload.

## Changes

- In `app/web/src/pins.ts`, delete `parsePinEvent`, `applyPin` and `settlePins`. Add
  `pinsFromHighlights(highlights, running)`.
  - A number gives `scored` with that score.
  - A null score gives `scoring` while a run streams, and `matched` after it ends.
  - Keep `scoreBand`. Rewrite `pins.test.ts` for the new function.
- In `App.tsx`, delete the `pins` state. Compute the pins from `view.highlights` and the
  `running` flag that `Proppy` reports. Pass a pin's `note` to the map for its hover text.
- In `MapView.tsx`, add the `matched` pin class: the accent outline with no fill. Take the look
  from `docs/design/design.md`.
- In `app/web/src/Proppy.tsx`:
  - Delete `useChannelEffect`, `PIN_CHANNELS` and the `onPins` prop. Add `onRunning(running)`.
  - Stop clearing pins in `ask`. The coordinator replaces the highlights itself.
  - Add the trouble state `no-api`, with the title "Propstar API is off" and the body "Start the
    Propstar server, then try again." `classify` returns it when the error text holds "Propstar
    API is not reachable".
  - Draw one approval card per entry of `stream.interrupt.actionRequests`. A card holds one line
    that says what will happen, the arguments as a short list, and the buttons Approve and
    Reject.
  - Approve or Reject resumes with `stream.submit(null, {command: {resume: {decisions}}})`. Send
    one decision per action request, in order. Disable the composer while a card is open.
  - Show a tool call as one quiet line in the thread, such as "Searched properties" or "Opened
    the Signage panel". Take the wording from a table keyed by op name, with the op's `summary`
    as the fallback. Never print a tool result in the thread.
  - Replace `SUGGESTIONS` with the three demo questions.
- Create `app/web/src/approval.ts` with `describeAction(name, args)`. It returns the card's line
  and its argument list. It prints ids and numbers, and no other string.
  Create `approval.test.ts` beside it.

## Data structures

- `PinState`: `{status: 'scoring'} | {status: 'matched'} | {status: 'scored', score}`. `failed`
  goes away, because a scorer that fails posts nothing.
- `Proppy` props: `{open, onOpen, onClose, onRunning}`.
- A decision: `{type: 'approve'} | {type: 'reject', message?}`.
- `describeAction` result: `{line: string, args: [label: string, value: string][]}`.

## Verification

1. Run `pnpm typecheck` and `pnpm test` in `app/web`.
2. Check that ports 8787, 5173 and 2024 are free. If one is taken, stop and ask Fahim. Start the
   API, the web app and the agent server, and record the three PIDs.
3. Probe `view_highlight mode=replace` with three items, one score 90, one score 40 and one
   null. Take a screenshot at 1440 by 900. The pins show the good band, the bad band and the
   outline. Reload the page and take a second screenshot. The pins are the same.
4. Stop the API. Ask a question in the chat. The panel shows "Propstar API is off". Start the API
   again and record the new PID.
5. Ask Fahim before this step, because it calls the real model once. Ask "Place a scissor lift
   in the first scan." The approval card appears. Take a screenshot. Press Reject. Proppy says
   that nothing was placed.
6. Check both screenshots against `docs/design/design.md`. Stop the three PIDs.
7. Stop here. The main session hands the diff of p1, p2 and p3 to a reviewer subagent.
