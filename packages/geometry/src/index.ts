/**
 * The geometry package's public surface.
 *
 * Turning a document into vertex buffers, plus the terrain sets and the atlas
 * that say what a tile is. The two travel together because the mesher is the
 * atlas's only consumer — it asks for the tile at a corner and a UV rectangle
 * per quarter — and nothing else in the graph needs one without the other.
 *
 * Written out rather than `export *` for the same reason as `document`'s
 * barrel: the meshing worker that issue #3 draws this boundary for will want a
 * narrower surface than the editor does, and narrowing it should be one visible
 * edit here rather than a wildcard quietly changing shape.
 */

export {
  CORNER_BITS,
  TerrainSetError,
  assemble,
  cornerAt,
  cornerKey,
  createTerrainSet,
  edgeCoverage,
  edgeTile,
  exactTile,
  pairAuthored,
  removeMaterial,
  stampBlock,
  stampTemplate,
  tagCorner,
  templateTags,
  terrainOf,
  terrainSetFrom,
} from './terrainset'
export type { CornerTags, PatchCorner, Tag, TerrainSet } from './terrainset'
export { cutGrid, fitsOf, gridCells, remapTags } from './grid'
export { FRINGE, ORDINARY, PICKET, RAMP_RISE, allSlots, archetypeOf, archetypes, arrangements, maskKind, requiredSlots, slotSize } from './archetype'
export type { Archetype, Arrangement, Slot } from './archetype'
export { CORNER_BLOCKS, conventionOf, conventions, layoutTags, terrainFromLayout } from './layout'
export type { BlockShape, Convention, LayoutBlock, LayoutSpec, LayoutTile } from './layout'
export { renderTemplate } from './template'
export type { Template, TemplateMaterial, TemplateOptions } from './template'
export type { GridCells, Remapped } from './grid'
export { DEFAULT_FALLBACK, TerrainAtlas } from './atlas'
export { createTerrainLook } from './look'
export { projectSprites } from './sprites'
export type { ProjectSprites } from './sprites'
export type { TerrainLook, TrimSettings } from './look'
export type { AtlasOptions, AtlasTile, CornerKeys, LoadedSet, MissingReport, TrimPart } from './atlas'

export { meshTerrainChunk } from './terrain'
export type { MeshBuffers, TerrainChunkMesh } from './terrain'

export { meshSketch, outlineOf, triangulate, wallProfilePolyline, wallProfilePreset } from './sketch'
export type { CapMaterialSpec, EdgeRepeat, EdgeSpec, LipStyle, Outline, Profile, ProfilePoint, SketchMesh, SketchMeshOptions, WallMaterialSpec, WallProfile, WallProfilePoint } from './sketch'
