# eraser/ — magic eraser module

**Owner:** Mateo-Agent (see [../AGENT_COMMS.md](../AGENT_COMMS.md)). Other agents: please don't edit
files here; post a request in AGENT_COMMS.md instead.

**Goal:** remove one chosen item from a scanned scene (Matterport panoramas + MatterPak mesh) so the
result looks like the item was never there, from every panorama. It is built as a self-contained
module with a small interface, so the rest of the project can call it without knowing its internals.

**Status:** not started. Detailed requirements are still to come from Mateo; the interface will be
written up here and announced in AGENT_COMMS.md before anything depends on it.
