/**
 * The project on disk (decision-log 2026-09-14): a folder anchored on
 * `papercut.json`, read and written through a filesystem seam the desktop
 * shell satisfies as it is and the browser build and tests satisfy in
 * memory. Pure: no DOM, no Node, no PNG library — the image codec is handed
 * in by whoever has one.
 *
 * Written out rather than `export *`, matching the other packages.
 */

export { FsError, MemoryFs, joinPath, parentPath } from './fs'
export type { DirEntry, EntryKind, ProjectFs, WatchEvent } from './fs'
export { rawImageCodec } from './codec'
export type { ImageCodec } from './codec'
export { addImage, addMap, createProjectFolder, hashBytes, listImage, listImageFiles, mapPathFor, openProject, readMap, slugOf, writeMap, writeProject } from './folder'
export type { NewImage, NewProjectOptions, OpenedProject, StrayMap } from './folder'
export { RECENTS_LIMIT, forget, parseRecents, remember } from './recents'
export type { RecentProject } from './recents'
