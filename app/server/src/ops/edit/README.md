# Prepared picture edits

The Magic Eraser and Remodel panels, and the agent, run commands against pictures that were edited
ahead of time. Nothing is sent to the edit API. A command is matched to a prepared edit and the
panel swaps the before picture for the after picture.

## The drop folder

Put each property's pictures and one `manifest.json` in:

```
data/propstar/edits/<propertyId>/
```

`data/` is git-ignored, so the pictures never enter git. Today only 2838 Potomac Ave
(`residential-201926017`) is offered in the UI.

`manifest.json` lists the edits:

```json
{
  "edits": [
    {
      "id": "remove-floor-lamp",
      "tool": "erase",
      "command": "Remove the floor lamp",
      "where": "Living room",
      "before": "lamp-before.png",
      "after": "lamp-after.png"
    }
  ]
}
```

- `id` is letters, digits, `-` and `_`, unique in the file.
- `tool` is `erase` (Magic Eraser) or `remodel` (a new countertop, floor or pillow colour).
- `command` is the sentence the panel suggests. A typed command matches when its words, minus
  filler such as "the", "please", "remove" or "make", all appear in this one, or the other way round.
  Keep it short and name the object: "Remove the floor lamp", "Make the countertop white marble".
- `where` is optional. It names the room the picture shows.
- `before` and `after` are file names in the same folder: `.png`, `.jpg` or `.webp`, no folders, no
  leading dot. Use the same size for both, so the compare slider lines up.

Up to 20 edits per property. The server reads the folder on every call, so a new picture shows
without a restart. If the manifest does not parse or a picture is missing, the ops answer
`not_ready`.

`node app/server/src/ops/edit/placeholders.ts` writes labelled placeholder pictures for the demo
property. It does nothing if a manifest is already there. To hand over the real edits, replace the
placeholder pictures and the manifest in that folder.

## Ops

- `picture_edit_list {propertyId, tool?}` lists the prepared edits with their commands.
- `picture_edit_apply {propertyId, tool, command}` answers the matching edit with `beforeUrl` and
  `afterUrl`. An unknown command answers `no_data`, and the hint names the commands that exist.

Pictures are served at `GET /api/edits/<propertyId>/<file>` behind the API's localhost guard.
