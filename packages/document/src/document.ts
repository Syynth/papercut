/**
 * The document model.
 *
 * Everything the editor knows about a map lives here as plain, serializable
 * data. Geometry is never stored — it is derived from this by the meshers.
 *
 * Expensive-to-reverse decisions, made deliberately and once:
 *
 *  1. `formatVersion` exists from the first commit, even while there is only
 *     one version of it. Migrations are cheap to add and impossible to
 *     retrofit.
 *  2. Heights are integer HALF-TILE units. `height: 3` means a top surface at
 *     1.5 world units. Half steps were listed as an open question; storing
 *     integers of a half unit costs nothing now and avoids a file migration
 *     later if we decide we want them.
 *  3. One world unit is one tile, always. Pixel density is a per-map setting
 *     that changes texture detail only, never scale.
 *  4. Paint is addressed in stable grid coordinates, never per mesh face.
 *     See `paint.ts` for the full invariant — it is the single most important
 *     rule in this file.
 */

import { defaultSurfaceMaterials, type FillEdgeMaterial, type Structure, type VoxelStructure } from './structure'

export const FORMAT_VERSION = 4

export type Direction = 0 | 1 | 2 | 3
/** +X east, +Z south, -X west, -Z north. Index order used everywhere. */
export const DIR_VECTORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
]
export const DIR_NAMES = ['East', 'South', 'West', 'North'] as const

/** No ramp: the answer of `rampDirAt` for a level top. */
export const NO_RAMP = -1
/** No water in this column. */
export const NO_WATER = -32768

/** No voxel here. */
export const AIR = -1
/** Voxel shapes. A sloped shape's direction (the way it descends) is added to its base value. See `voxels.ts`. */
export const SHAPE_BLOCK = 0
export const SHAPE_SLAB = 1
/** `SHAPE_RAMP + dir`: a 45° slope, one tile of drop over the cell. */
export const SHAPE_RAMP = 2
/** `SHAPE_HALF_RAMP + dir`: one half-tile of drop over half the cell from the floor, then flat; finishes an odd drop. */
export const SHAPE_HALF_RAMP = 6
/** `SHAPE_HALF_RAMP_UP + dir`: the same wedge riding a slab, for an odd drop whose low side is a half-tile up. */
export const SHAPE_HALF_RAMP_UP = 10
/** How many layers a new volume gets: 20 cubes, the old 40-half-tile ceiling. */
export const DEFAULT_LAYERS = 20
/** The most layers a volume may have: the mesher keys a band by its half-tile level in eight bits. */
export const MAX_LAYERS = 128
/** The shapes a voxel may take: SHAPE_BLOCK up to the last half-ramp direction. */
export const SHAPE_COUNT = SHAPE_HALF_RAMP_UP + 4

export interface MapSize {
  width: number
  height: number
}

/**
 * Parallel arrays, one entry per voxel, indexed by `voxelIndex` in
 * `voxels.ts`: `(y * height + z) * width + x`. Plain number arrays rather
 * than typed arrays so the document is JSON without a serializer. If
 * profiling ever demands typed arrays, that is a change to `io.ts` and this
 * interface, not to any tool.
 */
export interface VoxelData {
  /** The id of a material in the project's library, or AIR. */
  material: number[]
  /** A shape (SHAPE_*); meaningless where the material is AIR. */
  shape: number[]
}

/**
 * Painted overrides. Keys are stable grid addresses (see paint.ts).
 *
 * Entries are NEVER deleted when geometry shrinks. A face that stops
 * existing leaves its paint behind, dormant; raising the terrain again brings
 * it back. That dormancy is the whole mechanism behind "paint survives
 * sculpt", and it works precisely because nothing garbage-collects this.
 */
export interface PaintLayers {
  /** `${x},${z},${y},${dir}` -> the material one face of one voxel is drawn with, instead of the voxel's own. */
  faces: Record<string, number>
  /** `${x},${z}` -> packed 0xRRGGBB */
  tint: Record<string, number>
}

export type DisplayMode =
  | 'fixed'
  | 'billboardY'
  | 'billboardFull'
  | 'crossed'
  | 'extruded'
  | 'auto'

export const DISPLAY_MODES: DisplayMode[] = [
  'fixed',
  'billboardY',
  'billboardFull',
  'crossed',
  'extruded',
  'auto',
]

export type BackSide = 'none' | 'mirror' | 'dark' | 'image'
export type FacingTransition = 'instant' | 'flip' | 'crossfade'
export type Hinge = 'center' | 'base' | 'edge'

/**
 * Paper Mario style facing and flip behaviour. Firm that it exists; the
 * specific knobs are the tentative part.
 */
export interface FacingConfig {
  /** How many directional images the sprite has. */
  facings: 1 | 2 | 4 | 8
  /** Reuse the right-hand images mirrored for the left side. */
  mirror: boolean
  back: BackSide
  transition: FacingTransition
  durationMs: number
  /** Degrees of overlap before a facing switches back, to stop flicker. */
  hysteresisDeg: number
  hinge: Hinge
}

export function defaultFacing(): FacingConfig {
  return {
    facings: 1,
    mirror: true,
    back: 'mirror',
    transition: 'flip',
    durationMs: 260,
    hysteresisDeg: 8,
    hinge: 'center',
  }
}

export interface MapObject {
  id: string
  name: string
  /** Asset key into the sprite library. */
  sprite: string
  position: [number, number, number]
  rotationY: number
  scale: number
  display: DisplayMode
  facing: FacingConfig
  /**
   * Grounding. When set, the object rides the terrain: sculpting the cell
   * moves it instead of burying it.
   */
  anchorCell: [number, number] | null
  /** Stable per-instance seed, so variation exports identically every time. */
  seed: number
  locked: boolean
  hidden: boolean
}

export interface CameraBounds {
  yawMin: number
  yawMax: number
  pitchMin: number
  pitchMax: number
  distMin: number
  distMax: number
}

export interface CameraRig {
  yaw: number
  pitch: number
  distance: number
  fov: number
  bounds: CameraBounds
  /** 0 means continuous; 90 gives detents. */
  yawSnapDeg: number
  projection: 'perspective' | 'orthographic'
}

export interface Atmosphere {
  preset: string
  fogColor: number
  fogNear: number
  fogFar: number
  skyTop: number
  skyHorizon: number
  skyBottom: number
  sunColor: number
  sunIntensity: number
  ambientIntensity: number
  sunAzimuth: number
  sunElevation: number
  /** Post-processing. Presets move these together; sliders are secondary. */
  bloom: number
  tiltShift: number
  /** Painted distant scenery: the no-modeling answer to far-off mountains. */
  backdrop: BackdropCard[]
}

export interface BackdropCard {
  sprite: string
  /** World height of the card's bottom edge. */
  base: number
  height: number
  /** Distance from map centre. */
  radius: number
  /** 0..1, how much it lags the camera. */
  parallax: number
  opacity: number
}

/**
 * A material: what a face of a voxel is made of (ruling of 2026-09-17).
 *
 * A material does not point at its art. Its art is wherever tiles tagged
 * with it are, on any image the project has — which is why there is no
 * terrain here any more, and why two materials can meet in an authored tile
 * however their sheets are organised. `side` is not art indirection: it says
 * what a voxel of this material cuts its CLIFFS with, which is another
 * material, because a material belongs to a face rather than to a voxel.
 *
 * The order of the project's materials is their priority: the shape a
 * template takes when it is placed for a pair, and the layering of a
 * composited corner.
 */
export interface MaterialDef {
  /**
   * What a voxel stores. Assigned when the material is made and never reused
   * or renumbered, so the list can be reordered — its order is the
   * materials' priority — or a material deleted without a voxel changing
   * what it is made of.
   */
  id: number
  name: string
  /** Fallback colour when no sheet is loaded, and the swatch. */
  color: number
  /**
   * The surface vocabulary its art fills (design of 2026-09-17): a floor
   * material owes the corner set, a wall owes its named parts, a ramp owes
   * its own at a different aspect. Replaces the old `role`, which said where
   * a material belonged without saying what it owed.
   */
  archetype: ArchetypeId
  /** The material this one's vertical faces are made of; absent means they are made of this one. */
  side?: number
}

/** The surface vocabularies papercut ships. `@papercut/geometry` says what each owes. */
export type ArchetypeId = 'floor' | 'wall' | 'ramp'

/**
 * One map of a project. What every map shares — the materials its voxels
 * name, the resolution profile, the sheets — is the project's (`project.ts`),
 * never copied here: a map holds only what is its own.
 */
export interface MapDoc {
  formatVersion: number
  id: string
  name: string
  /** The fill-and-edge materials sketches are dressed in, by name. */
  surfaceMaterials: Record<string, FillEdgeMaterial>
  /**
   * What the level is made of: a scene graph of structures (see
   * `structure.ts`). The terrain, its size and its paint live on a voxel
   * structure, not here; the level has no size of its own — its extent is
   * whatever its structures cover.
   */
  structures: Record<string, Structure>
  structureOrder: string[]
  objects: Record<string, MapObject>
  objectOrder: string[]
  camera: CameraRig
  atmosphere: Atmosphere
}

/**
 * The document as everyone but the document actor sees it (#13).
 *
 * A structural, recursive `readonly` over `MapDoc`: every property, every
 * array and every nested object. Verified during prototyping to reject all
 * four write shapes — indexed assignment (`voxel.voxels.material[i] = m`),
 * record assignment (`voxel.paint.faces[key] = m`), array mutation (`push`,
 * `splice`) and property replacement (`doc.name = …`) — while leaving reads
 * untouched. No branding is needed because the arrays are plain `number[]`
 * and the records plain `Record<string, number>`: the mapped type is enough,
 * and `MapDoc` itself is assignable to it, so a read-only helper accepts both.
 *
 * Functions never become readonly: `T extends (...args) => unknown` short-
 * circuits before the mapping so a future method-bearing value would keep its
 * callable type. `MapDoc` has none today; the clause costs nothing and stops
 * the type silently turning a function into an object of readonly keys.
 *
 * The mapped clause is homomorphic over a type parameter, which is what makes
 * TypeScript map a tuple to a readonly tuple and an array to a readonly array
 * rather than to an object with numeric keys — `position` stays
 * `readonly [number, number, number]`, not `{ readonly 0: number; … }`.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

export type ReadonlyMapDoc = DeepReadonly<MapDoc>

export function cellIndex(size: MapSize, x: number, y: number): number {
  return y * size.width + x
}

export function inBounds(size: MapSize, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < size.width && y < size.height
}

/** Half-tile units to world units. */
export const HALF = 0.5

export function worldHeight(halfTiles: number): number {
  return halfTiles * HALF
}

/** The sheet the generated placeholder art is written to, which a fresh project starts tagged against. */
export const PLACEHOLDER_SHEET = 'ground.png'

export const DEFAULT_MATERIALS: MaterialDef[] = [
  { id: 0, name: 'Grass', color: 0x6aa84f, archetype: 'floor', side: 1 },
  { id: 1, name: 'Dirt', color: 0x8b6b45, archetype: 'floor' },
  { id: 2, name: 'Stone', color: 0x8e8e8e, archetype: 'wall' },
  { id: 3, name: 'Sand', color: 0xd9c27e, archetype: 'floor', side: 1 },
  { id: 4, name: 'Path', color: 0xb08f5e, archetype: 'floor', side: 1 },
]

/** The material a voxel names, by id; `undefined` for an id the project no longer has. */
export function materialById(materials: readonly MaterialDef[], id: number): MaterialDef | undefined {
  return materials.find((m) => m.id === id)
}

/** An id no material of the project has: the next number after the highest. */
export function nextMaterialId(materials: readonly MaterialDef[]): number {
  return materials.reduce((max, m) => Math.max(max, m.id + 1), 0)
}

export const ATMOSPHERE_PRESETS: Record<string, Omit<Atmosphere, 'preset' | 'backdrop'>> = {
  'Clear noon': {
    fogColor: 0xbcd7ee,
    fogNear: 24,
    fogFar: 90,
    skyTop: 0x4a8fd4,
    skyHorizon: 0xbcd7ee,
    skyBottom: 0xe8e0cf,
    sunColor: 0xfff3d6,
    sunIntensity: 1.5,
    ambientIntensity: 0.65,
    sunAzimuth: 135,
    sunElevation: 55,
    bloom: 0.35,
    tiltShift: 0.25,
  },
  'Misty dusk': {
    fogColor: 0xc2a3b4,
    fogNear: 10,
    fogFar: 55,
    skyTop: 0x3b3560,
    skyHorizon: 0xe0a17c,
    skyBottom: 0x6d5470,
    sunColor: 0xffb27a,
    sunIntensity: 1.1,
    ambientIntensity: 0.5,
    sunAzimuth: 250,
    sunElevation: 12,
    bloom: 0.7,
    tiltShift: 0.55,
  },
  'Night festival': {
    fogColor: 0x1d2340,
    fogNear: 8,
    fogFar: 48,
    skyTop: 0x090d22,
    skyHorizon: 0x27305c,
    skyBottom: 0x151a30,
    sunColor: 0x9fb6ff,
    sunIntensity: 0.35,
    ambientIntensity: 0.35,
    sunAzimuth: 300,
    sunElevation: 35,
    bloom: 1.1,
    tiltShift: 0.45,
  },
  Overcast: {
    fogColor: 0xc8cdd2,
    fogNear: 18,
    fogFar: 70,
    skyTop: 0x8f9aa6,
    skyHorizon: 0xc8cdd2,
    skyBottom: 0xb3b8bd,
    sunColor: 0xe8eef5,
    sunIntensity: 0.75,
    ambientIntensity: 0.85,
    sunAzimuth: 180,
    sunElevation: 60,
    bloom: 0.2,
    tiltShift: 0.3,
  },
}

/** Preset fog distances are authored for a map this many tiles across. */
export const PRESET_REFERENCE_SPAN = 32

/**
 * Fog distances in a preset describe a *look*, not an absolute distance, so
 * they scale with the map. Without this, opening a 64-tile map with a preset
 * authored against a 32-tile one buries the far half of the level in fog.
 */
export function makeAtmosphere(preset = 'Clear noon', mapSpan = PRESET_REFERENCE_SPAN): Atmosphere {
  const base = ATMOSPHERE_PRESETS[preset] ?? ATMOSPHERE_PRESETS['Clear noon']
  const scale = Math.max(0.25, mapSpan / PRESET_REFERENCE_SPAN)
  return {
    preset,
    ...base,
    fogNear: Math.round(base.fogNear * scale),
    fogFar: Math.round(base.fogFar * scale),
    backdrop: [],
  }
}

export function defaultCameraRig(): CameraRig {
  return {
    yaw: 45,
    pitch: 35,
    distance: 22,
    fov: 30,
    bounds: {
      yawMin: -180,
      yawMax: 180,
      pitchMin: 20,
      pitchMax: 60,
      distMin: 8,
      distMax: 40,
    },
    yawSnapDeg: 0,
    projection: 'perspective',
  }
}

let idCounter = 0

/** Stable IDs assigned at creation and never changed. Prefab overrides will depend on this. */
export function newId(prefix = 'obj'): string {
  idCounter += 1
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, '0')
  return `${prefix}_${rand}${idCounter.toString(36)}`
}

/** A flat voxel volume of `width` × `height` cells, one cube tall in the first material, standing on `parent` (or the ground). */
export function createVoxel(width: number, height: number, name = 'Ground', parent: string | null = null, id = newId('vox'), layers = DEFAULT_LAYERS): VoxelStructure {
  const count = width * height
  const material = new Array<number>(count * layers).fill(AIR)
  material.fill(0, 0, count)
  return {
    id,
    kind: 'voxel',
    name,
    parent,
    placement: { x: 0, z: 0, yaw: 0 },
    size: { width, height },
    layers,
    voxels: { material, shape: new Array<number>(count * layers).fill(SHAPE_BLOCK) },
    water: new Array<number>(count).fill(NO_WATER),
    paint: { faces: {}, tint: {} },
  }
}

/** A new level: one root voxel volume of the given size, and nothing else. Its id is always `ground`, so a test or a tour can name it without looking it up. */
export function createMap(width = 32, height = 32, name = 'Untitled Map'): MapDoc {
  const ground = createVoxel(width, height, 'Ground', null, 'ground')
  return {
    formatVersion: FORMAT_VERSION,
    id: newId('map'),
    name,
    surfaceMaterials: defaultSurfaceMaterials(),
    structures: { [ground.id]: ground },
    structureOrder: [ground.id],
    objects: {},
    objectOrder: [],
    camera: defaultCameraRig(),
    atmosphere: makeAtmosphere('Clear noon', Math.max(width, height)),
  }
}
