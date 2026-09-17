# Transitions — design source

Artboard sources for the reframe of 2026-09-17: a TRANSITION between
materials is the thing the project holds, rather than a terrain set per
sheet. Drafted after the image library and the layout model, when the
per-sheet rule turned out to be a hard limit — `atlas.ts` takes an authored
tile only when every terrain at a corner shares one sheet — and when laying
RPG Maker art out to a sheet-shaped convention produced sheets that were
mostly void.

| File | Board |
|------|-------|
| `Main.dc.html` | What a material and a transition are, what it settles, how a corner resolves |
| `Blocks.dc.html` | The three block shapes, drawn, and why the model closes at four materials |
| `Authoring.dc.html` | Project settings › Transitions: the list, the chosen one, pointing at a block |
| `Format.dc.html` | `papercut.json` under the reframe, GIDs, and what today's data becomes |
| `canvas.json` | Canvas layout and the open questions as notes |

Matched against `packages/ui` tokens the same way the other canvases are.

The block images are generated, not drawn: flat colour scaffolding rendered
by a script so the boards show the real arrangements rather than a sketch of
them. They are gitignored; regenerate with the snippet in the session, or
redraw them from `CORNER_BLOCKS`'s tables in `@papercut/geometry`.

## Format

`.dc.html` (Design Components). Each file is one artboard; `canvas.json`
places them. They render on a canvas published as an Artifact.
