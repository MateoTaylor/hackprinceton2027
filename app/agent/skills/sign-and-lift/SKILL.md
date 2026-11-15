---
name: sign-and-lift
description: How to hang a blank sign on the outside wall of a commercial building, measure it and name the lift that reaches it. Read it for any question about a sign, signage, a banner, a storefront, a facade, a scissor lift, a boom lift or how high something on a wall is.
---

# Sign and lift

Signs go on commercial buildings only. The walls come from the Vexcel building outline and
height, not from a scan.

## Order of work

1. Find the property. Use the one the note "What the user sees now" shows as selected, or ask.
2. `signage_get` lists the walls with their `facingDeg` compass bearing, length and height, and
   the signs already placed.
3. Pick the wall.
   - The user names a direction, such as "the street side" or "facing north": pass `facingDeg`.
     North is 0, east 90, south 180, west 270.
   - The user names no wall: take the longest wall and say which way it faces.
4. `signage_place` hangs the sign. It is a write op, so the user approves it first. Pass the size
   in metres when the user gives one. Otherwise leave it out and say the sign is 3 m by 1 m.
5. `signage_measure` with the new `signId` gives the size, the bottom and top above the ground
   and the smallest lift that reaches the top.
6. `view_open` with `panel: 'signage'` so the user sees the sign on the building.

## Moving and removing

- `signage_move` changes the wall, position, height or size. Fields left out keep their value.
- `signage_remove` takes a sign off. Both are write ops and need approval.
- After a move, call `signage_measure` again before naming a lift.

## Lifts

- The lift comes from `signage_measure`. Call `lift_choose` only when the user asks about another
  height or soft ground.
- When `lift` is null, read the assumptions. Either a person reaches the sign from the ground, or
  no lift in the catalogue reaches it. Say which.
- Never guess a height or a lift.

## Reporting

- Give the size, the height of the top above the ground and the lift with its working height.
- Repeat the `confidence` and every assumption the ops returned.
- End every answer with "The sign is a blank placeholder. No sign rule, zone or permit was
  checked."
