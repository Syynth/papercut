/**
 * Edits and undo.
 *
 * An `Edit` is one entry on the undo stack: a completed change to the document
 * together with its exact inverse. It is the *output* of an interaction, where
 * a command — the named, remappable thing a keybinding or a test invokes — is
 * the input to one. Commands live elsewhere; nothing in this file knows about
 * them.
 *
 * Every edit is a list of patches applied to the document. The applier reads
 * the previous value of each address it touches and builds the inverse as it
 * goes, so a tool gets undo and redo by describing what it wants to change and
 * nothing else. No tool writes an `undo()` method.
 *
 * Patches are intentionally addressed at the same granularity as the document:
 * one field of one voxel (or one column's water), one paint key, one field of one sketch,
 * one object, one structure. That keeps the inverse exact and makes a brush
 * stroke a flat list of small writes which coalesce cleanly. A sketch's
 * `points` is one address on purpose: a point drag is a stroke over that one
 * slot, and the per-address compaction (#11) collapses it to first/last.
 */

import type { EdgeSwitch, MapDoc, MapObject, MaterialLayers, ReadonlyMapDoc } from './document'
import type { SketchStructure, Structure, StructureBase, VoxelStructure } from './structure'

export type TerrainField = 'shape' | 'water'
export type PaintLayer = 'faces' | 'tint' | 'edges'
export type DocField = 'name' | 'camera' | 'atmosphere' | 'surfaceMaterials'
export type SketchField = 'points' | 'closed' | 'layers' | 'wall' | 'lip' | 'capMaterial' | 'wallMaterial'
export type StructureMetaField = 'name' | 'parent' | 'placement'

/** One field of one sketch, typed by the field: `{ field: 'layers', value: number }`, never `value: unknown`. */
export type SketchPatch = { [K in SketchField]: { t: 'sketch'; id: string; field: K; value: SketchStructure[K] } }[SketchField]
/** One face's material layers, or one cell's tint; `undefined` removes the entry. */
export type PaintPatch =
  | { t: 'voxelPaint'; id: string; layer: 'faces'; key: string; value: MaterialLayers | undefined }
  | { t: 'voxelPaint'; id: string; layer: 'tint'; key: string; value: number | undefined }
  | { t: 'voxelPaint'; id: string; layer: 'edges'; key: string; value: EdgeSwitch | undefined }
export type StructureMetaPatch = { [K in StructureMetaField]: { t: 'structure.meta'; id: string; field: K; value: StructureBase[K] } }[StructureMetaField]

export type Patch =
  | { t: 'voxel'; id: string; field: TerrainField; index: number; value: number }
  | PaintPatch
  | SketchPatch
  | { t: 'structure'; id: string; value: Structure | undefined }
  | StructureMetaPatch
  | { t: 'structureOrder'; value: string[] }
  | { t: 'object'; id: string; value: MapObject | undefined }
  | { t: 'objectOrder'; value: string[] }
  | { t: 'doc'; field: DocField; value: unknown }

export interface Edit {
  label: string
  patches: Patch[]
  inverse: Patch[]
}

/** An `Edit` without its label: what a stroke hands back on release, labelled by the store from `beginStroke`. */
export type StrokeRecord = Pick<Edit, 'patches' | 'inverse'>

/**
 * The slot a patch writes, as a key. Two patches with equal keys overwrite
 * each other, which is what makes per-address compaction lossless: within
 * one stroke only the last forward value and the first before-value can ever
 * be observed (#11). The stroke actor in `editor-host` keys its map on this.
 */
export function patchAddress(patch: Patch): string {
  switch (patch.t) {
    case 'voxel':
      return `voxel:${patch.id}:${patch.field}:${patch.index}`
    case 'voxelPaint':
      return `paint:${patch.id}:${patch.layer}:${patch.key}`
    case 'sketch':
      return `sketch:${patch.id}:${patch.field}`
    case 'structure':
      return `structure:${patch.id}`
    case 'structure.meta':
      return `structure:${patch.id}:${patch.field}`
    case 'structureOrder':
      return 'structureOrder'
    case 'object':
      return `object:${patch.id}`
    case 'objectOrder':
      return 'objectOrder'
    case 'doc':
      return `doc:${patch.field}`
  }
}

function voxelOf(doc: ReadonlyMapDoc | MapDoc, id: string): VoxelStructure {
  const s = doc.structures[id]
  if (!s || s.kind !== 'voxel') throw new Error(`Patch addresses voxel structure ${id}, which the level does not have.`)
  return s as VoxelStructure
}

/** The flat array a voxel field is: per voxel for shape, per column for water. */
function voxelField(voxel: VoxelStructure, field: TerrainField): number[] {
  return field === 'water' ? voxel.water : voxel.voxels[field]
}

function sketchOf(doc: ReadonlyMapDoc | MapDoc, id: string): SketchStructure {
  const s = doc.structures[id]
  if (!s || s.kind !== 'sketch') throw new Error(`Patch addresses sketch ${id}, which the level does not have.`)
  return s as SketchStructure
}

/** A value the undo stack keeps must not alias the live document: the next forward patch would edit the inverse too. */
function keep<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

/**
 * The patch that would undo `patch` were it applied to `doc` now: the
 * before-value at its address. Reads only, so it takes the readonly view and
 * a holder of `reader` can compute an inverse BEFORE sending the forward
 * patch — the stroke actor needs exactly that to record `first` without ever
 * seeing the writer.
 *
 * The casts re-wrap values the readonly view narrowed: the inverse puts the
 * same shape back wholesale, and `DeepReadonly` is a promise about who
 * writes, not a different runtime shape. Structure-sized values are cloned
 * (`keep`) because the live object keeps changing under later patches.
 */
export function inversePatch(doc: ReadonlyMapDoc, patch: Patch): Patch {
  switch (patch.t) {
    case 'voxel':
      return { t: 'voxel', id: patch.id, field: patch.field, index: patch.index, value: voxelField(voxelOf(doc, patch.id), patch.field)[patch.index] }
    case 'voxelPaint':
      return { ...patch, value: keep(voxelOf(doc, patch.id).paint[patch.layer][patch.key]) } as PaintPatch
    case 'sketch':
      return { t: 'sketch', id: patch.id, field: patch.field, value: keep(sketchOf(doc, patch.id)[patch.field]) } as SketchPatch
    case 'structure':
      return { t: 'structure', id: patch.id, value: keep(doc.structures[patch.id] as Structure | undefined) }
    case 'structure.meta':
      return { t: 'structure.meta', id: patch.id, field: patch.field, value: keep((doc.structures[patch.id] as Structure)[patch.field]) } as StructureMetaPatch
    case 'structureOrder':
      return { t: 'structureOrder', value: doc.structureOrder as string[] }
    case 'object':
      return { t: 'object', id: patch.id, value: doc.objects[patch.id] as MapObject | undefined }
    case 'objectOrder':
      return { t: 'objectOrder', value: doc.objectOrder as string[] }
    case 'doc':
      return { t: 'doc', field: patch.field, value: (doc as unknown as Record<string, unknown>)[patch.field] }
  }
}

/** Apply one patch, returning the patch that undoes it. */
function applyPatch(doc: MapDoc, patch: Patch): Patch {
  const inverse = inversePatch(doc, patch)
  switch (patch.t) {
    case 'voxel':
      voxelField(voxelOf(doc, patch.id), patch.field)[patch.index] = patch.value
      break
    case 'voxelPaint': {
      const paint = voxelOf(doc, patch.id).paint
      if (patch.layer === 'faces') {
        if (patch.value === undefined) delete paint.faces[patch.key]
        else paint.faces[patch.key] = [...patch.value]
      } else if (patch.layer === 'edges') {
        if (patch.value === undefined) delete paint.edges[patch.key]
        else paint.edges[patch.key] = patch.value
      } else if (patch.value === undefined) delete paint.tint[patch.key]
      else paint.tint[patch.key] = patch.value
      break
    }
    case 'sketch':
      ;(sketchOf(doc, patch.id) as unknown as Record<string, unknown>)[patch.field] = patch.value
      break
    case 'structure':
      if (patch.value === undefined) delete doc.structures[patch.id]
      else doc.structures[patch.id] = patch.value
      break
    case 'structure.meta': {
      const s = doc.structures[patch.id]
      if (s) (s as unknown as Record<string, unknown>)[patch.field] = patch.value
      break
    }
    case 'structureOrder':
      doc.structureOrder = patch.value
      break
    case 'object':
      if (patch.value === undefined) delete doc.objects[patch.id]
      else doc.objects[patch.id] = patch.value
      break
    case 'objectOrder':
      doc.objectOrder = patch.value
      break
    case 'doc':
      ;(doc as unknown as Record<string, unknown>)[patch.field] = patch.value
      break
  }
  return inverse
}

/**
 * Apply patches in order and return their inverse, in reverse order so that
 * replaying it undoes the whole list even when two patches touch the same
 * address.
 */
export function applyPatches(doc: MapDoc, patches: Patch[]): Patch[] {
  const inverse: Patch[] = []
  for (const patch of patches) inverse.push(applyPatch(doc, patch))
  inverse.reverse()
  return inverse
}

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * Drop patches that change nothing. A brush dragged back and forth over the
 * same cell would otherwise fill the undo stack with no-ops and mark chunks
 * dirty for no reason.
 */
export function pruneNoops(doc: MapDoc, patches: Patch[]): Patch[] {
  return patches.filter((patch) => {
    switch (patch.t) {
      case 'voxel':
        return voxelField(voxelOf(doc, patch.id), patch.field)[patch.index] !== patch.value
      case 'voxelPaint':
        return !same(voxelOf(doc, patch.id).paint[patch.layer][patch.key], patch.value)
      case 'sketch':
        return !same(sketchOf(doc, patch.id)[patch.field], patch.value)
      case 'structure':
        return patch.value === undefined ? doc.structures[patch.id] !== undefined : !same(doc.structures[patch.id], patch.value)
      case 'structure.meta':
        return !same(doc.structures[patch.id]?.[patch.field], patch.value)
      case 'structureOrder':
        return !same(doc.structureOrder, patch.value)
      case 'object':
        return doc.objects[patch.id] !== patch.value
      default:
        return true
    }
  })
}

export class History {
  private undoStack: Edit[] = []
  private redoStack: Edit[] = []
  private limit: number
  /** A number for every edit, given when it is pushed and never reused: what `position` answers with. */
  private serials = new WeakMap<Edit, number>()
  private nextSerial = 1

  constructor(limit = 200) {
    this.limit = limit
  }

  push(edit: Edit): void {
    this.serials.set(edit, this.nextSerial++)
    this.undoStack.push(edit)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack.length = 0
  }

  /**
   * Where the document stands in its own history: the serial of the last edit still applied, 0 before the first. Undo
   * moves it back to the edit before and redo on again, so something kept beside the history — what was selected —
   * can be keyed by it. A depth would not do: the stack drops its oldest entries at its limit, and every depth shifts.
   */
  position(): number {
    const top = this.undoStack.at(-1)
    return top ? (this.serials.get(top) ?? 0) : 0
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null
  }

  redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null
  }

  undo(doc: MapDoc): Edit | null {
    const edit = this.undoStack.pop()
    if (!edit) return null
    applyPatches(doc, edit.inverse)
    this.redoStack.push(edit)
    return edit
  }

  redo(doc: MapDoc): Edit | null {
    const edit = this.redoStack.pop()
    if (!edit) return null
    applyPatches(doc, edit.patches)
    this.undoStack.push(edit)
    return edit
  }

  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }
}
