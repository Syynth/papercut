/**
 * Surface addressing: what a pick names.
 *
 * A picked triangle resolves to a surface on a structure — a voxel cell's
 * top, one band of one cliff face, a water quad — so every tool means the
 * same thing by "what is under the cursor". The per-triangle encoding
 * (`faceAddr`, four ints) is the mesher's; the structure the mesh belongs to
 * is known to whoever built the mesh, so it rides alongside rather than
 * inside the ints.
 */

export const SURFACE_TOP = 0
export const SURFACE_CLIFF = 1
export const SURFACE_WATER = 2
/** A sketch's cap; `x` is the outline segment the triangle belongs to (−1 for the interior). */
export const SURFACE_SKETCH_CAP = 3
/** A sketch's wall or a band on it; `x` is the outline segment. */
export const SURFACE_SKETCH_WALL = 4

/** The underside of a voxel with air beneath it: an overhang's ceiling. `level` is the voxel's layer, doubled. */
export const SURFACE_UNDER = 5

export type SurfaceKind = typeof SURFACE_UNDER | typeof SURFACE_TOP | typeof SURFACE_CLIFF | typeof SURFACE_WATER | typeof SURFACE_SKETCH_CAP | typeof SURFACE_SKETCH_WALL

export interface SurfaceAddress {
  /** The structure the surface belongs to. */
  structure: string
  kind: SurfaceKind
  x: number
  y: number
  /** Cliff faces: which side (0 E, 1 S, 2 W, 3 N). */
  dir: number
  /**
   * Cliff faces: which half-tile band. Tops and undersides: the layer of the voxel whose face it is, doubled, so that
   * half of any surface's level, rounded down, is its layer. A column can have a top at more than one layer.
   */
  level: number
}

const LEVEL_BIAS = 32768

export function encodeExtra(dir: number, level: number): number {
  return (dir << 17) | (level + LEVEL_BIAS)
}

export function decodeExtra(extra: number): { dir: number; level: number } {
  return { dir: extra >> 17, level: (extra & 0x1ffff) - LEVEL_BIAS }
}

export function readAddress(faceAddr: Int32Array, tri: number, structure: string): SurfaceAddress {
  const base = tri * 4
  const { dir, level } = decodeExtra(faceAddr[base + 3])
  return {
    structure,
    kind: faceAddr[base] as SurfaceKind,
    x: faceAddr[base + 1],
    y: faceAddr[base + 2],
    dir,
    level,
  }
}

export function sameSurface(a: SurfaceAddress | null, b: SurfaceAddress | null): boolean {
  if (!a || !b) return a === b
  return a.structure === b.structure && a.kind === b.kind && a.x === b.x && a.y === b.y && a.dir === b.dir && a.level === b.level
}

export function describeSurface(address: SurfaceAddress | null): string {
  if (!address) return '—'
  if (address.kind === SURFACE_TOP) return `top (${address.x}, ${address.y})`
  if (address.kind === SURFACE_UNDER) return `underside (${address.x}, ${address.y}) layer ${Math.floor(address.level / 2)}`
  if (address.kind === SURFACE_WATER) return `water (${address.x}, ${address.y})`
  if (address.kind === SURFACE_SKETCH_CAP) return `sketch cap ${address.structure}`
  if (address.kind === SURFACE_SKETCH_WALL) return `sketch wall ${address.structure} segment ${address.x}`
  const sides = ['E', 'S', 'W', 'N']
  return `cliff (${address.x}, ${address.y}) ${sides[address.dir]} level ${address.level}`
}
