/**
 * Archetypes: the vocabulary of slots a material owes art for (design of
 * 2026-09-17).
 *
 * An archetype owns its vocabulary. The FLOOR archetype's slots happen to be
 * the fifteen corner masks — the dual grid papercut draws top faces with —
 * and that is why corner tagging feels universal, but it is not: the WALL
 * archetype's slots are named parts in elevation, including the two seams
 * where a wall turns, and the RAMP's are its own at a taller aspect because
 * a slope is longer than the run beneath it.
 *
 * A material fills its archetype's slots with its own art. A transition
 * fills the SAME slots with the art of two to four materials meeting. Same
 * shape of thing, different subject, which is why transitions live in every
 * archetype rather than only where there are corners.
 *
 * Nothing here knows about a project, a sheet or a tile. It says what is
 * owed; who owes it and where the pixels are is somebody else's business.
 */

import type { ArchetypeId } from '@papercut/document'

export interface Slot {
  /** Unique within its archetype: `mask:15`, `face`, `convex`. */
  id: string
  /** What the editor calls it. */
  name: string
  /** The corner mask it answers, for an archetype whose slots are corners; absent otherwise. */
  mask?: number
  /** Left empty, the mesher copes — a wall's seams are mitred. An unfilled required slot composites instead. */
  optional?: boolean
  /** A word for what it is, so the editor can group or explain. */
  note?: string
}

export interface Archetype {
  id: ArchetypeId
  title: string
  /** What its faces are, in one line, for the editor to show. */
  note: string
  /** A tile's size as multiples of the project's texel density. */
  aspect: { width: number; height: number }
  slots: Slot[]
}

/** What a corner mask is, in words: the nine ways four cells can be arranged up to which is which. */
export function maskKind(mask: number): string {
  const bits = [1, 2, 4, 8].filter((b) => mask & b).length
  if (bits === 4) return 'interior'
  if (bits === 3) return 'inside corner'
  if (bits === 1) return 'outside corner'
  return mask === 6 || mask === 9 ? 'diagonal' : 'edge'
}

const CORNER_SLOTS: Slot[] = Array.from({ length: 15 }, (_, i) => {
  const mask = i + 1
  return { id: `mask:${mask}`, name: `mask ${mask}`, mask, note: maskKind(mask) }
})

/** √2, because a ramp's surface spans the diagonal of the cell it descends through. */
export const RAMP_RISE = Math.SQRT2

const ARCHETYPES: readonly Archetype[] = [
  {
    id: 'floor',
    title: 'Floor',
    note: 'Top faces. Corner slots, in the map’s own plane.',
    aspect: { width: 1, height: 1 },
    slots: CORNER_SLOTS,
  },
  {
    id: 'wall',
    title: 'Wall',
    note: 'Side faces, in elevation. Named parts, and two seams where a wall turns.',
    aspect: { width: 1, height: 1 },
    slots: [
      { id: 'face', name: 'Face', note: 'a run of wall' },
      { id: 'top', name: 'Top band', note: 'where it meets the surface above' },
      { id: 'bottom', name: 'Bottom band', note: 'where it meets the ground' },
      { id: 'end-left', name: 'End, left', note: 'the wall stops' },
      { id: 'end-right', name: 'End, right', note: 'the wall stops' },
      { id: 'convex', name: 'Convex seam', optional: true, note: 'an outside turn; mitred when empty' },
      { id: 'concave', name: 'Concave seam', optional: true, note: 'an inside turn; mitred when empty' },
    ],
  },
  {
    id: 'ramp',
    title: 'Ramp',
    note: 'Sloped top faces. Taller tiles, because the slope is longer than its run.',
    aspect: { width: 1, height: RAMP_RISE },
    slots: [
      { id: 'run', name: 'Run', note: 'the slope itself' },
      { id: 'head', name: 'Head', note: 'where it meets the level above' },
      { id: 'foot', name: 'Foot', note: 'where it meets the level below' },
      { id: 'side', name: 'Side', note: 'the slope’s own edge' },
    ],
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

/** How many of an archetype's slots must be filled before nothing composites: the optional ones do not count. */
export function requiredSlots(archetype: Archetype): Slot[] {
  return archetype.slots.filter((s) => !s.optional)
}
