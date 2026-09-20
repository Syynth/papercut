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
