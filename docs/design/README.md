# Design

- [`five-modes-deep.html`](five-modes-deep.html) — the 2026-09-12 review of the editor's
  primary editing tasks, with mockups of the proposed chrome. **This is the spec for the
  UI revamp**: the token values in its `:root`, the rail / context bar / stacked-inspector
  frame, the Paint material palette, the Objects sprite palette, and the coverage
  placement. Open it in a browser; the viewports are drawn stand-ins, everything else is
  literal. Published copy: https://claude.ai/code/artifact/9882467f-9c7f-417a-b31f-ad3f3a80ae58
- [`select-first.html`](select-first.html) — the 2026-09-12 frame, worked interactively: the
  rail of subject tools with Select first, the all-icon context bar with tooltips, the
  stacked inspector, the library sections, and the slicer-style layer view. **This
  supersedes the frame half of `five-modes-deep.html`**; the decisions it records are in
  `docs/decision-log.md` under that date. Published copy:
  https://claude.ai/code/artifact/66edd969-eb88-42e7-a6f8-7929811ee063
- [`terrain-tools.html`](terrain-tools.html) — the 2026-09-13 Terrain and Water tools on the
  `select-first.html` frame: the Paint bar as Material / Stamp / Tint with the active
  material as a chip, the Materials library section (each material's edge set and which
  transitions to other materials are authored), the Sculpt bar as Raise / Flatten / Smooth /
  Ramp with Strength and Height as scrub fields, and Water as a rail item with Fill / Drain
  and a Level scrub. The viewport is a live paint demo of true dual grid: a generated 16 px
  sheet holds authored transition tiles (half grass, half path) tagged per corner, the tile
  at every cell corner is the one tagged like its four cells, and the face view shows one
  row's cliff as the grid it is so bands can be painted. Pairs nobody authored fall back to
  each side's edge set and are counted in the status bar. Below the frame, a static mockup
  of terrain-set setup: Tiled-style corner tags underneath, an RPG Maker-style template
  stamp per pair on top. The decisions it records are in `docs/decision-log.md` under that
  date. Published copy:
  https://claude.ai/code/artifact/49647e2f-c4ab-45d6-9472-4c308f52df16
- [`project-flow/`](project-flow/README.md) — the 2026-09-14 project format and flow as a
  design canvas: a project is a folder anchored on `papercut.json`; the startup screen's two
  doors and kind-badged recents mirror brink; the editor's project popover; and Project
  settings in brink's rail-and-scope modal with LDtk's shape — Sheets (image management),
  Terrain sets (the sidecars and the project-wide "to author" list) and Materials (the
  library, now a project setting). The decisions it settled are in `docs/decision-log.md`
  under that date. Published copy:
  https://claude.ai/code/artifact/ce6e13d2-54a1-44c4-a23d-b83a4123c009
- [`terrain-tagger/`](terrain-tagger/README.md) — the 2026-09-17 pass over the Terrains
  section after the first build did too much: Tiled's pieces and nothing else — the sheet
  filling the window, a short terrain list, a brush, undo — plus two close-ups of a tagged
  corner and a stroke, and the list of what was cut. Decisions of 2026-09-14 (Tiled-style
  editor) and 2026-09-17 (undo) in `docs/decision-log.md`. Published copy:
  https://claude.ai/artifact/Q43q95uxyewMnPbtR1grhM
