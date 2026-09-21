# Terrain tools, redone for voxels: the design round of 2026-09-19

The boards of the round, as published on the design canvas. **Proposed, not decided**, except the two
decisions logged that day: the surface verbs stay and block editing is added; and what a new face starts as
is a choice on the tool. On 2026-09-20 two more: the selection drives the terrain tools, and the
selection tools are built first, with the sculpt tools then iterated one at a time from use, so the boards are
proposals to draw on rather than a plan. The boards are generated; their source of truth is the canvas.

| Board | What it shows |
| --- | --- |
| `Inventory.dc.html` | Every terrain tool in the app today: what it does, and what it cannot. The mismatch: the map is voxels, the verbs set column heights |
| `SelectFirst.dc.html` | **Decided 2026-09-20:** the selection drives the terrain tools. Select, then the verb acts on what is selected, with handles and a ghost; with nothing selected a press is a selection that lasts one press |
| `Rule.dc.html` | The proposal in one board: four modes (Sculpt, Build, Edges, Paint), one Footprint control shared by all, and the pressed face sets the direction a verb acts in |
| `Move.dc.html` | Move: select voxels and drag them along any axis; what it leaves, what it lands on, its paint, what stands on it; and Move, Extrude and Raise as one family |
| `Sculpt.dc.html` | Raise, Extrude, Flatten and Smooth redone; how a stroke feels; what a new face starts as |
| `Build.dc.html` | Block, the shape fills (Box, Wall, Cylinder, Dome, Stairs; Add or Carve; Solid or Hollow), and the layer view range, decided 2026-09-12 and now to be wired, for seeing inside |
| `Pieces.dc.html` | Ramps, slabs and stairs: four ways in, one way out |
| `Edges.dc.html` | Fringes, pickets and rails in one mode, drawn as lines and swept with the same footprints; an edge may take its trim from a named material |
| `Regions.dc.html` | Selecting voxels: the Region half of Select (decided 2026-09-12, never built), with the shared footprints and a Depth of Surface, Through or Box; and what a selection is for: Fill, Extrude, Expand, Rotate, Copy as a stamp |
| `Questions.dc.html` | The open questions, and an order to build in |

## The selection tools, mapped out: design pass of 2026-09-20

Proposed, except step 1 of its build order, built on 2026-09-21: double-click takes the whole by each element's
default rule (Run, Flat, Island), a one-cell brush takes one element, hover shows what a click would take and
ctrl-hover what a double-click would, and Fill is retired. Step 2 followed the same day: triple-click takes the
next whole out (an edge's Loop, a top's Surface or a side's Wall, a voxel's Island), Follow slopes and Pair are in
the edge bar, and a voxel's default became Layer rather than Island (decision of 2026-09-21), so the boards' "Island"
default is superseded. What was built before that is Region mode, the three elements, brush, rectangle and fill, surface and
through, combine, and grow, shrink and invert. This pass maps the rest, with the aim that it stays simple: three
gestures and one Match menu, and everything specialised is what a double-click means.

| Board | What it shows |
| --- | --- |
| `SelOneWay.dc.html` | Click, drag, double-click for "the whole", triple-click for the next whole out; hover shows what a click would take; one Match menu with a default per element; changing element converts the selection |
| `SelEdges.dc.html` | What an edge is (top, foot, slope, corner), the full edge as a Run, the Loop, Follow slopes, Pair, and matching by kind or by trim |
| `SelFaces.dc.html` | Flat (connected and coplanar), Material, Tile, Surface with a Step, Wall and Band |
| `SelVoxels.dc.html` | Island, Layer, Column, Same piece; Box depth and air in a region; what is selected inside hidden layers |
| `SelSimple.dc.html` | The bar per element, the keys, an order to build in, and four questions |
| `SelIcons.dc.html` | The icon set for all of it: 35 glyphs on the app's 24-unit grid, each shown large, at the bar's 18 px, and assembled into the three bars. Their markup is in `selection-icons.json`, ready to go into `packages/ui/src/icons.tsx` as each control is built |
