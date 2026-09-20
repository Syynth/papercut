/**
 * The gate budget (#10): the whole vitest run must finish inside 15 seconds,
 * or the run fails.
 *
 * "Quickly" is half of "iterate quickly and safely", and a suite that takes
 * four minutes is not a fast loop however much it covers. #10 fixed the
 * per-iteration budget at 15 s cold and asked for it to be enforced by the
 * run rather than watched by a person.
 *
 * This is a vitest `globalSetup`, not a test file, because no single test
 * can see the whole run: files execute in parallel workers, and the last file
 * to START is not the last to finish. `globalSetup` runs once in the main
 * process before the first worker spawns, and its returned teardown runs once
 * after the last worker reports — so the interval between the two is the
 * whole run as a person waiting on it experiences it, transform and import
 * time included. A throw from the teardown fails the run (exit code 1,
 * verified on vitest 5.0.0), which is what makes this a gate rather than a
 * number in a log.
 *
 * The budget is generous against the current run — well under a second on a
 * warm machine — on purpose. It is not a performance regression detector for
 * a single slow test; it is the ceiling the loop must never cross, set where
 * #10 set it. Tighten it here if the ceiling moves, never per test.
 *
 * Moved from 15 s to 25 s once the actor migration (#66) landed both of its
 * trains: the gate's CI runner measured 12.54 s at 181 tests / 24 files
 * (main @ 33f7e5b) and 21.7 s at 358 tests / 35 files (this train), close
 * to linear in file count — per-file worker spawn dominates there in a way
 * a many-core local machine never shows. `isolate: false` was tried first
 * to cut that per-file cost instead of moving the ceiling, but this suite's
 * registries (keymap, context, feature) are module-level and own-scoped
 * only within a single vitest worker's isolation, not across files sharing
 * one — turning it off made 1-5 tests fail nondeterministically depending
 * on file/worker assignment. Moving the ceiling is the honest fix for a
 * suite that has genuinely grown, not a workaround for a slow test.
 */

/*
 * Moved from 25 s to 30 s when the sketch feature landed (#107 step 4): a
 * tenth package with its own vitest worker, measured at 25.3 s on a cold
 * GitHub runner against the old ceiling — the same per-file fixed cost the
 * note above describes, one file more. Still an order of magnitude over the
 * suite's own work.
 */
/*
 * Moved from 30 s to 40 s when the terrain round and the project round
 * landed (2026-09-14): the sheet, atlas, project-folder, native-menu and
 * session tests brought the suite to 541 tests / 58 files, measured at
 * 30.5 s and 31.7 s on the cold runner — and `main` itself at 30.6 s after
 * the terrain merge, so the ceiling had already been crossed by growth
 * alone. Same per-file cost as the two notes above; same honest fix.
 */
/*
 * Moved from 40 s to 50 s on 2026-09-19, by the owner's say-so, when the
 * Materials section and the aseprite packages brought the suite to 732
 * tests / 72 files. The same commit measured 41.2 s on one cold runner and
 * 30.5 s on the next, so the ceiling was inside the runners' own variance
 * and failed a green suite at random. The work is the 30 s; the other ten
 * are the runner. The ceiling sits clear of both.
 */
const BUDGET_MS = 50_000

export default function setup(): () => void {
  const start = performance.now()
  return () => {
    const elapsed = performance.now() - start
    if (elapsed > BUDGET_MS)
      throw new Error(`gate budget exceeded: the vitest run took ${(elapsed / 1000).toFixed(1)} s against a ${BUDGET_MS / 1000} s ceiling (#10)`)
  }
}
