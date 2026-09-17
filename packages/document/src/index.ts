/**
 * The document package's public surface. Everything here is either data, a
 * pure function over data, or the actor that owns the one write path.
 */
export {
  AIR,
  ATMOSPHERE_PRESETS,
  DEFAULT_LAYERS,
  DEFAULT_MATERIALS,
  MAX_LAYERS,
  SHAPE_COUNT,
  DIR_NAMES,
  DIR_VECTORS,
  DISPLAY_MODES,
  FORMAT_VERSION,
  HALF,
  NO_RAMP,
  NO_WATER,
  PLACEHOLDER_SHEET,
  PRESET_REFERENCE_SPAN,
  SHAPE_BLOCK,
  SHAPE_HALF_RAMP,
  SHAPE_HALF_RAMP_UP,
  SHAPE_RAMP,
  SHAPE_SLAB,
  cellIndex,
  createMap,
  createVoxel,
  defaultCameraRig,
  defaultFacing,
  inBounds,
  makeAtmosphere,
  materialById,
  newId,
  nextMaterialId,
  worldHeight,
} from './document'
export {
  columnHeights,
  columnShapes,
  columnTopAt,
  faceExposed,
  fillColumn,
  halfRampShape,
  halfRampUpShape,
  heightAt,
  isHalfRampShape,
  isRampShape,
  isSlopedShape,
  materialAt,
  maxHeightOf,
  rampDirAt,
  rampShape,
  shapeHeight,
  shapeLowHeight,
  shapeRampDir,
  topHeight,
  topShapeAt,
  voxelAt,
  voxelIndex,
} from './voxels'
export type { VoxelBox } from './voxels'
export type {
  Atmosphere,
  BackdropCard,
  BackSide,
  CameraBounds,
  CameraRig,
  DeepReadonly,
  Direction,
  DisplayMode,
  FacingConfig,
  FacingTransition,
  Hinge,
  MapDoc,
  MapObject,
  MapSize,
  MaterialDef,
  PaintLayers,
  ReadonlyMapDoc,
  TerrainRef,
  VoxelData,
} from './document'
export { DEFAULT_SURFACE_MATERIALS, ancestorsOf, childrenOf, defaultSurfaceMaterials, descendantsOf, outlineOf, pointInOutline, structureOf } from './structure'
export type {
  EdgeBand,
  EdgeRepeat,
  FillEdgeMaterial,
  LipStyle,
  Outline,
  Placement,
  Profile,
  ProfilePoint,
  QuarterTurn,
  ReadonlySketch,
  ReadonlyStructure,
  ReadonlyStructureTree,
  ReadonlyVoxel,
  SketchStructure,
  Structure,
  StructureBase,
  StructureKind,
  StructureTree,
  VoxelStructure,
  WallProfile,
  WallProfilePoint,
} from './structure'
export type { RgbaImage, SpriteAsset } from './image'
export {
  DEFAULT_WALL_PROFILE,
  MAX_HEIGHT,
  MIN_HEIGHT,
  addObject,
  addSketchPoint,
  addStructure,
  brushCells,
  clearRampRun,
  closeSketch,
  columnPatches,
  createSketch,
  deleteSketchPoint,
  fillCells,
  flatten,
  groundedPosition,
  heightToWorld,
  paintFace,
  paintTint,
  placeStructure,
  placeStructureOnto,
  raise,
  rampPlan,
  rampRun,
  rampRunBlocked,
  rampRunLength,
  rectCells,
  regroundObjects,
  removeObject,
  removeStructure,
  renameStructure,
  reparentStructure,
  setMaterial,
  setSketch,
  setWater,
  smooth,
  updateObject,
  updateSketchPoint,
} from './ops'
export type { Brush, BrushShape, Cell, FaceRef, RampEdge, RampStep, SketchChanges } from './ops'
export { FACE_BOTTOM, FACE_TOP, countDormant, faceKey, facePaint, parseFaceKey, tintKey, tintPaint } from './paint'
export type { DocumentReader } from './store'
export { applyPatches, inversePatch, patchAddress } from './edits'
export type { Patch, SketchField, SketchPatch, StrokeRecord, StructureMetaPatch } from './edits'
export { createDocument } from './actor'
export type { DocumentActorLogic, DocumentEvent, DocumentSource } from './actor'
export { DOCUMENT_OWNER, documentKeys } from './commands'
export { LoadError, deserialize, serialize } from './io'
export {
  SURFACE_CLIFF,
  SURFACE_SKETCH_CAP,
  SURFACE_SKETCH_WALL,
  SURFACE_TOP,
  SURFACE_WATER,
  decodeExtra,
  describeSurface,
  encodeExtra,
  readAddress,
  sameSurface,
} from './surface'
export type { SurfaceAddress, SurfaceKind } from './surface'
export {
  CORNER_OFFSETS,
  RAMP_DROP,
  RAMP_LOW_CORNERS,
  cellCentreWorld,
  cornerHeights,
  frameOf,
  groundHeight,
  levelBounds,
  levelCentre,
  structureAt,
  toLocal,
  toWorld,
  voxelTop,
} from './terrain'
export type { Bounds, Frame } from './terrain'
export { CHUNK_SIZE, allChunkKeys, chunkBounds, chunkKey, parseChunkKey, parseStructureChunkKey, structureChunkKey } from './chunks'
export type { ChunkBounds } from './chunks'
export { snapTo, type SnapAnchor, type SnapMode } from './snap'
export type { DocumentTarget } from './target'

// The project: what every map in a folder shares (2026-09-14).
export { MAPS_DIR, PROJECT_FILE, PROJECT_FORMAT_VERSION, SHEETS_DIR, createProject, emptyTerrain, normaliseGrid, normaliseImage, normaliseMaterials, normaliseTerrain, parseProject, placeholderImage, plainGrid, serializeProject, sheetName, stemOf } from './project'
export type { Axes, CornerTags, Grid, ImageEntry, ImageKind, ImageTerrain, ProjectDoc, ReadonlyProjectDoc, ResolutionProfile, Tag, TerrainDef } from './project'
