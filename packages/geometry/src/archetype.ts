/**
 * Archetypes: which face a material's art is for, and what parts it has
 * (rulings of 2026-09-17).
 *
 * An earlier cut of this listed TILE SHAPES — a floor owed fifteen corner
 * masks, a wall owed a top band and two ends. That was wrong twice over. The
 * fifteen masks are not a floor's slots, they are the ways ANY material meets
 * something at the corners of a tile; and a wall's bands and ends turned out
 * to be those same fifteen read in elevation, because the mesher already runs
 * a wall face through the dual grid with the wall's own silhouette as the
 * shape. Both were a second spelling of the corner model.
 *
 * So an archetype says two things. Which face its art is drawn on, and what
 * PARTS its surface has beyond the ordinary one. A part is a SLOT, it is
 * optional on a tag, and almost every tag leaves it off: absent means the
 * ordinary surface, which is what an artist tags all day.
 *
 * The slot exists for what the corner model cannot reach. A wall's seam is
 * the case today: a convex or concave turn is two wall faces meeting at an
 * angle in three dimensions, and no arrangement of four corners inside one
 * face's own plane can say it, because the other face is not in that plane.
 * Alternates and alternate shapes — a curved corner or a wedge in place of
 * the standard blob corner — join this list when they are built.
 *
 * Nothing here knows about a project, an image or a tile. It says what a
 * material's surface is made of; where the pixels are is somebody else's
 * business.
 */

import type { ArchetypeId } from '@papercut/document'

export interface Slot {
  /** Unique within its archetype, and what a tag spells after the colon: `convex`. */
  id: string
  /** What the editor calls it. */
  name: string
  /** True for the part a tag means when it names no slot at all. Exactly one per archetype. */
  ordinary?: boolean
  /** Left undrawn, the mesher copes — a wall's seams are mitred. */
  optional?: boolean
  /** A word for what it is, so the editor can explain it. */
  note?: string
}

export interface Archetype {
  id: ArchetypeId
  title: string
  /** Which faces its art is drawn on, in one line, for the editor to show. */
  note: string
  /** A tile's size as multiples of the project's texel density. */
  aspect: { width: number; height: number }
  slots: Slot[]
}

/** The slot a tag means when it names none: `tagOf(3)` is material 3's ordinary surface. */
export const ORDINARY = 'surface'

/** What a corner mask is, in words: the nine ways four cells can be arranged up to which is which. */
export function maskKind(mask: number): string {
  const bits = [1, 2, 4, 8].filter((b) => mask & b).length
  if (bits === 4) return 'interior'
  if (bits === 3) return 'inside corner'
  if (bits === 1) return 'outside corner'
  return mask === 6 || mask === 9 ? 'diagonal' : 'edge'
}

/**
 * One of the fifteen ways a material meets something at a tile's corners.
 *
 * Not a slot. A slot is a part of one material's surface; an arrangement is
 * how a surface meets what is beside it. Every archetype has the same fifteen,
 * because every face is meshed through the same dual grid — a floor's in the
 * map's plane, a wall's in elevation, a ramp's along its slope.
 */
export interface Arrangement {
  mask: number
  name: string
  kind: string
}

const ARRANGEMENTS: readonly Arrangement[] = Array.from({ length: 15 }, (_, i) => ({ mask: i + 1, name: `mask ${i + 1}`, kind: maskKind(i + 1) }))

export function arrangements(): readonly Arrangement[] {
  return ARRANGEMENTS
}

/** √2, because a ramp's surface spans the diagonal of the cell it descends through. */
export const RAMP_RISE = Math.SQRT2

const ARCHETYPES: readonly Archetype[] = [
  {
    id: 'floor',
    title: 'Floor',
    note: 'Top faces, in the map’s own plane.',
    aspect: { width: 1, height: 1 },
    slots: [{ id: ORDINARY, name: 'Surface', ordinary: true, note: 'the ground itself' }],
  },
  {
    id: 'wall',
    title: 'Wall',
    note: 'Side faces, in elevation. Its bands and ends are the same corner arrangements, read upright.',
    aspect: { width: 1, height: 1 },
    slots: [
      { id: ORDINARY, name: 'Surface', ordinary: true, note: 'the wall itself' },
      { id: 'convex', name: 'Convex seam', optional: true, note: 'an outside turn; mitred when undrawn' },
      { id: 'concave', name: 'Concave seam', optional: true, note: 'an inside turn; mitred when undrawn' },
    ],
  },
  {
    id: 'ramp',
    title: 'Ramp',
    note: 'Sloped top faces. Taller tiles, because the slope is longer than its run.',
    aspect: { width: 1, height: RAMP_RISE },
    slots: [{ id: ORDINARY, name: 'Surface', ordinary: true, note: 'the slope itself' }],
  },
]

export function archetypes(): readonly Archetype[] {
  return ARCHETYPES
}

export function archetypeOf(id: ArchetypeId): Archetype {
  const found = ARCHETYPES.find((a) => a.id === id)
  if (!found) throw new Error(`No archetype called ${id}.`)
  return found
}

/** A slot's tile size at a density, rounded to whole pixels — a ramp's is not square. */
export function slotSize(archetype: Archetype, density: number): { width: number; height: number } {
  return { width: Math.round(density * archetype.aspect.width), height: Math.round(density * archetype.aspect.height) }
}

/** The slots that must be drawn before no corner falls back: the optional ones do not count. */
export function requiredSlots(archetype: Archetype): Slot[] {
  return archetype.slots.filter((s) => !s.optional)
}
