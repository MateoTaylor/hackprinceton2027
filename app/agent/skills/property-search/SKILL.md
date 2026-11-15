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

## Places and streets

The area ops are the map of the surroundings. Use them for one property, or for the few best rows
after the query.

- `area_summary` gives counts of nearby places by group, the nearest place of each group and the
  street the property fronts. Start here.
- `area_places` lists the places of one group, nearest first, with distance and bearing. Use it
  when the user asks for names or walking distances.
- Repeat each distance as straight-line metres, not a walking route.

## Reporting

- Repeat every assumption an op returned.
- Say which columns or places each match rests on.
