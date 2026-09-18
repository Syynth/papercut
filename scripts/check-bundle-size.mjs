/**
 * Fails when a built JS chunk exceeds the ceiling. Vite/rolldown's own
 * chunk-size message (see apps/editor/vite.config.ts's manual-chunking
 * comment) is only ever a warning — it never fails the process, so the bundle
 * can regrow with an all-green gate. This turns that warning into a real
 * failure by re-measuring the already-built output on disk.
 *
 *   node scripts/check-bundle-size.mjs [dist-dir] [limit-bytes]
 *
 * Must run after `vite build`, not instead of it — it only reads output that
 * already exists; it does not build anything itself.
 *
 * What this is FOR (ruled 2026-09-17): not first paint. The editor loads from
 * local disk over `app://` in the desktop shell. It is a tripwire for an
 * accidental import dragging a library into the entry chunk, which costs on
 * the two paths the bundle really travels: the Pages site people try the
 * editor on, and the updater, which fetches an installed app's UI bundle from
 * that same deploy file by file and skips whatever hash it already has.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A number chosen for this app, not Vite's default `chunkSizeWarningLimit` of
// 500 kB, which is a heuristic about one script blocking first paint over a
// mobile connection and describes nothing papercut does. kB decimal (1000
// bytes), the same convention apps/editor/vite.config.ts's `maxSize: 350_000`
// already uses. Raising it costs about 75 kB gzipped on a cold Pages visit and
// on a UI update; below that the ceiling was shaping the code rather than
// catching anything.
export const DEFAULT_LIMIT_BYTES = 750_000

/**
 * @typedef {{ file: string, bytes: number }} ChunkSize
 */

/**
 * Pure so the failure path is testable without a real build: takes sizes
 * already read from disk rather than reading them itself.
 * @param {ChunkSize[]} sizes
 * @param {number} [limit]
 */
export function oversizedChunks(sizes, limit = DEFAULT_LIMIT_BYTES) {
  return sizes.filter(({ bytes }) => bytes > limit)
}

/**
 * A malformed CLI limit (e.g. `500kB` instead of `500000`) must fail loud,
 * not disappear: `Number('500kB')` is `NaN`, and `bytes > NaN` is always
 * false in `oversizedChunks`, so an unchecked `Number(argv[3])` would make
 * this gate script silently exit 0 on every build regardless of chunk size.
 * @param {string | undefined} raw
 * @param {number} [fallback]
 */
export function parseLimit(raw, fallback = DEFAULT_LIMIT_BYTES) {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid limit-bytes argument: ${JSON.stringify(raw)}`)
  }
  return value
}

/** @param {string} distDir */
function jsChunkSizes(distDir) {
  const assetsDir = join(distDir, 'assets')
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ file: name, bytes: statSync(join(assetsDir, name)).size }))
}

function main() {
  const distDir = process.argv[2] ?? join('apps', 'editor', 'dist')
  let limit
  try {
    limit = parseLimit(process.argv[3])
  } catch (error) {
    // `parseLimit` only ever throws `Error`, but the catch binding is
    // `unknown` under `strict` regardless — narrow instead of assuming, so a
    // future throw of something else prints itself rather than crashing this
    // handler on a missing `.message`.
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }
  const offenders = oversizedChunks(jsChunkSizes(distDir), limit)
  if (offenders.length === 0) return
  for (const { file, bytes } of offenders) {
    console.error(`${file}: ${bytes} bytes exceeds the ${limit}-byte chunk ceiling`)
  }
  process.exitCode = 1
}

// Guarded so the test file can import `oversizedChunks` without also running
// the CLI path against a `dist/` that may not exist in the test run.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
