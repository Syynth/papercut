# Images — design source

Artboard sources for the image library (decisions of 2026-09-17): the Sheets
section becomes Images, planned for every image kind with tilesets worked
through now; each tileset carries a grid (tile, margin, spacing) and draws at
a whole-number scale of the project's density; one import dialog offers the
sizes that fit over a live grid; the terrain editor picks tilesets through
the rich typeahead every asset picker will be.

| File | Screen |
|------|--------|
| `Main.dc.html` | Project settings › Images › Tilesets: the list with grid and status, unlisted files, the selected tileset's grid |
| `Import.dc.html` | Import image: sizes that fit, margin and spacing, the live grid, what it comes to |
| `Picker.dc.html` | The tileset picker in the terrain editor, as a rich typeahead |
| `Kinds.dc.html` | Sprites, Textures, Animations as placeholder tabs |
| `canvas.json` | Canvas layout and the decisions as notes |

Matched against `packages/ui` tokens the same way `docs/design/project-flow`
is; the modal, rail and table are that canvas's.

The thumbnails are crops of licensed art — converted RPG Maker MZ sheets and
a 16 px kit — so they are **not committed**; `.gitignore` keeps them out. To
re-seed the canvas, cut them into this folder from a converted project's
`sheets/mz/` and the kit:

```bash
sips -c 64 64 --cropOffset 0 0   mapkit.png     --out kit-thumb.png
sips -c 240 296 --cropOffset 0 0 mapkit.png     --out kit-preview.png
sips -c 96 96 --cropOffset 0 192 Outside_A2.png --out mz-thumb.png
sips -c 96 96 --cropOffset 0 0   Outside_A4.png --out mz-a4-thumb.png
sips -c 96 96 --cropOffset 0 0   Inside_A2.png  --out mz-in-thumb.png
```

## Format

`.dc.html` (Design Components). Each file is one artboard; `canvas.json`
places them. They render on a canvas published as an Artifact.
