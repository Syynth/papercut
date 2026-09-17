# Terrain, version 1

The terrain system as decided on 2026-09-12 and 2026-09-13 and prototyped in
[`design/terrain-tools.html`](design/terrain-tools.html). This is the target
the rework builds toward; the decisions themselves and their reasons are in
[`decision-log.md`](decision-log.md) under those dates. Where this document
and the log disagree, the log wins and this document is wrong.

The words used here are defined in [`../CONTEXT.md`](../CONTEXT.md).

## 1. The voxel volume

A voxel volume is a box of cubes: `size.width` along x, `size.height` along z
(the names are the map's, kept from the heightmap), `layers` along y. One cube
is one tile on every side. A voxel is either air or a **material** plus a
**shape**.

```ts
interface VoxelStructure {
  kind: 'voxel'
  size: { width: number; height: number }
  layers: number
  voxels: {
    /** The id of a material in the project's library, or AIR. One entry per voxel. */
    material: number[]
    /** A Shape. One entry per voxel; meaningless for air. */
    shape: number[]
  }
  /** Per-face material overrides, keyed `x,z,y,dir`. */
  faces: Record<string, number>
  paint: {
    /** `x,z` -> packed 0xRRGGBB. Unchanged from the heightmap model. */
    tint: Record<string, number>
    /** Escape hatch: `x,z,y,dir` -> a tile on a sheet, drawn instead of the derived one. Not built yet. */
    stamp: Record<string, string>
  }
  /** Water surface per column in half-tiles, or NO_WATER. Interim: the Water tool replaces this. */
  water: number[]
}
```

Voxel index is `(y * size.height + z) * size.width + x`. Every per-voxel and
per-column field stays a flat `number[]` addressed by index, because the patch
applier and the dirty-chunk derivation index `terrain[field][index]`
generically and the store derives the cell from the index.

### Shapes

| Shape | Top surface, in half-tiles above the voxel's floor |
|---|---|
| `block` | 2 everywhere |
| `slab` | 1 everywhere |
| `ramp(dir)` | 2 at the edge opposite `dir`, 0 at the edge facing `dir`, planar between: 45°, one tile of drop per cell of run |
| `halfRamp(dir)` | 1 at the edge opposite `dir`, falling at 45° to 0 at the middle of the cell, 0 from there to the edge facing `dir` |
| `halfRampUp(dir)` | the same wedge riding a slab: 2 at the edge opposite `dir`, falling to 1 at the middle, 1 to the edge facing `dir` |

`dir` is the direction the ramp descends toward, in the map's direction order
(east, south, west, north). A ramp never chooses its slope: a drop of N tiles
is a run of N ramp cells, and an odd half-tile is finished by one half ramp.
Which half ramp depends on where the odd half-tile is: when the low side
stands on a whole tile the run ends at the top with a `halfRamp`; when the
low side stands on a slab the run starts at the bottom with a `halfRampUp`,
so every full ramp in the run still has a whole-tile floor.

Until the mesher draws the wedge, a half ramp meshes as the plane through its
high and low edges, and `cornerHeights` reports that same plane, so walking,
grounding and rendering agree.

### Heights are derived

Nothing stores a height. The column top at `(x, z)` is the highest non-air
voxel and its shape; `cornerHeights` and `voxelTop` are computed from that,
in half-tiles, exactly as they were read from the heightmap, so
`groundHeight`, object grounding, the layer view's cap and the sketch frame
keep their meaning. `HALF` stays the world unit of a half-tile.

### Materials on voxels

Every voxel carries one material. Raising a column adds voxels of the
column's top voxel's material, so grass stays grass as it rises and the new
side faces show that material's side art (§3). A column that was empty takes
the map's first material. A face override (`faces`) sets the material one
face of one voxel is drawn with, at the stable address `x,z,y,dir` where
`dir` is 0–3 for the sides, 4 for the top, 5 for the bottom. This is the
cliff paint layer's address with a level that is now a layer, and it keeps
the dormancy invariant: sculpting never touches `faces`, so an override on
a face that stops existing waits for the face to come back.

## 2. Terrain sets

A **terrain set** is a sheet image plus a sidecar file next to it that says
what every tile on the sheet is, the way Tiled's terrain sets do:

```jsonc
// ground.terrain.json, beside ground.png
{
  "version": 1,
  "sheet": "ground.png",
  "tile": 16,                       // pixels per tile, square
  "columns": 16, "rows": 8,         // the sheet's size in tiles
  "terrains": [
    { "id": "grass", "name": "Grass", "color": "#4f8a46" },
    { "id": "path",  "name": "Path",  "color": "#b08f5e" }
  ],
  "tiles": {
    // tile index (row-major on the sheet) -> corner tags NW, NE, SW, SE.
    // null is nothing: the edge of the ground, or the top of a cliff.
    "0":  ["grass", "grass", "grass", "grass"],
    "17": ["grass", "grass", "path",  "path"],
    "40": ["grass", null,    null,    null]
  }
}
```

The tags are the whole model. A tile is authored as the transition it shows,
half grass and half path, and tagged with the terrain at each corner. There
is no fixed layout; position on the sheet means nothing to the renderer.

The **template** is how tags get filled without tagging by hand: placing it
on a 4×4 block for a pair of terrains (A, B) tags the sixteen tiles by
position, corner k holding B when bit k of the tile's index in the block is
set and A otherwise, in the order NW=1, NE=2, SW=4, SE=8. Placing it with
A = nothing makes B's **edge set**. Art drawn to the template is wired in one
placement; art that was not is tagged one corner at a time. Both are editor
operations on the sidecar; the map never sees them. The editor's is the
Terrains section of Project settings, after Tiled's terrain editor (decision
of 2026-09-14): the sheet as an image with its terrain list beside it, a
terrain picked and corners tagged by clicking or dragging over the tiles,
each tagged corner drawn as a translucent quadrant in its terrain's colour.
A stroke is one write of the sidecar.

The project's materials point into terrain sets (ruling of 2026-09-14: the
library is the project's, in `papercut.json`, never a map's; a map stores
only the ids its voxels hold):

```ts
interface MaterialDef {
  /** Stable, never reused; what a voxel stores. */
  id: number
  name: string
  /** Fallback colour when no sheet is loaded, and the swatch. */
  color: number
  role: 'top' | 'wall' | 'any'
  /** The terrain this material's top faces are drawn with. */
  top: { sheet: string; terrain: string }
  /** The terrain its side faces are drawn with; the top terrain when absent. */
  side?: { sheet: string; terrain: string }
}
```

A material with a `side` is one thing, grass-topped dirt, and needs no wall
painting to look right. The order of `materials` on the project is the
**priority**: it decides which terrain is the shape when a template is
placed for a pair, and the layering of composited corners (§3). Nothing
else reads it.

## 3. Rendering: the dual grid

Every face is a 2D grid of tiles. Top faces form the cell grid. A side face
is a grid too: run along the side as one axis, layers as the other. The
tile drawn at a **corner** of that grid is looked up from the terrains at the
four faces around the corner, and it is drawn whole, centred on the corner.
Since a face may sit at a different height from its neighbour, the mesher
emits each face as four **quarters**, each sampling the quadrant of the
corner tile that falls inside this face. On coplanar ground that is
pixel-identical to whole offset tiles, and the mesher may emit whole tiles
there as an optimisation; where a height edge crosses a corner the split
lands on it.

### What a face sees at its corner

From a top face's point of view, the four cells around a corner are:

- its own material where the neighbour is off the volume;
- **nothing** where the neighbour's top along the shared edge is lower;
- the neighbour's material otherwise, including where the neighbour is
  taller. A taller neighbour of the same material continues the ground with
  no rim at the foot of the cliff (tentative ruling); a taller neighbour of
  another material meets it with that pair's transition.

"Lower" and "taller" compare the corner heights along the shared edge, not
the cell tops, so a ramp's low edge meets the ground it lands on as
connected and its high edge continues the plateau.

From a side face's point of view the four bands around a corner are the
bands above, below and beside it on the same side of the same or adjacent
cell; the top surface above the top band and the ground below the bottom
one are nothing; a bend in the face counts as connected through the corner
(deferred: the mesher treats a bend as an edge for now).

### The lookup

For the four terrains at a corner, in order NW, NE, SW, SE:

1. The tile tagged exactly so, if the terrain set has one. Any number of
   distinct terrains; nothing is ever refused.
2. Otherwise a **composite**, drawn from tiles that always exist: the lowest
   terrain in priority order from its edge set, masked to the corners that
   are not nothing, then each higher terrain's edge-set tile masked to its
   corners, over it.

Composites are baked, once per distinct combination, into the **runtime
atlas** the terrain is textured with, alongside the authored tiles of every
terrain set the map uses. The mesher only ever asks the atlas for a tile id
and a quadrant; it never composes. The atlas records which of its tiles are
composites and for which combination, and the editor shows that: a mark on
each composited corner while "Show missing" is on, and a count of distinct
missing combinations, named, in the status bar. A combination that meets
nothing at a cliff edge is its own entry, named with "edge". Drawing the
tile and tagging it is what makes an entry go away; an exact tile always
wins over the composite.

### Ramps and slabs

A ramp's top is a sloped quad, autotiled as a top face by the rule above.
Ramp art is not a separate strip in this version; the ramp takes its
material's top terrain and the texture follows the slope. The √2-tall ramp
strip logged on 2026-09-13 is a later addition to the terrain set, keyed by
which side neighbours are ramps in the same direction. A slab's top is a top
face at half height; its side bands are one half-tile tall and take the
lower half of the tile.

Side faces beside a ramp are clipped to the slope, as today; the wall's
mask treats the cut as an edge.

## 4. The Terrain tool

Sculpt and Paint, as the two modes of one rail item. Every parameter that
is a number is a **scrub field**: drag sideways to change, click to type,
arrow keys to nudge, shift for coarse steps.

### Sculpt

| Verb | Parameter | What it does |
|---|---|---|
| Raise (shift lowers) | Strength, half-tiles per pass | Each column's top moves by the strength; voxels are added with the top voxel's material or removed from the top |
| Flatten | Height, half-tiles, sampled at the press and editable | Each column's top is set to the height |
| Smooth | Strength | Each column's top moves toward the mean of its four neighbours by at most the strength |
| Ramp | none | Press a cliff face and drag back onto the high side; the run grows one cell per cell of drag, up to what the drop needs, and the preview shows its cells. The slope is fixed, so on release the run the drop needs is cut whatever the drag reached. Where the ground behind the edge is not level with it, is already sloped, or the run would leave the volume, the bar says why and nothing is cut. Click any cell of a ramp to remove the whole run; shift-click removes |

Strokes keep the boundary-crossing rule with its dead zone. Rectangle and
flood-fill stroke shapes and the square and round brushes stay. Water is
not a sculpt verb: the interim pooling verb stays in the bar, marked
interim, only until the Water tool (2026-09-12 ruling, §7 step 5) replaces
it.

### Paint

| Verb | What it does |
|---|---|
| Material | On a top face: sets the top voxel's material. On a side band: sets that face's override. Shift on a band clears the override; shift on a top does nothing. Alt eyedrops from either |
| Stamp | Escape hatch, not built in this version: one tile from a sheet onto one face |
| Tint | Unchanged |

The active material is a chip in the bar that opens the picker; the bar
shows the other materials as chips beside it.

### The Materials section

The Terrain inspector lists the project's materials in priority order, drag to
reorder, with a swatch from the terrain set, the role, and how many voxels
and faces use each. Selecting one shows its top terrain's edge set, which
transitions to the other materials are authored in its terrain set and
which are not, and the actions: rename, duplicate, edit terrain set, delete.
New materials are added here. Every edit is `project.materials.set` with
the whole list, on the host's project actor; it is a project setting, not a
document edit, so it is not undoable.

## 5. Commands

All under the `terrain` owner, plain data, no ambient state:

| Command | Arguments |
|---|---|
| `terrain.raise` | `structure, cells, delta` (half-tiles, signed) |
| `terrain.flatten` | `structure, cells, height` |
| `terrain.smooth` | `structure, cells, strength` |
| `terrain.ramp` | `structure, edge: { x, z, dir }, run` |
| `terrain.ramp.clear` | `structure, cell` |
| `terrain.material` | `structure, cells, material` |
| `terrain.face` | `structure, faces: [{ x, z, y, dir }], material \| null` |
| `terrain.tint` | `structure, cells, tint \| null` |
| `terrain.params`, `terrain.brush.resize` | as today |

`terrain.paint.top`, `terrain.paint.cliff` and `terrain.paint.tint` are
retired; `terrain.face` and `terrain.tint` take their place. `terrain.water`
stays until the Water tool replaces it (§7, step 5).

## 6. Format

`formatVersion` becomes 3, then 4 when the materials and the resolution
profile move to the project (2026-09-14). Per the 2026-09-12 ruling there is
no migration: an older file is refused. The sample map is regenerated in the new shape
and the baked fixtures with it.

The placeholder generator produces the sheet `ground.png` and its terrain
set in memory, for the project's texel density. A new project writes them
into its `sheets/` folder beside the sidecar, so the folder stands on its
own (2026-09-14); the editor, the export CLI and the tests otherwise draw
their own: an edge set
per material and transition blocks for every pair of the sample map's
materials that meet, drawn the way the prototype draws them (a raster pass
that rounds and fillets the over-terrain's region, then rims it). Grass
keeps its 3 px bleed in the placeholder so the mechanism stays visible.

## 7. Order of work

Each step leaves `pnpm gate` green.

1. **Document.** The voxel model, shapes, derived heights, face overrides,
   patches, io at version 3, the ops (`raise`, `flatten`, `smooth`, ramp
   run and clear, material, face, tint), the sample map. The existing
   mesher keeps working through the derived `cornerHeights`.
2. **Terrain sets and the atlas.** The sidecar loader, the corner lookup,
   the composite baker, the runtime atlas, the placeholder generator.
   Pure data; no DOM.
3. **Mesher.** Faces from voxels, quarters, side faces in face space, the
   atlas's UVs. The section cap keeps its one byte per column.
4. **Tool.** The verbs on the new ops, the ramp drag, strength and height,
   scrub fields, the Materials section, the missing-transitions readout.
5. **Water tool.** Its own rail item per the 2026-09-12 ruling; the
   per-column `water` field is what it edits until water becomes a structure.
6. Later: the stamp brush and its picker, the √2 ramp strip, authored
   three- and four-way tiles as the artist wants them, whole offset tiles
   on coplanar ground, overhang caps in the layer view.
