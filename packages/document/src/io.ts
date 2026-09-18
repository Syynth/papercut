/**
 * Serialisation.
 *
 * One format version, read strictly: no migrations until a level worth
 * keeping exists (ruling of 2026-09-12). A file from another version is
 * refused with a message that says so, never half-read.
 */

import {
  AIR,
  MAX_LAYERS,
  SHAPE_COUNT,
  FORMAT_VERSION,
  MATERIAL_LAYERS,
  createMap,
  defaultCameraRig,
  defaultFacing,
  makeAtmosphere,
  type MapDoc,
  type MapObject,
  type ReadonlyMapDoc,
} from './document'
import { DEFAULT_WALL_PROFILE } from './ops'
import { defaultSurfaceMaterials, type SketchStructure, type Structure, type VoxelStructure } from './structure'

export class LoadError extends Error {}

/** `x,z,y,dir`: a column, a layer from the bedrock's -1 up, and a side 0–5. */
const FACE_KEY = /^\d+,\d+,-?\d+,[0-5]$/
/** A material layer's slot as the format spells it; `t:<gid>` is reserved and not read yet. */
const SLOT = /^m:\d+$/

export function serialize(doc: ReadonlyMapDoc): string {
  return JSON.stringify(doc, null, 2)
}

function must<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) throw new LoadError(message)
  return value
}

function normaliseObject(raw: Partial<MapObject>, id: string): MapObject {
  return {
    id,
    name: raw.name ?? 'Object',
    sprite: raw.sprite ?? 'tree',
    position: raw.position ?? [0, 0, 0],
    rotationY: raw.rotationY ?? 0,
    scale: raw.scale ?? 1,
    display: raw.display ?? 'auto',
    facing: { ...defaultFacing(), ...(raw.facing ?? {}) },
    anchorCell: raw.anchorCell ?? null,
    seed: raw.seed ?? 0,
    locked: raw.locked ?? false,
    hidden: raw.hidden ?? false,
  }
}

function normaliseStructure(raw: Record<string, unknown>, id: string): Structure {
  const base = {
    id,
    name: typeof raw.name === 'string' ? raw.name : 'Structure',
    parent: typeof raw.parent === 'string' ? raw.parent : null,
    placement: { x: 0, z: 0, yaw: 0 as const, ...((raw.placement as Record<string, number>) ?? {}) },
  }
  if (raw.kind === 'voxel') {
    const size = must(raw.size as VoxelStructure['size'], `Structure ${id} has no size.`)
    const count = size.width * size.height
    const layers = raw.layers
    if (typeof layers !== 'number' || !Number.isInteger(layers) || layers < 1) throw new LoadError(`Structure ${id} has no layers.`)
    if (layers > MAX_LAYERS) throw new LoadError(`Structure ${id} has ${layers} layers; a volume holds at most ${MAX_LAYERS}.`)
    const voxels = must(raw.voxels as VoxelStructure['voxels'], `Structure ${id} has no voxels.`)
    const shape = voxels.shape
    if (!Array.isArray(shape) || shape.length !== count * layers) {
      throw new LoadError(`${id}.voxels.shape should hold ${count * layers} entries, found ${Array.isArray(shape) ? shape.length : 'none'}.`)
    }
    // Every entry is a whole number in range: AIR, or a shape the mesher knows.
    const bad = (shape as unknown[]).findIndex((v) => typeof v !== 'number' || !Number.isInteger(v) || v < AIR || v > SHAPE_COUNT - 1)
    if (bad >= 0) throw new LoadError(`${id}.voxels.shape[${bad}] is ${String((shape as unknown[])[bad])}, which is not a shape.`)
    const water = raw.water
    if (!Array.isArray(water) || water.length !== count) {
      throw new LoadError(`${id}.water should hold ${count} entries, found ${Array.isArray(water) ? water.length : 'none'}.`)
    }
    const paint = (raw.paint ?? {}) as Partial<VoxelStructure['paint']>
    const faces = paint.faces ?? {}
    for (const [key, stack] of Object.entries(faces)) {
      if (!FACE_KEY.test(key)) throw new LoadError(`${id}.paint.faces has a key "${key}", which does not name a face.`)
      if (!Array.isArray(stack) || stack.length !== MATERIAL_LAYERS || !stack.every((slot) => slot === null || (typeof slot === 'string' && SLOT.test(slot)))) {
        throw new LoadError(`${id}.paint.faces["${key}"] should be ${MATERIAL_LAYERS} material layers, each "m:<id>" or null.`)
      }
    }
    return { ...base, kind: 'voxel', size, layers, voxels: { shape }, water: water as number[], paint: { faces, tint: paint.tint ?? {} } }
  }
  if (raw.kind === 'sketch') {
    const wall = (raw.wall ?? {}) as Partial<SketchStructure['wall']>
    return {
      ...base,
      kind: 'sketch',
      points: Array.isArray(raw.points) ? (raw.points as SketchStructure['points']) : [],
      closed: raw.closed === true,
      layers: typeof raw.layers === 'number' ? raw.layers : 3,
      wall: { points: Array.isArray(wall.points) ? wall.points : DEFAULT_WALL_PROFILE.points.map((p) => ({ ...p })), smooth: wall.smooth ?? true },
      lip: (raw.lip as SketchStructure['lip']) ?? 'skirt',
      capMaterial: typeof raw.capMaterial === 'string' ? raw.capMaterial : 'grass',
      wallMaterial: typeof raw.wallMaterial === 'string' ? raw.wallMaterial : 'earth',
    }
  }
  throw new LoadError(`Structure ${id} has an unknown kind: ${String(raw.kind)}.`)
}

export function deserialize(text: string): MapDoc {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    throw new LoadError(`Not valid JSON: ${(error as Error).message}`)
  }
  const version = typeof raw.formatVersion === 'number' ? raw.formatVersion : 0
  if (version !== FORMAT_VERSION) {
    throw new LoadError(
      version > FORMAT_VERSION
        ? `This map was written by a newer editor (format ${version}; this build reads ${FORMAT_VERSION}).`
        : `This map is format ${version}; this build reads only ${FORMAT_VERSION} and carries no migration (none exists yet by ruling).`,
    )
  }

  const structuresRaw = must(raw.structures as Record<string, Record<string, unknown>>, 'Map has no structures.')
  const structures: Record<string, Structure> = {}
  for (const [id, value] of Object.entries(structuresRaw)) structures[id] = normaliseStructure(value, id)
  const structureOrder = Array.isArray(raw.structureOrder) ? (raw.structureOrder as string[]).filter((id) => id in structures) : Object.keys(structures)
  for (const id of Object.keys(structures)) if (!structureOrder.includes(id)) structureOrder.push(id)
  for (const s of Object.values(structures)) {
    if (s.parent !== null && !structures[s.parent]) throw new LoadError(`Structure ${s.id} stands on ${s.parent}, which the map does not have.`)
  }

  const base = createMap(1, 1)
  const objectsRaw = (raw.objects ?? {}) as Record<string, Partial<MapObject>>
  const objects: Record<string, MapObject> = {}
  for (const [id, value] of Object.entries(objectsRaw)) objects[id] = normaliseObject(value, id)
  const order = Array.isArray(raw.objectOrder) ? (raw.objectOrder as string[]).filter((id) => id in objects) : Object.keys(objects)
  for (const id of Object.keys(objects)) if (!order.includes(id)) order.push(id)

  return {
    formatVersion: FORMAT_VERSION,
    id: (raw.id as string) ?? base.id,
    name: (raw.name as string) ?? 'Untitled Map',
    surfaceMaterials: { ...defaultSurfaceMaterials(), ...((raw.surfaceMaterials as MapDoc['surfaceMaterials']) ?? {}) },
    structures,
    structureOrder,
    objects,
    objectOrder: order,
    camera: { ...defaultCameraRig(), ...((raw.camera as MapDoc['camera']) ?? {}) },
    atmosphere: { ...makeAtmosphere(), ...((raw.atmosphere as MapDoc['atmosphere']) ?? {}) },
  }
}
