/**
 * The fixtures package's public surface — the DOM-free half of it.
 *
 * Dev-only, in the sense that nothing shipped depends on it — but deliberately
 * NOT lint-exempt, because its output is real data the editor loads and has to
 * satisfy the same invariants as anything else (see `eslint.config.js`).
 *
 * `textures.ts` (the placeholder art generator, #3 parked it here, #47 moved
 * it) draws with a 2D canvas and is reached through the separate `./textures`
 * export instead of here (#48): it is the one file in this package that needs
 * `DOM` in `lib` to typecheck at all, and tsc type-checks a whole imported
 * file under the IMPORTER's compiler options, not the file's own package's —
 * so re-exporting it from this barrel would force `DOM` into every
 * consumer's `tsconfig`, including `apps/export-cli`'s, whose entire
 * acceptance criterion is compiling without it. `createSampleMap` and
 * `bakedDir` need no canvas of their own and belong here; where a headless
 * caller needs the pixels `textures.ts` would have drawn, `bakedDir()` points
 * at the checked-in, pre-rendered stand-in under `baked/` (`pnpm bake`
 * regenerates it).
 *
 * Written out rather than `export *`, matching the other packages.
 */

export { createSampleMap, createSampleProject } from './sample'
export { PLACEHOLDER_PAIRS, PLACEHOLDER_TERRAINS, generatePlaceholderTerrainSet, generateTerrainSetArt } from './terrainset'
export type { PlaceholderTerrain, PlaceholderTerrainSet } from './terrainset'
export { RAIL_ART, RAIL_MATERIALS, RAIL_SHEET, bendTile, generateRailSet, railSheetSvg, railTile, sideTile } from './rails'
export type { RailArt, RailShape } from './rails'
export { bakedDir } from './baked-dir'
