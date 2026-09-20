# Terrain tools, redone for voxels: the design round of 2026-09-19

The boards of the round, as published on the design canvas. **Proposed, not decided**, except the two
decisions logged that day: the surface verbs stay and block editing is added; and what a new face starts as
is a choice on the tool. The boards are generated; their source of truth is the canvas.

| Board | What it shows |
| --- | --- |
| `Inventory.dc.html` | Every terrain tool in the app today: what it does, and what it cannot. The mismatch: the map is voxels, the verbs set column heights |
| `Rule.dc.html` | The proposal in one board: four modes (Sculpt, Build, Edges, Paint), one Footprint control shared by all, and the pressed face sets the direction a verb acts in |
| `Sculpt.dc.html` | Raise, Extrude, Flatten and Smooth redone; how a stroke feels; what a new face starts as |
| `Build.dc.html` | Block, the shape fills (Box, Wall, Cylinder, Dome, Stairs; Add or Carve; Solid or Hollow), and a Slice control for seeing inside |
| `Pieces.dc.html` | Ramps, slabs and stairs: four ways in, one way out |
| `Edges.dc.html` | Fringes, pickets and rails in one mode, drawn as lines and swept with the same footprints; an edge may take its trim from a named material |
| `Questions.dc.html` | The open questions, and an order to build in |
