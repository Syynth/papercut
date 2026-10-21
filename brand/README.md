# papercut brand assets

The logo is the lowercase **p** from Bricolage Grotesque (heavy), extended into an
isometric block, sliced, with the top half lifted off; it stands in three gridded
planes with red/green/blue axes. Why it looks this way is in
[`docs/decision-log.md`](../docs/decision-log.md) ("papercut's logo is the sliced block p").

Every file comes in a light version and a `-dark` version for dark backgrounds
(designed against `#16191F`). PNGs are 4096px wide with transparent backgrounds.

| File | What it is |
|---|---|
| `papercut-mark.svg` / `.png` | The mark alone. |
| `papercut-mark-animated.svg` | The mark with a one-shot intro animation (CSS inside the SVG). |
| `papercut-mark-loop.svg` | The same intro, then the top half bobs over the cut forever. The editor's startup screen shows the dark one. |
| `papercut-wordmark.svg` / `.png` | "papercut" with its cardboard edge, outlined (no font needed). |
| `papercut-lockup-horizontal.svg` / `.png` | Mark beside the wordmark. |
| `papercut-lockup-stacked.svg` / `.png` | Mark above the wordmark. |
| `papercut-mark.glb` | The mark as a 3D scene. |
| `preview-svg.html` | The animated SVGs, light and dark, with a replay button. |
| `preview.html` | The 3D model, through its logo camera, with orbit and a light/dark switch. |

Serve this folder to view the previews (`python3 -m http.server --directory brand`,
or the `brand` entry in `.claude/launch.json`); opened from disk, the 3D preview
cannot load its model.

## Animating the SVG

The mark's parts are named groups:

| id | Part |
|---|---|
| `pc-planes` | Floor, back wall and side wall, with their grid. |
| `pc-axes` | The red, green and blue axes and their dots. |
| `pc-shadow` | The block's shadow on the floor (its own opacity: 0.13 light, 0.35 dark). |
| `pc-bottom` | The navy lower half, with the paper cut face. |
| `pc-top` | The red upper half. |

`pc-top` is drawn closed and lifted by `transform="translate(0 -56)"`; animating its
`transform` between `translate(0px, 0px)` (closed) and `translate(0px, -56px)` (the
logo) opens and closes the cut. Units are the mark's own, so this holds at any size.
`papercut-mark-animated.svg` shows one such animation, and `papercut-mark-loop.svg`
adds a bob (between `-56px` and `-64px`, every 3.2s) after it; both skip the motion
under `prefers-reduced-motion`.

## The 3D model

Named nodes, so each part animates on its own: `papercut` → `p_bottom`, `p_top`
(each with `_face`, `_sides` and `_cut` meshes), `planes` (`floor`, `back_wall`,
`side_wall`) and `axes` (`axis_x`, `axis_y`, `axis_z`, each a `_line` and its `_dots`).

- `camera_logo_iso` is an orthographic camera that reproduces the logo exactly.
- The `split` clip (1.2s) lifts `p_top` from closed to its logo position.
- Heights are scaled by 0.786, the logo's own vertical scale, so that camera
  matches; from other angles the p reads slightly squat.
- 1 unit = 1 m; the block is about 1.05 m wide and deep.
- The logo's ink outlines are a 2D drawing effect and are not in the model.

## Regenerating

Everything here is generated from the glyph, not drawn by hand:

```sh
uv run brand/source/export_brand.py
```

It needs [uv](https://docs.astral.sh/uv/) and `rsvg-convert` (`brew install librsvg`).
`source/mark.py` builds the geometry (the extruded, sliced p and its frame);
`source/export_brand.py` holds the palettes and the animations, and writes every
file above. The font is vendored in `source/fonts/` under its license (SIL OFL).
