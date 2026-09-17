# Terrain tagger — design source

Artboard sources for the Terrains section redone as Tiled's terrain editor
(decisions of 2026-09-14 and 2026-09-17), drafted 2026-09-17 after the first
build did too much: the sheet at a size it can be tagged at, a short list of
terrains, a brush, undo.

| File | Screen |
|------|--------|
| `Main.dc.html` | Project settings › Terrain sets, filling the window: tools row, terrain list, the sheet at 100 % |
| `Corner.dc.html` | How a tag becomes a tile on the map, in three steps, on a real converted block |
| `Cuts.dc.html` | What the first build had that goes, and what is added |
| `canvas.json` | Canvas layout and the decisions as notes |

Matched against `packages/ui` tokens the same way `docs/design/project-flow`
is; the modal, rail and list are that canvas's.

The sheet on the boards is real: crops of an RPG Maker MZ `Outside_A2.png`
as `scripts/import-mz.mjs` converts it, with the tags its sidecar carries.
Those PNGs are licensed art, so they are **not committed**; `.gitignore`
keeps them out. To re-seed the canvas, crop them from a converted project's
`sheets/mz/Outside_A2.png` into this folder:

```bash
sips -c 192 192 --cropOffset 0 192 Outside_A2.png --out pair-block.png   # Dirt over Meadow, 4×4 block
sips -c 192 192 --cropOffset 0 0   Outside_A2.png --out meadow-block.png # Meadow edge set
sips -c 576 912 --cropOffset 0 0   Outside_A2.png --out stage.png        # the top-left 19 × 12 tiles
```

## Format

`.dc.html` (Design Components). Each file is one artboard; `canvas.json`
places them. They render on a canvas published as an Artifact.
