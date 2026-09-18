# papercut pump configuration

Fill `pump.js`'s CONFIG from these. Replaces brink's `BRINK-CONFIG.md`; nothing in that
file applies here.

**Provenance.** `SKILL.md` and `pump.js` are copied verbatim from `~/code/rs/brink`
at `.claude/skills/autonomous-pump`, brink commit `0692a12` (2026-07-29). They are the
same author's work, not third-party — unlike the `mattpocock/skills` copies in this
directory, which have their own rules in [`../VENDORED.md`](../VENDORED.md). When brink's
version improves, re-copy rather than editing in place, and keep project-specific
material in *this* file so the re-copy stays clean.

## ⚠ Readiness: the pump is not usable yet

The restructure is done (branch `restructure`, twelve commits, verified in
[`docs/audit-2026-09-11.md`](../../../docs/audit-2026-09-11.md)), so the layout objection is
gone. One blocker remains, and it is the one Gate 0 is strictest about:

**There is no build-ready backlog.** Every open issue is a wayfinder decision ticket
(`needs-design` by definition), a question needing a human or a real GPU, or already done.
The three waves produced ~56 scope notes and gaps that live only in workflow journals.
**Scope reconciliation — turning those into triaged issues — is the prerequisite for the
first parallel wave**, and per the wayfinder-feed rule each item sorts into either a map
ticket (a decision) or an ordinary issue (merely unbuilt). That sorting is a human call.

## Gate

```
pnpm install --prefer-offline && pnpm turbo run test typecheck lint
```
Twelve turbo tasks across seven packages and two apps (`apps/export-cli` was cut
2026-09-11 and revived by #48, once #47 landed its texture prerequisite); 107 tests in
16 files, counted from a fresh cold `pnpm turbo run test typecheck lint` rather than
adjusted from the old total — the repo-wide suites under `tests/` (dependency direction,
the runtime barrel, the checked-in bake, the gate workflow) plus each package's own and
`scripts/`'s. `apps/export-cli`'s own suite is two files: one exercises `exportMapFile`
straight from source, the other (`cli.build.test.ts`) builds the CLI's real bundle with
vite and spawns it as its own `node` process — the slowest test in the suite, and the one
that actually proves the acceptance criterion #48 names (a real `.glb` under plain node),
not just that the source compiles. ~7 s cold, single-digit ms on a cache hit — the gate
is fast enough that agents should run it on every iteration.

CI (`.github/workflows/gate.yml`) runs a superset of this on every PR and every push to
`main`: it also builds `apps/editor` and, since #48 revived it, `apps/export-cli` — the
only two of the twelve packages with a `build` script that nothing else depends on, so
the `test`/`typecheck`/`lint` tasks above, which depend only on `^build`, never reach
them — as its own step *before* linting, in a fresh checkout with no pre-existing
`dist/`. Since #46 gave every `packages/*` package a `build` of its own, the gate is no
longer build-free: `pnpm turbo run test typecheck lint` enqueues 49 tasks of which 10
are `build`, because `^build` now materialises every package's `dist/` before anything
is checked. That ordering is load-bearing, not
incidental: see the workflow's header comment and
`eslint.config.js`'s `ignores` comment for the bug a lint-before-build job would never
catch. That same Build step now also enforces the chunk ceiling (#57's
`check-bundle-size`, `dependsOn: ["build"]`) — this doc is the only place a pump agent
would learn the ceiling is gated at all. CI itself runs `pnpm gate` (the test/typecheck/
lint task set above) plus `pnpm turbo run build check-bundle-size` as two separate steps,
never `gate:full` — `gate:full` exists for local parity so a contributor can run the same
superset in one command before pushing. Wrong-Node-version enforcement is root
`package.json`'s `devEngines.runtime` (#55) — `engineStrict` in `pnpm-workspace.yaml`
only gates a dependency's own declared engines, not this workspace's.

`scripts/check-boundaries.mjs` is gone. `tests/dependency-direction.test.ts` replaces it:
it builds the workspace graph from declared dependencies, asserts the decided direction
and acyclicity, and **fails on an unplaced package**, so a new package cannot be silently
unchecked. pnpm's strict `node_modules` handles the other half — an undeclared import fails
to resolve (verified: `import 'three'` inside `packages/document` is TS2307).

`lint` is ESLint 10 + typescript-eslint 8, type-aware, `noInlineConfig: true`. Test files,
benchmarks and `scripts/` are scoped out; `packages/fixtures` is not. The custom-rules
package (`packages/eslint-rules`) is a wired-in **empty** skeleton until #22 and #12 land.

**CACHE prefix** (once Turborepo is installed):
```
export TURBO_CACHE_DIR=/tmp/pump-turbo-cache-papercut
```
There is no Rust here, so the multi-gigabyte `target/` problem brink fought does not
apply. Peak disk is `node_modules` per worktree, which pnpm hard-links from its
content-addressable store — keep worktrees on the same volume and clone `node_modules`
with `cp -c -R` (APFS) as the `DISK` preamble already instructs.

## Model tiers (owner's ruling, 2026-09-12)

**Opus for review and for hard builds; Sonnet for ordinary builds, the merge train, fixes,
lessons and retro; Haiku for the light lane.** Fable only when the work is genuinely critical
— the actor migration qualified; a config sweep does not. The default `pump.js` tiers already
say this; the one deviation to avoid is running everything on the session model.

## Repo

- **Repo:** `Syynth/papercut` · **default branch:** `main` · **assignee:** `Syynth`
- **Trailer:** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **PR footer:** `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
- **CI is live.** `.github/workflows/gate.yml` runs the gate above (plus a build) on every
  PR and push to `main`; branch protection on `main` requires the `gate` check, `strict`
  (up to date before merge), and applies to admins too (#25). The adversarial review step
  still carries the weight it always did — CI catches what the gate checks, not what a
  review does.

## Conventions (CONV)

TypeScript, ESM, single quotes, no semicolons, 2-space indent. Named exports; no default
exports. Comments explain *why*, not *what* — match the existing density, which is high
and load-bearing. Design tokens come from `packages/ui`'s token object, which generates
the Mantine theme; never invent a token or write a raw colour.

## House rules (RULES seed)

Unlike brink's, this seed is **not** empty — these are earned, most of them verified
empirically in this repo, and all of them are on the wayfinder map
([#2](https://github.com/Syynth/papercut/issues/2)) as standing constraints.

- **Nothing writes the store in an XState transition body; every effect goes through
  `enq`.** A v6 transition body re-runs from the top the moment it calls any `enq` method,
  so statements above the first `enq` call run twice — and an inline effect fires even when
  the transition is not taken. Verified on `6.0.0-alpha.53`. On the document's single write
  path this is silent corruption: a `+3` raise moves a cell by 6, with no error.
- **Address child actors by `ActorRef`, never a string id.** Structural on v6 — `enq.sendTo`
  has no string form. Retain stale child refs rather than nulling them: a send to a stopped
  ref dead-letters and is observable, a send to `undefined` is a silent no-op.
- **Pass the document store by factory closure, never by `input`.** `input` rides on the
  `xstate.init` event and reaches the inspector even when kept out of context — measured at
  100,089 bytes versus 22.
- **Teardown is never in `exit`.** Exit actions do not run when an actor is stopped
  (xstate#4630, by design).
- **The document has one write path and one read path.** Only the actor holds the write
  handle; everyone else sees a deep-readonly view. Never put the document in machine
  context.
- **Command arguments are plain serialisable data addressing targets by stable id** — never
  object references, closures, or ambient selection.
- **No suppressions.** `noInlineConfig` is on. If you need an escape hatch, the primitive is
  missing — say so rather than working around it. Test files and `scripts/` are scoped out
  by config globs; `packages/fixtures` is **not**, because the sample map it generates is
  real data the editor loads.
- **A rule that matters is machine-checked, not documented.** Push each constraint to the
  cheapest bucket that holds it: structural → type-checked → workspace-structural →
  runtime-registration → test → lint → prose. Lint is the residue, not the destination.
- **Never state a number, `file:line`, or symbol you did not just read at the ref you are
  citing.** (Brink's rule, earned there, and it applies to any agent fleet.)
- **A regression test must FAIL without the fix.** Revert the production diff and watch it
  go red before committing.
- **Prove reachability, not just green tests.** Both rendering bugs this repo has ever had
  — degenerate UVs on terrain tops and a double colour-space conversion in the sky — were
  found by looking at screenshots while 53 unit tests passed. `pnpm tour` drives the app
  and captures a walkthrough; use it.
- **Never `git stash`** — all worktrees share one stash stack.
- **When a PR closes an issue or lands a feature, grep for docs that still describe the old
  state as current** — README.md, docs/*.md, and this file's own prerequisite notes — and
  update them in the same PR. Five reviews in one wave found stale docs asserting the
  opposite of what had just shipped (a feature marked as a future prerequisite that the PR
  itself delivered); the pump reads these docs to decide process, so drift here misdirects
  the next agent, not just the next reader.
- **Order gate/CI steps so each step's stated precondition actually holds when it runs** —
  e.g. build the artifact before the lint step whose header comment claims to catch stale
  build output. A step that runs before the thing it inspects exists will stay green even
  after the regression it cites comes back, and no one will notice until it does.
- **Before deleting or narrowing a lint/config rule you believe is redundant with another
  check, prove it with a probe case** — add the exact violation it exists to catch and watch
  each remaining check either catch it or miss it. `no-global-assign` on browser globals in
  TS looked covered by `tsc` and by `no-undef`'s shutoff; a probe file showed neither catches
  it, so deleting the block would have been a silent regression.
- **A PR body may only claim verification you actually performed** — package versions read
  from `node_modules`, hashes computed from a real `corepack` run, screenshots or captures
  attached to the PR. State only what you checked, and never say a file is attached when it
  isn't; a reviewer trusts the body as much as the diff.
- **A turbo task whose script lives outside its package directory (e.g. a repo-root
  `scripts/*.mjs` driving a `packages/*` task) needs that script added to
  `globalDependencies`/`inputs` explicitly.** Turbo's default inputs are only the package's
  own tracked files, so editing the ceiling, glob, or logic in a root-level script leaves the
  task cache-hitting on the old behavior — including in CI, whose restore-keys fall back to
  any prior cache on the same premise. Verify by editing the script and confirming a cache
  miss, not by rerunning with `--force`, which bypasses exactly this.
- **Don't trust a flag, field, or comment's name for what it enforces — mutate the value and
  watch behavior change before writing (or believing) a claim about it.** `engineStrict` reads
  like it gates the Node version; it doesn't. A `rank` field on a placement type read like it
  excluded two kinds `by construction`; nothing ever read it. Both looked load-bearing and
  weren't — the only proof is flipping the value and checking for an effect.
- **When scoping a lint rule or type-check by file glob, verify the glob covers every
  extension the target API can appear in, with a probe file in each.** `rules-of-hooks`
  scoped to `**/*.tsx` let a custom hook (`use*`, no JSX) sitting in a `.ts` file lint clean
  with a real violation inside it — the rule keys on naming, not file type, so restricting to
  the component extension silently drops half its targets.
- **Never describe a not-yet-built consumer, package, or capability in present tense.** State
  it as a plan and link the tracking issue (`#48`, a decision-log line) instead of asserting
  it as shipped — a README claiming "a headless consumer reads the PNGs" when no such
  consumer exists, or an architecture doc naming apps with no source in the decision log,
  sends the next agent looking for code that isn't there.
- **When adding a new branch to a decision function (a validator, a classifier, a placement
  rule), commit a table-driven test that exercises that exact branch.** A `throw` inserted at
  the new branch and reverted before commit is not a regression test — in one PR the whole
  suite stayed green with the new branch replaced by a `throw`, because nothing on disk
  reached it yet.
- **Before opening or merging a PR, rebase onto the current tip of `main` and check for
  conflicts with anything landed since the branch was cut** — a PR that edits the same
  README paragraph or doc section another merged PR just rewrote will merge clean by text but
  silently drop the newer wording.
- **Never derive a filesystem path from `new URL(...).pathname`** — it is percent-encoded, so
  any checkout path with a space, `%`, `#`, or non-ASCII character produces a path that does
  not exist on disk (`pr%2083%20space/...`) and every `readFile` against it fails with
  `ENOENT`. Use `fileURLToPath` (or pass the `URL` straight to an fs API that accepts one)
  instead of reading `.pathname`.
- **A test that builds a package must build into an isolated (e.g. `mkdtemp`) output
  directory, not the package's real `dist/`.** If the task graph doesn't guarantee that
  build happens strictly before that test with no other build running concurrently, two
  writers to the same `dist/` (one with `emptyOutDir: true`) can race and empty the file the
  other is about to spawn.
- **When forwarding flags through a `pnpm run <script> ...` invocation, don't add a literal
  `--` separator** — pnpm passes every token after the script name through verbatim
  (`--` included), so `pnpm foo -- --with-deps` executes the underlying command with a
  literal `-- --with-deps` argument, not `--with-deps`. Drop the `--` unless the underlying
  command itself expects one.
- **A test that asserts a CI step's exact command must match the full invocation, not a
  prefix or substring** — a regex like `/run:\s*pnpm browsers\b/` passes against both the
  correct command and a broken one with extra trailing tokens, so it can't catch the bug it
  exists for. Anchor the match to the complete line.
- **Before writing a WHY comment that names a specific compiler/runtime cause (e.g. "closures
  don't preserve narrowing"), verify the claim with an isolated probe** — one PR's comment
  blamed the wrong mechanism (closures in general, when it was hoisted `function` decls
  specifically that lost narrowing); a plausible-sounding cause is not a verified one.

## Verification: how the human drives it

```
pnpm browsers                              # once, to fetch Playwright's matching Chromium
pnpm --filter @papercut/editor dev      # http://localhost:5173
pnpm tour --gpu                            # 25-step guided walkthrough to shots/tour/
pnpm probe --gpu                           # whether post-processing survives on this GPU
```

`--gpu` is what makes the probe mean anything on this Mac: without it, both scripts force
SwiftShader for CI parity, so a software-renderer fallback firing is not a signal — it's
the default. `--gpu` requests the real backend (ANGLE/Metal here) so the probe reports
whether the fallback is happening for real.

## Reference material for Gate 0

Any feature mirroring an existing tool should study it first. The two primary sources
already in-repo, both from wayfinder research:

- [`docs/research/command-registries.md`](../../../docs/research/command-registries.md) —
  VS Code, Blender, Godot, Unity, Photoshop, Figma.
- [`docs/research/xstate-topology.md`](../../../docs/research/xstate-topology.md) —
  measured against xstate 5.32.6, because several documented answers were wrong.

The vision is [`level-editor-design-brief.md`](../../../level-editor-design-brief.md);
vocabulary is [`CONTEXT.md`](../../../CONTEXT.md) — note `Command` (an intent) versus
`Edit` (an undo entry).

## Ledger

Not set up. Brink uses a standing wave-ledger issue (`LEDGER`); mint one here before the
first wave if wave history is wanted.
