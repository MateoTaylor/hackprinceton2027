---
name: accessibility-audit
description: Criteria for scoring how wheelchair-friendly a property is, from its CoStar record across many properties and from its building model, routes and aerial for one property in focus. Read it for any question about wheelchair access, step-free entry, mobility, ramps, lifts, elevators or ADA.
---

# Accessibility audit

Score step-free access for a wheelchair user, from the street to the main floor and between
floors. Start at 50 and move the score with each signal below. Missing data leaves the score where
it is. Say it was missing instead of guessing.

## Many properties: the record alone

Score each `property_query` row from its columns. Select `id`, `kind`, `type_label`, `stories`
and `year_built`. Say that every score is a first pass from the record.

- **Year built.** 1991 or later was built under the ADA Standards, so add 10. Before 1991, take
  off 5.
- **Stories.** One storey needs no lift, so add 10. For a commercial building of two or more
  storeys, add nothing; an elevator is likely but unproven. A home of two or more storeys means
  stairs to the bedrooms, so take off 15.
- **Type.** `Single Family` and `Townhouse` are rarely step-free at the door, so take off 10.
  `Office`, `Healthcare` and `Hotel` usually have an accessible entrance, so add 5.

## One property in focus: the deeper look

Use these only when the user picks one property and asks for more. Call `property_get` first.

1. **Building model.** `building_get` gives the storeys, spaces and doors. Note the storey count,
   whether a stair or an elevator joins them, and the share of the model that is inferred.
2. **Routes.** `route_solve` with the `wheelchair` payload, to the main space on the entrance
   storey and to one space on each upper storey.
   - A reachable route with every door passing: add 20.
   - A door whose `verdict` is `fail`: take off 10 per door, up to 30. Give its `clearanceM`.
   - An upper storey reached only by a stair: take off 20.
3. **Aerial.** `view_aerial`, then `features_get` for the Vexcel attributes.
   - A paved path that joins the parking to the building without a visible stair: add 10.
   - Parking or a drop-off right beside the entrance: add 5.
   - The building sits well above the street on a slope or a podium: take off 10.
   - At 256 pixels you cannot see stall markings or door hardware. Do not claim them.

## Reporting

- Repeat each `source` and `confidence` an op returned next to the signal it backs.
- Repeat every assumption an op returned, word for word.
- A route or door from an inferred part of the model is a guess. Say so.
- Cite the evidence source as `costar`, `aerial`, `vexcel` or `scan`.

## Score bands

- 80 to 100. Step-free route very likely, with strong evidence from two sources.
- 50 to 79. Probably usable, with gaps in the evidence.
- 0 to 49. Steps, stairs or slopes very likely block a wheelchair user.
