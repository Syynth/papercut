# Terrain tagger — design source

Artboard sources for the Terrains section redone as Tiled's terrain editor
(decisions of 2026-09-14 and 2026-09-17), drafted 2026-09-17 after the first
build did too much: the sheet at a size it can be tagged at, a short list of
terrains, a brush, undo.

| File | Screen |
|------|--------|
| `Main.dc.html` | Project settings › Terrain sets, filling the window: tools row, terrain list, the sheet at 100 % |
| `Corner.dc.html` | Two close-ups at 300 %: tagged corners; a stroke in progress |
| `Cuts.dc.html` | What the first build had that goes, and what is added |
| `canvas.json` | Canvas layout and the decisions as notes |

Matched against `packages/ui` tokens the same way `docs/design/project-flow`
is; the modal, rail and list are that canvas's. The sheet is a stand-in:
48 px tiles in four colours with template blocks tagged over them.

## Format

`.dc.html` (Design Components). Each file is one artboard; `canvas.json`
places them. They render on a canvas published as an Artifact.
