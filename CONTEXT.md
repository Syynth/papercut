# Context

The vocabulary of `papercut`. A glossary, not a spec: no implementation
details, no decisions. Decisions live in
[`docs/decision-log.md`](docs/decision-log.md) and on the wayfinder maps it
links to.

## Command

A named, enumerable, remappable **intent**: `terrain.raise`, `tool.select`,
`undo`. A command is what a keybinding fires, what a menu item exposes, and
what a test invokes — all three dispatch the same thing.

A command's **declaration** is enumerable independently of whether anything is
currently able to handle it, because a keybinding UI and a command palette need
the full list before any interaction is underway. Its **invocation** is a
message delivered to the actor that handles it, so commands are distributed
across the codebase alongside those actors rather than gathered in one place.

Not to be confused with [Edit](#edit), which is what this word used to mean in
`core`.

## Edit

One entry on the undo stack: a completed change to the document together with
its exact inverse. An edit is the **output** of an interaction, where a
[Command](#command) is the input to one.

A whole brush stroke is a single edit, however many ticks it spanned.

## Feature module

A self-contained unit of editor functionality — a tool, a panel, a viewport
overlay — that attaches through a declared API rather than by reaching into
other parts of the editor. Contributes commands, panels and actors.

Feature modules live in-tree today. The term exists to name the seam, which is
what makes a future plugin possible: a plugin is a feature module that happens
to live outside the repository.

## Owner

Whoever declared a thing: the identity a [Feature module](#feature-module) or
a built-in package presents when it registers a [Command](#command), a panel,
a tool or a keybinding, and the unit those registrations are torn down by —
all of an owner's at once, none of anyone else's. A feature module is one kind
of owner; a built-in package is the other, and a built-in is never torn down.

The word is owner rather than feature so that a package which is not a feature
— the document, say — can declare its own commands.

## Host

The root of the editor's running behaviour: the one place every
[Command](#command) is dispatched to, and the owner of the lifetimes of the
actors that handle them. A command goes *down* from the host to the actor of
the [Owner](#owner) that declared it, never sideways between actors, so a
keypress that does nothing has exactly one place to be looked for.

The host also holds the editor's **mode**: editing, or playing the level.

## Play session

One run of the level, from the moment the editor enters play mode to the
moment it leaves. It is an actor the [Host](#host) spawns, not a flag: it owns
the character — where the hero is put down is read off the [Map](#map) once,
when the session starts — and the character's lifetime IS the session's, so
leaving play mode stops the actor and the character goes with it.

A session is a value that leaves the host, too: the renderer is handed the
running session or nothing at all, rather than a boolean plus a position it
would have to recompute. The two packages that type against it declare the
shape separately, because the renderer is below the host and may not import
it; the glossary is what says they are the same thing.

## Context key

A named fact about the editor's current state — which mode it is in, whether
anything is selected, whether there is something to undo — that a
[Command](#command)'s availability may be conditioned on. The vocabulary is
declared, so a condition can only ever mention a key that exists, and a
disabled control can say which key is the reason.

## Chord

One keypress, named: a key plus the modifiers held with it — `mod+z`,
`shift+alt+x`. `mod` names whichever modifier is the platform's primary
accelerator rather than naming a particular key. A [Binding](#binding) may
take a SEQUENCE of chords, where the first is held until the next arrives.

## Binding

A [Chord](#chord) bound to a [Command](#command) and its arguments — never to
a function, so the same pair is a keymap entry, a menu item's payload and a
test's invocation.

Bindings are an ordered list rather than a lookup: several may name the same
chord, and the one that wins is the last whose condition holds. A binding
whose condition is false yields to the one beneath it rather than consuming
the keypress, which is what lets a layer add bindings without hiding the layer
underneath. A binding may also **shadow** a chord — consume it and do nothing
— or **unbind** one, which removes a rule so whatever sat under it becomes
reachable again.

## Project

A folder anchored on `papercut.json`, holding what every map in it shares: the
material library, the resolution profile (texel density and filtering), the
images the materials draw from with their grids and terrain sets, the camera rig
new maps start from, and the maps themselves in order. The app opens projects,
and a map only within its project (rulings of 2026-09-14). Held live by the
host's project actor; edited by `project.*` commands, which are settings, not
undoable edits. A project has a uuid (ruling of 2026-09-19), fixed for its
life, which every map written into its folder is stamped with; it may have no
maps at all, and its folder may hold files that are not its own.

## Map

The level being edited: terrain, paint, objects, and the settings that describe
how they are lit and viewed — its own, never what the [Project](#project)
holds. A voxel names its material by an id in the project's library. "Map" is
the artist's word and the document's word; it is unrelated to a wayfinder map,
which is a planning artifact on the issue tracker. A map file carries the id
of the project it belongs to (ruling of 2026-09-19). A **stray map** is a
`.map.json` in a project's `maps/` that the project does not list: judged by
its stamp as this project's (it can be added back), another project's or
unstamped (Import Map, to come, is the way in), or unreadable.

## Half-tile

The unit of terrain height. A voxel is a full cube, one tile on every
side, and a slab is half a cube, so every height the editor speaks of is a
whole number of half-tiles: a column's top, a cliff band's level, the layer
view's range. Nothing stores a height; they are derived from the voxels.

One tile is one world unit, always.

## Cliff face

The vertical surface exposed where a voxel's side has no neighbour at its
level. A cliff face is addressed by the cell it belongs to, the side it
faces, and the layer it occupies — never by a triangle or a mesh face.

This is what lets paint survive sculpting: a face override is keyed by
that address, so removing the voxel and putting it back finds the override
waiting, because it was never attached to the geometry.

## Stroke

One continuous interaction with a tool, from press to release. A stroke may
span many frames and touch a cell many times, but it produces exactly one
[Edit](#edit).

## Image

A file of pixels the project draws from, listed in `papercut.json` with
everything the project knows about it: its **id**, a number assigned when it
is listed and never changed, which sprites and pasted tiles name it by; the
**name** the app shows (free to change); its **kind** (tileset, sprite sheet, texture), the **hash** of its file as
last seen, its **grid**, and its [Terrain set](#terrain-set). Managed in the
Images section of Project settings — the image library (decision of
2026-09-17) — where it is imported, viewed, annotated and recovered.

A **grid** says how the image is cut into tiles: square tiles of `tile` px,
after a margin, spaced apart, with whatever lies past the last whole tile
ignored. A tile size must divide the project's
[texel density](#resolution-profile), and the image is scaled up by that
whole number with nearest neighbour, so a 16 px kit draws at 3× in a 48 px
project without a resampled texel.

An image whose file has moved is found again by its hash when the project
opens; one that was edited AND moved is missing, and relinked by hand.

## Terrain set

An [Image](#image) plus the tags its project entry carries: every tile of
the image, tagged with the terrain at each of its four corners, or nothing.
That is the whole model of what a tile is: a tile is authored as the
transition it shows, half grass and half path, and tagged so. The
**template** fills a 4×4 block's tags from position for a pair of terrains,
which is how art drawn to the template is wired in one placement; art that
was not is tagged one corner at a time, in the Terrain sets section of
Project settings, which works the way Tiled's terrain editor does (decision
of 2026-09-14): pick a terrain, click or drag over tile corners on the
image, and every tagged corner shows as a translucent quadrant in its
terrain's colour. The section takes the window while it is open, and tagging
there is undoable in the editor's own history (decision of 2026-09-17),
unlike the other Project settings.

Terrain sets live in the project file, never in sidecars beside the images
(decision of 2026-09-17).

## Corner

Where four faces of the same grid meet — four cells of the ground, or four
bands of a cliff. The tile drawn there is looked up from the four terrains
around it and drawn whole, centred on the corner: the dual grid. Any number
of terrains may meet at a corner. Where the terrain set has no tile for the
combination, the corner is **composited** from edge sets in material order
and shown as missing, so the transition can be drawn on demand.

## Shape

What a voxel is besides its material: a block, a slab, a 45° ramp that
descends toward one side, or a half ramp that finishes an odd half-tile.

## Sprite

A named asset in the sprite library: the visual definition of a tree, an
NPC, a sign, or a prop. This is the brief's "Image object" — a visual
placed with a full transform, outside the voxel grid. A sprite declares its
[facings](#facing), the footprint used to size its quad, and whether it
emits light.

Placing a sprite creates an object on the [Map](#map): the object stores
which sprite it references, plus its own position, scale, and facing state.
Many objects can reference the same sprite, and painted background scenery
does too.

A project can cut its own sprites from its [images](#image): a name, an
image and a rectangle of its tiles. One named like a generated placeholder
sprite (`tree`, `barrel`) stands in for it. A sprite stands free and turns to
the camera; art fixed to a surface — a door, a window — is not a sprite but a
[pasted tile](#pasted-tile).

## Pasted tile

A single tile of an [image](#image) laid whole on one face, in one of the
face's material layers: its slot is `t:<image id>:<tile index>`. It covers
its face exactly — upright on a wall, north up on a top — and is nothing to
a material auto-tiling on the same layer. The Tiles paint verb stamps a
rectangle of them, its top-left on the face pressed.

## Facing

One directional image of a [Sprite](#sprite), shown when the object is
viewed from a particular yaw. A sprite may have 1, 2, 4, or 8 facings
depending on how much directional art the artist supplied; the first always
faces the camera at the default yaw.

A second sense, the facing configuration, is the object's behaviour around
its facings: mirroring the right-hand images for the left side, how it
flips or transitions between facings, and how much overlap it tolerates
before switching back, to stop flicker.

## RgbaImage

Raw pixel data crossing the texture boundary: width, height, and a buffer
of row-major RGBA bytes, four per pixel.

Everything that draws — the placeholder generator, the artist's sheet or
sprite loader — produces this, and everything that uploads or encodes — the
runtime's textures, glTF export — accepts it, so pixels can move between
them without either side depending on a canvas.

## Structure

One thing in a level that has a shape: a voxel volume, a sketch extrusion, a
body of water. A level is a **scene graph** of structures — each one sits
inside another (or at the root) and is placed relative to it — so a voxel
volume can stand on an island and an island can stand in a voxel volume. What a
structure can hold, how it is meshed, how it answers "what is under this
point" and which tools address it are all questions its
[Structure kind](#structure-kind) answers.

## Structure kind

What sort of [Structure](#structure) something is, and the vocabulary of
handlers that sort brings with it: its data, its edits, its mesher, its
surfaces, its tools, the kind of material it is dressed in. The first kinds
are the [Voxel volume](#voxel-volume) and the [Sketch](#sketch).

## Voxel volume

A [Structure](#structure) made of cubes on a grid — the ground the Terrain
tool sculpts and paints. Each voxel is air or a material with a
[Shape](#shape); every height is derived from the column. Resizable at its
edges.

## Sketch

A [Structure](#structure) drawn rather than sculpted: a closed
[Profile](#profile) on a [Sketch plane](#sketch-plane), extruded to a height.
The CAD way of making an island, a plateau, a platform — any shape whose
outline is the thing the artist means.

## Sketch plane

The flat surface a [Profile](#profile) is drawn on: horizontal, at a height,
placed relative to the structure the [Sketch](#sketch) sits in.

## Profile

The closed outline on a [Sketch plane](#sketch-plane) that a
[Sketch](#sketch) extrudes. Points and segments; re-editable after the fact,
with the extrusion following.

## Material kind

Which language a material speaks. A **terrain material** names a terrain in
a [Terrain set](#terrain-set) for its top faces and, optionally, another for
its sides, so grass-topped dirt is one material — the
[Voxel volume](#voxel-volume)'s kind. A **fill-and-edge material** is a fill
texture tiled across a face and edge textures run along its outline with
their own width, repeat and cap rules — the [Sketch](#sketch)'s kind, in the
manner of Ferr2D.
