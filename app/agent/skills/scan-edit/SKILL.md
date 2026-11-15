---
name: scan-edit
description: How to show a prepared Magic Eraser or Remodel edit of a scan picture. Read it for any request to remove, erase or hide an object in a scan, or to change, remodel, recolour or retexture a countertop, floor, wall, pillow or other surface.
---

# Scan edit

The demo holds prepared edits only, made ahead of time. Proppy makes no edit itself. Each edit
covers one panorama.

## Order of work

1. Find the property. Use the one the note "What the user sees now" shows as selected, or the one
   the user names.
2. `picture_edit_list` gives the prepared edits of the property. Pass `tool: 'erase'` for a
   removal and `tool: 'remodel'` for a surface change.
   - When it answers `no_data`, its hint names the properties that have prepared edits. Tell the
     user and offer to open one of them.
3. Pick the edit whose `command` matches the request. When none does, list the prepared commands
   and ask which one to show.
4. `picture_edit_apply` with the edit's exact `command`. It is a write op, so the user approves it
   first.
5. `view_open` with `panel: 'edit'` for an erase or `panel: 'remodel'` for a remodel, so the user
   sees the before and after.

## Reporting

- Say where the picture is, from `where`.
- Say that this is a prepared demo edit on one panorama, not an edit made just now.
- Repeat every assumption the ops returned.
- If the user rejects the approval, say that nothing changed.
