---
name: property-search
description: How to turn a question about which properties fit into one property_query, and how to read the streets and places around a property with the area ops. Read it for any question that names a place, says these, here or nearby, or mentions highways, roads, traffic, noise, shops, schools, parks, transit or the neighbourhood.
---

# Property search

## Which properties

- Read `bounds`, `inView` and `filter` from the note "What the user sees now".
- "These", "here" and "on screen" mean the properties in view. Add
  `lat BETWEEN south AND north AND lon BETWEEN west AND east` from `bounds`.
- Keep the user's filter unless the user asks to drop it.
- A question with no place word covers every property. Add no bounds.
- "Houston" and "Los Angeles" are the two cities. Split them by longitude: Houston is east of
  -100.

## The query

- One `property_query` call. Select `id` and only the columns the answer and the scoring skill
  need. Leave out `name` and `address` unless the user asked for them.
- At most 100 rows come back. Add `LIMIT 100` and an `ORDER BY` that puts the likely best first.
- When `truncated` is true, say how the answer was cut.

## Roads

- A highway is a `near_roads` row whose `class` is `motorway`.
- "Away from a highway" means no such row under 300 m, unless the user names a distance.
- `near_roads` reaches 1000 m. A property with no row is far from that road class only when its
  `area_covered` is true. When it is false, say the roads are unknown for that property.

## Your maps

The area ops are your maps of the surroundings, and only you have them. The user's app does not
show them, so say what they found. Use them for one property, or for the few best rows after the
query. Read each op's description for the fields it returns, and quote those fields by name.

- Start with `area_summary`. It counts the nearby places by group, names the nearest of each
  group and gives the street the property fronts.
- Use `area_roads` with `roadClass: 'motorway'` for "how far is the nearest highway". Raise
  `radiusM` when nothing comes back, and say the radius you searched.
- Use `area_places` with one `group` for names, such as nearby restaurants, schools or parks. It
  lists them nearest first, with distance and bearing.
- Every distance is straight-line metres, not a walking or driving route. Say so.
- A question across many properties uses `near_roads` in the query, not one area call each.

## Reporting

- Repeat every assumption an op returned.
- Say which columns or places each match rests on.
