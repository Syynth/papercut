/**
 * A transition the face inspector asked the Materials section to place (2026-10-21). The inspector leaves the
 * request here and opens Project settings on Materials; the section takes it once when it opens, spells the
 * transition, and goes straight to placing its block on a sheet.
 */

import type { ArchetypeId } from '@papercut/document'

export interface PlaceRequest {
  /** What the block is drawn over: a material id, or `null` for nothing (an edge set). */
  readonly under: number | null
  /** What is drawn over it, and a third material when three meet. */
  readonly over: number
  readonly third: number | null
  /** The kind of face the art is for; `null` for any, which is what floor art is. */
  readonly context: ArchetypeId | null
  /** The slot the art fills, when the corner names one (a wall's seam). */
  readonly slot: string | null
}

let pending: PlaceRequest | null = null

export function requestPlacing(request: PlaceRequest): void {
  pending = request
}

/** The request waiting, if any; taking it clears it. */
export function takePlacing(): PlaceRequest | null {
  const request = pending
  pending = null
  return request
}
