---
name: accessibility-audit
description: Criteria for scoring how wheelchair-friendly a property is from its CoStar record, its aerial image and, later, its Matterport scans. Read it for any question about wheelchair access, step-free entry, mobility or ADA.
---

# Accessibility audit

Score step-free access for a wheelchair user, from the street to the main floor and between floors.
Start at 50 and move the score with each signal below. Cite every signal you use. Missing data
leaves the score where it is; say it was missing instead of guessing.

## CoStar record (`get_property`)

- **Year built.** 1991 or later was built under the ADA Standards, so add 10. Before 1991, take
  off 5 unless the record mentions a renovation.
- **Stories.** One storey needs no lift, so add 10. For two or more storeys, a commercial building
  of Class A or B usually has an elevator; Class C or older walk-ups often do not. Two or more
  storeys in a residential home means stairs to the bedrooms, so take off 15.
- **Parking.** A surface lot or garage that the record lists makes a drop-off and accessible stalls
  likely, so add 5. Street parking only, or no parking, takes off 5.
- **Type.** Single-family homes are rarely step-free at the door. Take off 10 unless other
  evidence shows a level entry.

## Aerial image (`view_aerial`)

- A paved path or sidewalk that joins the parking to the building without a visible stair: add 10.
- Parking right beside the entrance, or a covered drop-off: add 5.
- The building sits well above the street on a slope or on a raised podium: take off 10.
- At 256 pixels you cannot see stall markings or door hardware. Do not claim them.

## Matterport scans (not available yet)

When scans can be read, look for these. Until then, never cite them.

- Doors at least 32 inches clear. A standard door is about 36 inches wide.
- Ramps no steeper than 1 in 12, with a level landing at the door.
- An elevator for any floor above the entrance level.
- A threshold no higher than half an inch.

## Score bands

- 80 to 100. Step-free route very likely, with strong evidence from two sources.
- 50 to 79. Probably usable, with gaps in the evidence.
- 0 to 49. Steps, stairs or slopes very likely block a wheelchair user.
