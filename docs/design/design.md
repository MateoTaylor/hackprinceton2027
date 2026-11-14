# Propstar design system

Owner: Fahim-Agent. Read this before you change Propstar UI or UX. It gives the fundamentals:
colour, type, spacing, hierarchy and how common elements behave. Motion, hover and focus live in
[`interactions.md`](interactions.md).

## Source of truth

The Paper file "HackPrinceton" is the design. The "Propstar UI" page holds the approved screens.
The "Brand guidelines" page holds the brand page. When this doc and Paper disagree, Paper wins.

- Read exact values with Paper's `get_computed_styles` and `get_jsx`. A screenshot shows layout,
  but its sizes and colours are guesses.
- Scores, counts and names in the mockups are placeholders. Real values come from the data.

## Colour

Propstar is a dark UI that floats over aerial imagery. Define the tokens once as CSS variables.

| Token | Value | Meaning |
| --- | --- | --- |
| `--bg` | `#0E0F11` | Page and sidebar |
| `--chrome` | `#000000` | App header |
| `--surface` | `#16181B` | Anything that floats: panels, map controls, pills, toasts |
| `--surface-2` | `#1F2226` | Cards, chips and tags inside a surface |
| `--border` | `#2A2D32` | Structural dividers, empty tracks, pending states |
| `--text` | `#F2F3F5` | Primary text |
| `--text-muted` | `#A1A7AE` | Secondary text |
| `--accent` | `#0054A6` | Primary actions and the selected thing |
| `--accent-bright` | `#3D8BDB` | Accent at small sizes: outlines, rings, status dots, progress |
| `--score-good` | `#148A60` | Score 80 and above |
| `--score-mid` | `#B07F22` | Score 50 to 79 |
| `--score-bad` | `#B23B33` | Score under 50 |
| `--overlay` | `#0E0F11B8` | Controls that sit on photos |
| `--compass` | `#E5604D` | Compass north tip, the one warm accent |
| `--shadow` | `#00000080 0 8px 20px` | Every element that floats over the map |

Rules:

- **Score colours come in two forms.** Use them solid on map pins and legend dots. Inside panels
  and toasts, use a dark tint: the score colour at about 20% alpha behind a brighter text colour of
  the same hue.

  | Band | Tint fill | Tint text |
  | --- | --- | --- |
  | Good | `#148A6033` | `#3DBB8C` |
  | Mid | `#B07F2233` | `#D9A94A` |
  | Bad | `#B23B3333` | `#E0675E` |

- **Separate by fill and shadow.** Anything floating over the map uses its fill plus `--shadow`.
  Borders are never white or translucent white. `--border` appears only as a thin structural
  divider.

## Type

Inter for all UI. The wordmark uses Gill Sans Light.

| Role | Size / line | Weight | Use |
| --- | --- | --- | --- |
| Display | 34 / 34 | Gill Sans 300 | The "propstar" wordmark only |
| Title | 18 / 22, or 15 / 20 in compact panels | 600 | Page, panel and quick-view titles |
| Body | 14 / 20, or 14 / 18 for names | 400, 600 for names | Messages, property names, primary text |
| Label | 13 / 16 | 500 to 600 | Buttons, pins, chips, filter values |
| Caption | 12 / 16, or 11 / 14 for small labels | 400 to 700 | Metadata, legends, status, score numbers |

Uppercase with wide tracking is for small source tags only. Keep subtext minimal: a secondary line
must carry data.

## Spacing and shape

Spacing follows a 4px scale. The common steps are 4, 8, 12, 16, 20, 24 and 32. Small in-between
steps such as 6 inside a pin are fine when Paper uses them.

| Radius | Value | Use |
| --- | --- | --- |
| `--radius-sm` | 8 | Small inner elements |
| `--radius-md` | 12 | Cards and images inside panels |
| `--radius-lg` | 20 | Large floating panels |
| `--radius-full` | 999 | Pills, chips, pins, icon buttons, map controls, toasts |

Floating elements sit 20px in from the map edges and keep at least 12px between each other.

## Hierarchy

On a dark map, emphasis comes from four levers, strongest first:

1. **Colour.** `--text` reads before `--text-muted`. Accent outranks everything, so it marks one
   selected thing at a time: one pin, the primary action in a view, the user's own messages.
   Score colours are data, never decoration.
2. **Weight.** 600 marks names and actions. 400 carries reading text.
3. **Size.** Keep a screen to two or three sizes. Similar controls share a size.
4. **Elevation.** `--surface` with shadow floats above the map. `--surface-2` groups content inside
   a surface. Nothing nests deeper than that.

## Elements

- **Buttons.** Icon buttons are round. Top-bar controls are 32, panels and map controls stay 40,
  and controls on photos and inside cards are 32. A primary button is filled `--accent`. Secondary buttons are
  `--surface` or `--surface-2` pills.
- **Pins and chips.** 32 tall, filled, full radius. A pin has one state at a time: default,
  selected (accent), scoring (pending) or scored (solid score colour). Show only one selected pin.
- **Floating panels and cards.** `--surface`, `--radius-lg`, `--shadow`, no border. Cards inside
  them use `--surface-2` and `--radius-md`.
- **Photo overlays.** Controls on photos are round 32 buttons in `--overlay` with white icons.
- **Selection.** Selecting a property centres the map on its building. Its quick view docks
  bottom-left of the map and never covers the building or its pin. The matching sidebar card is
  highlighted.
- **Map controls.** Round `--surface` clusters with 40 cells and `--shadow`, pinned to the map
  corners. An active toggle cell inverts to `--text` fill with a dark icon. The compass north tip
  is `--compass`.
- **Proppy.** The mascot is a transparent PNG. Place it directly on the surface that holds it,
  never on a white circle or backing. Call it "Proppy" in UI copy.
- **Progress.** Show counts, such as "Scored 6 of 14". We cannot predict how long the agent takes,
  so show no times or estimates.

## Adding new UI

- Start from the closest approved screen in Paper and build from the tokens above. A new token goes
  into Paper and this doc in the same change, with a Log entry in `AGENT_COMMS.md`.
- Every fact, filter and sort comes from CoStar, Matterport or Vexcel. Check
  `tools/smoke/README.md` and `kit/costar-hackathon-kit/index.md` before adding a field.
