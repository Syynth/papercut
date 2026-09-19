# One Materials section

A design pass of 2026-09-19 over the two Project settings sections that are
about the same thing: **Materials** (what each material draws, and what it
meets) and **Terrain sets** (tagging the corners that make it draw that). The
owner's premise: it does not make sense that they are separate. This document
inventories what each holds, says where the seam shows, and proposes one
section with the material as its subject and three views of it — the
assembled preview, the sheet for tagging, and a 3D fixture for anything with
a wall or a ramp in it.

| File | Screen |
|------|--------|
| `Main.dc.html` | Project settings › Materials, **Preview** view: Grass alone, the assembled patch with its three holes, the arrangements strip, the form with Meets |
| `Tag.dc.html` | The same section in **Tag** view, placing the Stone-over-Grass block: the Tagging block in the form, the block's values as a sentence, the tags it would write ghosted under the pointer |
| `Fixture.dc.html` | The **3D** view: the renderer's fixture for Grass meeting Stone, drawn as a stand-in — the fold, the fringe flap, the picket, a ramp nobody drew art for, and the marks on unanswered corners |
| `Placing.dc.html` | Spelling and placing transitions in five steps: spell the values, point, click, swap a value and place the next, a third value for a 6 × 6 block |
| `canvas.json` | Canvas layout, and the proposal and open questions as notes |

Published copy: https://claude.ai/artifact/AsSJRC2UoYhVzzBzyrB3yY

The art is the placeholder generator's (`generatePlaceholderTerrainSet(16)`
in `@papercut/fixtures`), not a licensed sheet, so the images are committed.
They were drawn the way the app draws them: the sheet at 2× with a 55 %
quadrant and a hairline per tagged corner and a faint grid; the pending block
as the 5 × 3 pair shape with `[Grass, Stone]` ghosted at 30 % over tile
(10, 12); the patch as `materials.tsx`'s BLOB shape run through `assemble`
at 2×, holes hatched; one 32 px PNG per arrangement Grass has a tile for.
Grass's arrangements 1, 6 and 9 were removed on purpose so the preview has
holes to show.

Nothing here changes the model. Tags stay the ground truth, a transition
stays a query over them, layouts stay automation that writes them (rulings of
2026-09-17). This is presentation, and it folds in
[#209](https://github.com/Syynth/papercut/issues/209).

## 1. Inventory

### Materials (`apps/editor/src/editor/materials.tsx`)

| Where | What it does today |
|---|---|
| Side list | Every material, grouped under Floor / Wall / Ramp by its `archetype`; flat colour swatch, name, a dot for "used in N maps". Foot: **New material**, **Duplicate**. |
| Tabs strip | Swatch and name of the subject; "meets *Other*" when a pairing is picked; the archetype the preview is drawn in; **Back to the material**. |
| Stage | The **assembled patch**: a blob of the material (or the MEETING shape for a pairing) run through the dual grid and blitted from the real sheets, cross-hatched wherever no tile answers. Beside it the **arrangements strip**, fifteen slot tiles (fourteen for a pairing). Hovering either lights the other. Readout: "*n* of 15 arrangements drawn · on *sheet*", or the hovered arrangement's name, kind and how many corners of the patch it draws. A note lists the archetype's non-ordinary slots (a wall's seams). |
| Form | **Name**, **Swatch** colour, **Archetype** select, **Fringe angle**, **Picket distance**. **Meets**: every other material grouped by the archetype the pairing is drawn in, each with drawn / missing / *n* / *m*, click to preview the pairing. **Priority**: position, **Move up** / **Move down**. **Delete** (the shared repaint dialog). "Used in *n* of *m* maps". |
| Empty state | "No materials" with the list and New material still there (ruling of 2026-09-19). |

Everything shown is computed from the tags across all loaded sets:
`coverageOf` asks, per arrangement mask, which sheet has the tile tagged
exactly so. Nothing on this screen writes a tag.

### Terrain sets (`apps/editor/src/editor/terrains.tsx`)

| Where | What it does today |
|---|---|
| Tools row | Sheet picker (rich typeahead with thumbnails, "*n* tagged", footer naming images that do not draw); sheet size; **Corners** / **Block** mode; **Undo** / **Redo**; zoom − % +. |
| Side, Corners mode | **Nothing**, then every material × every slot of its archetype as a flat list: *Grass*, *Grass · Fringe*, *Grass · Picket*, *Rock*, *Rock · Convex seam*… Dim when nothing on this sheet carries it; count of this sheet's corners that do. × on the active ordinary row deletes the material (ruling of 2026-09-19). |
| Side, Block mode | **Drawn over**: Nothing or a tag. **Drawn in**: one or two selects. **Add a third**. The shape follows: 5 × 3 for a pair, 6 × 6 for a triple. |
| Stage | The sheet at a whole-number zoom, every tagged corner a translucent quadrant with a hairline in its material's colour, the grid, the corner under the pointer outlined; in Block mode the pending block outlined, red when it does not fit or its values are not picked. Tooltip: tile, corner, what is there → what the brush would write; or what a click would place and why not. |
| Foot | Brush name and the gesture; in Block mode the values as "*A* + *B* over *C*", the shape, and the warning. |
| Behaviour | Click or drag tags corners; right-click tags nothing; a block lands whole on one click; each stroke or placement is one write of the project file and one step of a per-sheet undo history that lives while the section is open; ⌘ wheel zooms. |

Everything written here is what the Materials screen then reads.

### Related, and staying where it is

- **Images** keeps the grid, import, relink and **New from template…**, which
  draws a whole layout for a chosen list of materials and lists it with its
  `layout` so its tags are derived. It also shows an image's layout as
  derived fields.
- The **inspector's Materials picker** keeps its list in priority order with
  the real tile as swatch, and "Edit in Project settings…".

### Where the seam shows

1. **Two side columns, one list.** The tagger's palette is the project's
   materials wearing slot suffixes; the Materials list is the same materials
   grouped by archetype. The owner read the first as "terrain sets" (#209).
2. **See a hole, go elsewhere to fill it.** Materials shows the missing
   arrangement; filling it means switching section, finding the sheet, finding
   the material in the palette again, tagging, and switching back to check.
3. **The pairing is known on one screen and re-typed on the other.** Meets
   knows "Grass meets Rock, 3 of 14 drawn, drawn in the wall". Block mode asks
   for the same two things again as Drawn over / Drawn in, split between the
   tools row and the side, with the mode switch silently changing what the
   side column means.
4. **Per-sheet against project-wide.** The tagger counts a material's corners
   on *this* sheet; Materials counts arrangements across every sheet. A
   material whose art is spread over two sheets (now ordinary) has no one
   place that shows it.
5. **Flat previews for things that are not flat.** A wall pairing is previewed
   as a patch "in elevation", which cannot show the fold between a floor and
   its wall, a fringe flap, a picket, a seam, or a ramp's slope. The renderer
   can, and the marks it puts on unanswered corners are the most honest
   coverage readout there is.
6. **Delete, swatch and name** are edited in one place and used in the other.

## 2. Proposal: one section called Materials

The rail loses **Terrain sets**. **Materials** takes the `Library` frame
(tabs / side / stage / form) that Images and Materials already use, and the
stage switches between three views of the selected subject. The subject is
what it is today: a material, or a material meeting another.

```
┌ subject bar ──────────────────────────────────────────────────────────────┐
│ ■ Grass ◇▯◢  meets  ■ Rock · in the wall · 3 of 14 drawn   ⌘Z ⌘⇧Z − 200% + │
├ side ──────────┬ stage ─────────────────────────────────┬ form ────────────┤
│ By priority    │              [ Preview | Tag | 3D ]    │ Name  Swatch      │
│ ■ Grass ◇ 14/15│   Preview: the patch + the strip       │ Fringe  Picket    │
│    on its own  │                                        │ Priority          │
│    meets ■Path │   Tag:  the sheet, tags, hover, block  │                   │
│   ▸meets ■Rock │                                        │ Meeting Rock      │
│   [New transition…]  3D: a fixture the renderer draws   │  in the wall      │
│ ■ Path  ◇ 15/15│                                        │  3 of 14 drawn    │
│ ■ Rock ◇▯  9/15│                                        │  [Place block…]   │
│ New material   │                                        │ Delete            │
│ Duplicate      │                                        │ Tagging (Tag view)│
└────────────────┴────────────────────────────────────────┴───────────────────┘
```

The selected material **expands in the side list**: under it, a vertical
list of its subjects — *on its own*, then *meets X* for every other
material, each with its coverage and the face it is drawn in — and a
**New transition…** button below them that opens the spell-and-place
control. The lit row is the subject of every view: what Preview assembles,
what Place a block writes, what the 3D fixture is built for. The bar across
the top only names that subject. A first draft put the pairings as chips in
the bar; the owner moved them here, where they read as part of the material
and stack without competing for width (the owner's directions of
2026-09-19, on the canvas).

### The side column is the materials list, and only that

One list, in priority order, with a swatch and a name. It is no longer
grouped under Floor / Wall / Ramp: a material is not one of those any more
(ruling of 2026-09-18), so each row carries small **face icons** — floor,
wall, ramp — lit for the faces it has art for and dim for the rest (the
owner's direction of 2026-09-19, on the canvas). Two more changes:

- The count beside each is **project-wide coverage** — "14/15", from
  `coverageOf` — in place of the tagger's per-sheet corner count. A material
  with no art anywhere is dim, as an untagged palette entry is today.
- The **slots** stop being separate rows. A material's parts — *Surface ·
  Fringe · Picket*, and a wall's *Convex seam · Concave seam* — are a chip
  row in the Tagging block, the brush's slot when tagging corners, with
  Surface chosen by default. Nobody has to read *Grass · Fringe* as a thing
  of its own again.

Selecting a material selects the subject for every view and makes it the
brush. **New material** and **Duplicate** stay at the foot. **Nothing** leaves
the list: right-click still tags nothing, and Tag view gets an explicit
**Erase** tool beside Tag corners for anyone who does not know that.

### The form column is about the subject

Unchanged at the top: Name, Swatch, Fringe angle, Picket distance,
**Priority**, **Delete**, "used in *n* maps". The Meets list is gone from
here; the pairings live under the material in the side list. Two additions:

- When a pairing is lit, a **Meeting** block says which face it is drawn in
  and how much of it is drawn, with **Place block…** (and **Draw a
  template…** when there is no sheet to place it on). This is the CREATE
  action the 2026-09-17 ruling put beside the pairings, which today lives
  only in Images. Place block switches to Tag view with the block's values
  already filled in from the pairing, and the sentence in the foot says so.
- In Tag view, a **Tagging** block at the top of the form holds the sheet
  picker, the tool (**Tag corners** / **Erase** / **Place a block**) and, for a
  block, the transition **spelled** as its values: three pickers — *under*,
  *over it*, *third* — and one button, **Place on the sheet**, which arms the
  pointer. The values default from the subject: a material alone is its edge
  set against nothing; a pairing is the later material over the earlier, by
  priority. After a block lands the spelling stays, so the artist swaps one
  value and places the next; filling the third slot makes the block the 6 × 6
  for three materials meeting (the owner's direction of 2026-09-19, on the
  canvas; `Placing.dc.html` walks the steps).

That puts the block picker and its values together, next to the Meets list
that motivates them, and stops the side column changing meaning with the
mode — the three things #209 lists. The tools row keeps only what belongs to
the view: undo, redo and zoom in Tag view; the face switch in Preview and 3D.
The view switch itself is not in the tools row: it floats on the stage, top
right, the way a viewport control does (the owner's direction of 2026-09-19,
given on the canvas).

### The stage: three views of the subject

**Preview** is today's stage: the assembled patch and the arrangements
strip, lighting each other. The strip changes shape: when the subject's
tiles sit together on one sheet, which a placed block or a drawn template
guarantees, it is a **crop of that sheet** with the missing tiles hatched in
place, so the artist sees where the tiles are and where the holes go. Only
when they are scattered does it fall back to a grid of tiles, wrapping to
the stage's width (the owner's direction of 2026-09-19, on the canvas). Two
additions. The strip's tiles become links:
clicking a drawn one opens Tag view on that sheet scrolled to that tile;
clicking a missing one opens Tag view with the brush set to the subject and
the slot's arrangement named in the foot. And for a subject that spans
faces, a **Floor / Wall / Ramp** switch in the tabs strip picks which face
the patch is assembled for (see §4 on the archetype field).

**Tag** is today's tagger, with the brush and the block values coming from
the side and form columns instead of its own. It keeps the sheet picker
(moved into the Tagging block), the canvas with tags, the hover outline and
tooltip, the pending block, per-sheet undo, ⌘ wheel zoom, and the write on
release. One addition from #209: in Place a block the pending block shows
the **tags it would write** under the pointer, not just an outline, so what
a click does is visible before the click. The ghost is opaque enough to read
over the sheet, and the over material's region is drawn as a shape — its
convex corners rounded, its concave ones filleted, the way the art rounds —
rather than as four flat quadrants, so where each material lands is plain
(the owner's direction of 2026-09-19, on the canvas). The default sheet is
the one that holds most of the subject's tags.

**3D** is new: the subject on a fixture the real renderer draws.

### The 3D view

A `RuntimeScene` (the runtime's, the thing the map viewport wraps) fed a
small synthetic map and the project's real loaded sets and materials, drawn
into its own canvas on the stage with a fixed orbit the pointer can drag.
Nothing is mocked: the atlas, the mesher, the fringe flaps, the pickets,
the seams and the fallback are the map's own, and **Show missing** is on,
so a corner no tile answers carries the same magenta mark it would carry in
the level. The fixture is generated from the subject:

| Subject | Fixture |
|---|---|
| A material alone | A plateau of it, two layers tall, on nothing, with a ramp cut down its front and one outside corner: its floor, its walls, its fringe hanging off the rim, its picket at the foot, its seams, its edge set at the volume's edge. |
| Floor meets floor | Flat ground of the earlier with an island of the later — the MEETING shape as voxels. Preview already says this better; 3D is offered, not the default. |
| Floor meets wall | A plateau whose walls are the wall material and whose top is the floor: the fold tile, the fringe over the other material, the picket where the base is the floor. |
| Wall meets wall | A cliff banded across the two, the later above. |
| Anything with a ramp | The ramp material descending from a plateau of the other to ground of the other: the slope's surface, its head and its foot. |

The strip is there too, the same crop-of-the-sheet as in Preview, so the
tiles can be seen and picked from 3D as well: a mark on the fixture lights
its tile, a tile lights every corner it draws (the owner's direction of
2026-09-19, on the canvas). The default view follows the subject: Preview
for a floor alone or two floors, 3D for anything with a wall or a ramp in
it. Cost: a second WebGL
context inside the modal, built lazily the first time 3D is opened, its
look rebuilt when the sets or materials change — the same events the map
viewport already reacts to. The map's `Picker` makes hover-to-arrangement
possible later, so the strip and the fixture can point at each other the
way the strip and the patch do; not in the first cut.

## 3. What goes, what moves, what stays

| Today | After |
|---|---|
| Terrain sets rail item | Gone; its keywords move to Materials. |
| Tagger side palette (materials × slots, Nothing) | The materials list with slot chips under the selection; Erase tool. |
| Drawn over / Drawn in / Add a third | The block sentence in the Tagging block, defaulted from the subject. |
| Corners / Block | Tag corners / Erase / Place a block, in the Tagging block. |
| Sheet picker in the tools row | In the Tagging block; the tools row holds undo, redo, zoom. |
| Per-sheet corner counts | Project-wide coverage per material. |
| Materials' archetype groups | One flat list by priority, with face icons per material. |
| Materials' Meets list in the form | The pairings as an expandable list under the material in the side list, with New transition… below; a Meeting block in the form for the lit one. |
| Materials' form, priority, delete | Unchanged. |
| Images' New from template… | Stays in Images; also reachable from Meets as Draw a template…. |
| Inspector picker | Unchanged. |

## 4. Open questions for the owner

1. **The archetype field.** The code still gives a material one archetype and
   groups the list by it. The ruling of 2026-09-18 says a material spans
   archetypes and the archetype is named per corner. This design is drawn to
   the ruling — the Preview's Floor / Wall / Ramp switch and the 3D fixtures
   assume a material can have wall art and floor art both. Should the
   section wait for the model, or ship with the select as the interim and
   the switch appearing when the model lands?
2. **Three views or two.** 3D as a third view with a subject-dependent
   default, or 3D replacing Preview whenever a wall or ramp is involved? The
   draft keeps three: the flat strip is still where a hole is named.
3. **Tagging controls in the form column** rather than in the tools row or
   the side. It keeps the sheet, the tool and the block sentence beside the
   Meets list that fills them; it also means the right column reads
   differently in Tag view than in Preview.
4. **Nothing as a tool, not a list row.** Right-click stays; an Erase button
   joins it; the list is materials only.
5. **Coverage per material in the list** — a number, or a tiny fifteen-cell
   bar. The number is drawn in the mockup.

Decisions taken on these go in `decision-log.md`; this document is then
corrected to match.
