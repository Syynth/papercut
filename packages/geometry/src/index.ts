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
  addTerrain,
  cornerAt,
  createTerrainSet,
  edgeCoverage,
  edgeTile,
  exactTile,
  pairAuthored,
  removeTerrain,
  stampTemplate,
  tagCorner,
  templateTags,
  terrainOf,
  terrainSetFrom,
} from './terrainset'
export type { CornerTags, Tag, TerrainDef, TerrainSet } from './terrainset'
export { cutGrid, fitsOf, gridCells, remapTags } from './grid'
export { CORNER_BLOCKS, conventionOf, conventions, layoutTags, terrainFromLayout } from './layout'
export type { Convention, LayoutBlock, LayoutSpec, LayoutTile } from './layout'
export { renderTemplate } from './template'
export type { Template, TemplateOptions, TemplateTerrain } from './template'
export type { GridCells, Remapped } from './grid'
export { TerrainAtlas, terrainKey } from './atlas'
export { createTerrainLook } from './look'
export type { TerrainLook } from './look'
export type { AtlasTile, CompositeReport, CornerKeys, LoadedSet, TerrainKey } from './atlas'

export { meshTerrainChunk } from './terrain'
export type { MeshBuffers, TerrainChunkMesh } from './terrain'

export { meshSketch, outlineOf, triangulate, wallProfilePolyline, wallProfilePreset } from './sketch'
export type { CapMaterialSpec, EdgeRepeat, EdgeSpec, LipStyle, Outline, Profile, ProfilePoint, SketchMesh, SketchMeshOptions, WallMaterialSpec, WallProfile, WallProfilePoint } from './sketch'
