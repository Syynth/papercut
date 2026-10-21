# Texture series: notes, tabled

The 2026-10-21 start on an original texture style for papercut: one style for both
the default kit new projects start with and a showcase sample. Tabled the same day
in favour of a face inspector — a tool that says, for any face, what the texturing
system wants there and what would fill it — so that what a kit is missing can be seen
rather than inferred. Picked up again once that exists.

## Scenes the series should build

Three, chosen on 2026-10-21; a papercraft-diorama direction was offered and not taken.

- **Riverside village** — grass, dirt path, cobbles, a river's edge, low terraced
  cliffs, wooden ramps and fences, cottages.
- **Cliffside harbour** — tall stone quay walls, sand, water, stairs with railings,
  docks, rooftops.
- **Overgrown shrine** — mossy stone, roots, broken walls, worn steps, lanterns in a
  forest clearing.

## What the default set lacks today

The placeholder sheet (`packages/fixtures/src/terrainset.ts`) is floor art only: the
fifteen corner tiles for ten pairs of the five default materials, plus a rail sheet.
No material has wall art, fringe or picket tiles, or seam tiles. What that does,
from a raised ring painted Dirt on top and Grass on its faces:

- Cliffs painted Grass draw Grass's floor tiles, so a grass bank reads as lawn
  stood on end. A kit's Grass wants wall art of its own: earth, a grassy lip.
- The rim and the wall foot are bare: there is no fringe or picket art.
- An outside corner shows a light speck: probably the `convex` seam is empty, so the
  faces mitre and the floor tile's rim shows at the join.
- Magenta on a one-tile rim: likely a corner that is two materials *and* the drop
  (`A + B + nothing`), an arrangement no pair block draws.

## Shapes the system cannot express yet

Supported already, missing only art: wall bands and seams, wall transitions, fringes,
pickets, ramp rails, layers and overlays, pasted tiles, sprites.

| Missing | Blocks | Scenes |
|---|---|---|
| Water edges: a waterline band on walls; foam or a wet edge on shores | every river, quay and pond | all |
| Edge features on floors: fences, low walls, hedges, railings along a cell edge (rails are ramp trim only; the Fences tool is a name on the rail) | yards, quay railings | village, harbour |
| Ramp corners: hip (outer) and valley (inner) where two slopes meet | roofs, mounds, terraces | village, harbour |
| Roof trim: ridge caps, eaves overhang | every house | village, harbour |
| Thin pieces: decks thinner than a slab; posts and beams thinner than a voxel | bridges, docks, balconies, gates | all |
| Undersides: no archetype for a face looking down | arches, under bridges, overhangs | harbour, shrine |
| Real stairs (steps are ramp art today, ruled tentative) | quay steps, shrine steps | harbour, shrine |
| Gentler slopes than 45° | hills, beaches | village, harbour |
| Broken wall tops: crenellations, ruins (a fringe hangs down; nothing stands up) | ruins, battlements | shrine, harbour |
| Vertical water | waterfalls | shrine, village |
| Variants: random alternates for one slot | big walls and fields | all |
| Animated terrain tiles (animation is planned for sprites) | water, falls, torches | all |
| Diagonal and curved walls (sketches partly cover curves) | off-grid cliffs | low priority |

## Where it goes next

The four gaps that cover most of all three scenes are water edges, edge features, ramp
corners with roof trim, and thin pieces. Then three or four style directions, each drawn
as the same small test scene (floor transitions, a cliff with fringe and foot, a ramp, a
water's edge) so the styles compare like for like.
