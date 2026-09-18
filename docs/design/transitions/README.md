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
| `Grid.dc.html` | The corner block shapes, drawn, and why they close at four materials |
| `Blocks.dc.html` | A block is what the artist places: a rule over its faces, not a fixed assignment |
| `Archetypes.dc.html` | An archetype owns a vocabulary of slots; the corner set is the floor's, not everyone's |
| `Shapes.dc.html` | The fifteen corner masks sorted by what they are; what an archetype actually settles |
| `Seams.dc.html` | A wall turning a corner, mitred or drawn, and why that decides whether a second kind of tag exists |
| `Material.dc.html` | Project settings › Materials: a material's art page, corner block and named slots |
| `Layers.dc.html` | Block, material, archetype, transition — and what each replaces |
| `Authoring.dc.html` | Project settings › Transitions, sketched before the block and archetype existed |
| `Format.dc.html` | `papercut.json` and the GID scheme, likewise an early sketch |
| `canvas.json` | Canvas layout and the open questions as notes |

The boards are exploratory. `Main`, `Authoring` and `Format` were drawn
first, when a transition between materials looked like the whole answer;
`Blocks`, `Shapes` and `Layers` came out of the conversation that followed,
and are closer to right. Nothing here is decided.

The model moved twice while these were drawn, and the boards are kept in
the order they were made rather than tidied, so the reasoning is legible.

First correction: `Shapes` was redrawn because its first version enumerated shape vocabularies
per archetype and drifted into blob-style eight-neighbour matching, which
would mean authoring 47 tiles where 16 do. Authoring stays on the corner
model. Inside and outside corners are already among the fifteen drawn masks;
what an archetype settles is which PLANE those four cells lie in, the tile's
aspect, and whether the archetype has seams where two faces meet at an
angle.

Second correction, and the current reading: the sixteen-tile corner set is
the FLOOR archetype's vocabulary, not a universal one with bolt-ons. An
archetype owns a vocabulary of slots — floor's are corner masks, wall's are
named parts including its seams, ramp's are parts at a root-2 aspect. See
`Archetypes.dc.html`. `Shapes`, `Seams` and `Material` predate it.

Matched against `packages/ui` tokens the same way the other canvases are.

The block images are generated, not drawn: flat colour scaffolding rendered
by a script so the boards show the real arrangements rather than a sketch of
them. They are gitignored; regenerate with the snippet in the session, or
redraw them from `CORNER_BLOCKS`'s tables in `@papercut/geometry`.

## Format

`.dc.html` (Design Components). Each file is one artboard; `canvas.json`
places them. They render on a canvas published as an Artifact.
