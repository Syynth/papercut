import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The dependency direction is a decision (#3), and pnpm does not enforce it.
 *
 * pnpm's strict `node_modules` stops a package importing something it has not
 * DECLARED, which is real and free. It says nothing about a declaration that
 * points the wrong way: adding `"@papercut/runtime": "workspace:*"` to
 * `packages/document/package.json` resolves cleanly and inverts the graph with
 * no error anywhere. #20 recorded that correction to #3 and asked for a test;
 * this is it. It replaces `scripts/check-boundaries.mjs`, which matched import
 * specifiers with a regex against a `src/{core,runtime,editor}` tree that no
 * longer exists — so it inspected zero files and passed unconditionally.
 *
 * The table below is the SPEC rather than a snapshot: it carries the rungs #3
 * decided for packages nobody has written yet, marked `planned`. Three
 * properties keep it from decaying into an allowlist that admits anything:
 *
 *   - a workspace package with no entry FAILS, so a new package cannot be
 *     silently unchecked — whoever adds it has to place it on the ladder;
 *   - a `planned` entry that now exists on disk FAILS, so a rung assigned
 *     before the package was written has to be confirmed against what it
 *     actually imports;
 *   - a non-`planned` entry missing from disk FAILS, so a renamed or deleted
 *     package cannot leave a stale rule behind.
 */

type Placement =
  | { kind: 'layer'; rank: number; planned?: boolean }
  | { kind: 'side'; rank: number; visibleTo: readonly string[]; planned?: boolean }
  | { kind: 'feature'; planned?: boolean }
  | { kind: 'tooling' }
  | { kind: 'app' }
  | { kind: 'root' }

/** `planned` is spelled on two kinds; this asks the question once. */
function isPlanned(placement: Placement): boolean {
  return 'planned' in placement && placement.planned === true
}

/**
 * `registry <- document <- geometry <- runtime <- viewport <- editor-host`,
 * with `ui` off the side; `viewport-contrib` is a real rung — rank 3, alongside
 * `runtime` — not off to the side (#3, #49).
 *
 * A layer package may depend only on a STRICTLY lower rung. That rule alone
 * does NOT express "off the side": a low rung is reachable from every rung
 * above it, so parking the React+Mantine package at rung 1 would license
 * `runtime` — the package a game embeds — and `viewport` to pull it in, the
 * exact inversion #12 forbids when it asks `viewport` to take chrome colors as
 * numbers "while never depending on `ui`". A side package therefore carries its
 * own kind: `rank` still bounds what it may depend ON, and `visibleTo` names
 * the only things allowed to depend on IT — `'feature'` joined that list in
 * #49, the literal-kind form `'app'` already used, so `ui` need not name every
 * feature package individually.
 *
 * `ui` ranks alongside `document` because it depends on `registry` for
 * declarations and must never reach the document model — the inverted arrow #3
 * used to place the registry at the bottom. `fixtures` needs no such kind: it
 * sits at rung 4 with `viewport`, and being a peer rather than a floor is
 * already what makes it "unreachable from `runtime` or the exporter" as #3
 * requires.
 *
 * #49 settles what #3 left open for `feature-terrain`: a feature sits beside
 * `editor-host`, not under it on the ladder, and neither may import the
 * other — by two separate mechanisms, not a shared rank. `violation`'s
 * `feature` case checks an explicit allow-list (`FEATURE_MAY_DEPEND_ON`)
 * rather than comparing rungs, so it can admit `registry`, `document`,
 * `geometry`, `runtime`, `ui`, and `viewport-contrib` without also admitting
 * `viewport` and `fixtures`, which a plain "strictly lower rung" rule would
 * license and #35 never names. The reverse direction — `editor-host`, or any
 * other layer or side package, reaching a feature — is refused by the
 * layer/side case's own kind-guard, since `feature` is neither `layer` nor
 * `side`; #49 gives that refusal its own branch and message so it doesn't
 * misreport a feature as an app. `feature` therefore carries no `rank` at
 * all: there is nothing left for one to bound.
 */
const PLACEMENT: Record<string, Placement> = {
  'papercut': { kind: 'root' },

  '@papercut/registry': { kind: 'layer', rank: 0 },
  '@papercut/document': { kind: 'layer', rank: 1 },
  // The Aseprite reader, built as if published (decision-log 2026-09-19): it
  // knows nothing of papercut, so it sits at the floor with no workspace
  // dependency at all. Its renderer sits one rung up, over it alone.
  '@papercut/aseprite': { kind: 'layer', rank: 0 },
  '@papercut/aseprite-render': { kind: 'layer', rank: 1 },
  // Where the Aseprite model meets `RgbaImage` and `Grid`: over `document`
  // and the two libraries, under `project`, which reads sheets through it.
  '@papercut/aseprite-sheet': { kind: 'layer', rank: 2 },
  // Visible only to apps, features, and the editor host: the
  // chrome vocabulary is the editor's, not the runtime's. Entries are
  // PLACEMENT keys, except the literals 'app' and 'feature', which stand for
  // any package of that kind.
  '@papercut/ui': { kind: 'side', rank: 1, visibleTo: ['app', 'feature', '@papercut/editor-host'] },
  // The desktop shell's contract with the bundle it hosts: types and one
  // constant, depending on nothing. Off the side for the same reason as `ui` —
  // the shell is the editor's host, and a game embedding `runtime` has no shell
  // to talk to.
  '@papercut/shell-api': { kind: 'side', rank: 0, visibleTo: ['app', 'feature', '@papercut/editor-host'] },
  '@papercut/geometry': { kind: 'layer', rank: 2 },
  '@papercut/runtime': { kind: 'layer', rank: 3 },
  // The project on disk: pure over a filesystem seam, over `document` and `geometry`; the apps open folders through it.
  '@papercut/project': { kind: 'layer', rank: 3 },
  '@papercut/viewport-contrib': { kind: 'layer', rank: 3, planned: true },
  '@papercut/viewport': { kind: 'layer', rank: 4 },
  '@papercut/fixtures': { kind: 'layer', rank: 4 },
  '@papercut/editor-host': { kind: 'layer', rank: 5 },
  // Sits beside editor-host, not under it: see the comment above PLACEMENT
  // for the two mechanisms (an allow-list one way, a kind-guard the other)
  // that keep the two from ever importing each other.
  '@papercut/feature-terrain': { kind: 'feature' },
  '@papercut/feature-sketch': { kind: 'feature' },

  // Tooling describes the system from outside it, so it sits off the ladder
  // entirely rather than at the bottom of it: a rung of 0 would let any layer
  // package depend on the lint rules.
  '@papercut/eslint-rules': { kind: 'tooling' },

  '@papercut/editor': { kind: 'app' },
  '@papercut/export-cli': { kind: 'app' },
  '@papercut/desktop': { kind: 'app' },
}

interface PackageJson {
  name?: unknown
  dependencies?: unknown
  devDependencies?: unknown
  peerDependencies?: unknown
  optionalDependencies?: unknown
  exports?: unknown
}

interface Project {
  name: string
  /** Repo-relative directory, `.` for the root package. */
  dir: string
  /** Declared dependencies on other workspace projects, from all four fields. */
  workspaceDeps: string[]
}

const ROOT = new URL('..', import.meta.url).pathname

function readPackageJson(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as PackageJson
}

function names(field: unknown): string[] {
  return typeof field === 'object' && field !== null ? Object.keys(field) : []
}

/**
 * A runtime import of `foo` can also arrive as a type-only import satisfied by
 * `@types/foo` alone (no runtime package present) — DefinitelyTyped's scoped
 * naming (`@scope/x` -> `@types/scope__x`) is the one irregular part.
 */
function typesTwin(name: string): string {
  const scoped = /^@([^/]+)\/(.+)$/.exec(name)
  return scoped ? `@types/${scoped[1]}__${scoped[2]}` : `@types/${name}`
}

/**
 * The directories `pnpm-workspace.yaml` actually globs, so that adding a third
 * root (`features/*`, say) cannot leave a whole tree of packages unwalked. Only
 * a `<dir>/*` glob is understood; anything else is reported rather than
 * silently skipped, because a shape this cannot read is a shape it cannot check.
 */
function workspaceRoots(): { dirs: string[]; unreadable: string[] } {
  const lines = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8').split('\n')
  const start = lines.findIndex((line) => line.startsWith('packages:'))
  const dirs: string[] = []
  const unreadable: string[] = []
  for (const line of lines.slice(start + 1)) {
    // A non-indented, non-comment, non-blank line is the next top-level key.
    if (/^\S/.test(line) && !line.startsWith('#')) break
    const entry = /^\s+-\s*'?([^'\s]+)'?\s*$/.exec(line)
    if (!entry) continue
    const glob = /^([\w.-]+)\/\*$/.exec(entry[1])
    if (glob) dirs.push(glob[1])
    else unreadable.push(entry[1])
  }
  return { dirs, unreadable }
}

function discover(): Project[] {
  const dirs = ['.']
  for (const root of workspaceRoots().dirs) {
    if (!existsSync(join(ROOT, root))) continue
    for (const entry of readdirSync(join(ROOT, root)).sort()) {
      const dir = `${root}/${entry}`
      if (!statSync(join(ROOT, dir)).isDirectory()) continue
      if (existsSync(join(ROOT, dir, 'package.json'))) dirs.push(dir)
    }
  }

  return dirs.map((dir) => {
    const pkg = readPackageJson(dir)
    const declared = [
      ...names(pkg.dependencies),
      ...names(pkg.devDependencies),
      ...names(pkg.peerDependencies),
      ...names(pkg.optionalDependencies),
    ]
    return {
      name: typeof pkg.name === 'string' ? pkg.name : `<unnamed: ${dir}>`,
      dir,
      // A devDependency makes an import resolve exactly as a dependency does,
      // so an inversion hidden in a test's imports is still an inversion. The
      // same goes for an optionalDependency: pnpm links it into
      // `node_modules` and `require.resolve` finds it like any other.
      workspaceDeps: [...new Set(declared.filter((name) => name in PLACEMENT))].sort(),
    }
  })
}

/**
 * #35's list for what a feature may depend on — see the comment above
 * PLACEMENT for why this is an allow-list rather than rank arithmetic.
 * Deliberately excludes `editor-host` and every `feature` (simply by not
 * naming them here) and `viewport` / `fixtures` (rank 4, reachable under a
 * plain "strictly lower rung" rule, but never named by #35).
 */
const FEATURE_MAY_DEPEND_ON = new Set([
  '@papercut/registry',
  '@papercut/document',
  '@papercut/geometry',
  '@papercut/runtime',
  '@papercut/ui',
  '@papercut/viewport-contrib',
])

/** The reason `from` may not declare `to`, or null when the arrow is legal. */
function violation(from: string, to: string): string | null {
  const a = PLACEMENT[from]
  const b = PLACEMENT[to]
  // An unplaced package is reported by the completeness test instead; saying it
  // twice would bury the one message that tells the author what to do.
  if (!a || !b) return null

  if (b.kind === 'root') return `${from} depends on the repo root package`

  // A side package is not a floor under the ladder, so reaching it is a
  // question of who is allowed to see it, asked before any rung arithmetic.
  if (b.kind === 'side' && !b.visibleTo.includes(from) && !b.visibleTo.includes(a.kind))
    return `${from} may not depend on ${to}: it is off the side of the ladder, visible only to ${b.visibleTo.join(', ')}`

  switch (a.kind) {
    case 'root':
      return null
    case 'tooling':
      return b.kind === 'tooling'
        ? null
        : `${from} is tooling and may not depend on ${to} (${b.kind}): the rule set describes the system from outside it`
    case 'app':
      return b.kind === 'app'
        ? `${from} is an app and may not depend on another app (${to}): apps are leaves`
        : null
    // What a package may depend ON is the same question for both kinds: a side
    // package is placed off the side for its consumers, not for its own imports.
    case 'layer':
    case 'side':
      // A feature is not an app, so the generic "arrow from apps to packages
      // points one way" message below would misname it. #35's rule for this
      // direction is its own: the host never imports a feature — an app is
      // the only thing that composes a feature into anything.
      if (b.kind === 'feature')
        return `${from} is a package and may not depend on ${to} (feature): #35 rules that the host never imports a feature — only an app composes them together`
      if (b.kind !== 'layer' && b.kind !== 'side')
        return `${from} is a package and may not depend on ${to} (${b.kind}): the arrow from apps to packages points one way`
      return b.rank < a.rank
        ? null
        : `${from} (rung ${a.rank}) may not depend on ${to} (rung ${b.rank}): a package may depend only on a strictly lower rung`
    // No rank comparison for a feature target: a feature sits beside
    // editor-host, off the ladder, so there is no rung to compare against.
    // The `feature` case below checks FEATURE_MAY_DEPEND_ON instead, which
    // admits `registry`/`document`/`geometry`/`runtime`/`ui`/
    // `viewport-contrib` without also admitting `viewport`/`fixtures` — the
    // "strictly lower rung" rule just above would license both, and #35
    // never names them.
    case 'feature':
      return FEATURE_MAY_DEPEND_ON.has(to)
        ? null
        : `${from} is a feature and may not depend on ${to}: a feature may depend only on registry, document, geometry, runtime, ui, or viewport-contrib`
  }
}

/**
 * Every way `exports` fails to name one explicit file, as messages.
 *
 * #20's second gap: pnpm's strict node_modules stops an UNDECLARED import,
 * but says nothing about a declared entry point that is itself a wildcard. A
 * `"./*"` or `"./src/*"` subpath (or a missing `exports` field, which lets
 * Node fall back to the package root) reopens the deep import #3 closed, so
 * every key has to name one explicit file.
 *
 * A string-valued `exports` (`"./src/index.ts"`) is Node's shorthand for
 * `{ ".": "./src/index.ts" }` — one fixed file, with no key for a `*` to vary
 * against — so it is exactly as explicit as the object form and is accepted
 * the same way; a literal `*` inside that string still reopens the deep
 * import, so it is still caught.
 *
 * RECURSIVE since #46, which made an entry point a condition object rather
 * than a string: `development` (source, what Vite and vitest resolve),
 * `types` (`./dist/*.d.ts`) and `default` (`./dist/*.js`). The previous
 * implementation inspected string values exactly one level down, so a
 * wildcard inside a condition object was "not a string" and read as no
 * violation at all — see the table-driven test below, which fails against it.
 *
 * A `*` in a CONDITION name is reported too. No real condition contains one,
 * so the only thing that reaches that branch is a subpath key nested where a
 * condition belongs, which is a wildcard by another spelling.
 */
function exportsProblems(exports: unknown, at = 'exports'): string[] {
  if (typeof exports === 'string')
    return exports.includes('*')
      ? [`${at} is "${exports}", a wildcard, which lets a consumer reach any file by path instead of the declared entry point`]
      : []
  if (typeof exports !== 'object' || exports === null || Array.isArray(exports))
    return [`${at} is not an entry-point map, so a consumer can reach any file by path`]
  return Object.entries(exports as Record<string, unknown>).flatMap(([key, value]) =>
    key.includes('*')
      ? [`${at}["${key}"] is a wildcard, which lets a consumer reach any file under it by path instead of the declared entry point`]
      : exportsProblems(value, `${at}["${key}"]`),
  )
}

const projects = discover()
const placed = Object.entries(PLACEMENT)

describe('workspace dependency direction', () => {
  it('reads every directory the workspace globs', () => {
    expect(workspaceRoots().unreadable).toEqual([])
    expect(workspaceRoots().dirs.length).toBeGreaterThan(0)
  })

  it('places every workspace package on the ladder', () => {
    const unplaced = projects
      .filter((project) => !(project.name in PLACEMENT))
      .map(
        (project) =>
          `${project.dir} declares "${project.name}", which has no entry in PLACEMENT: give it a rung (or a kind) in tests/dependency-direction.test.ts`,
      )
    expect(unplaced).toEqual([])
  })

  it('keeps the ladder honest about what exists', () => {
    const found = new Set(projects.map((project) => project.name))
    const stale = placed.flatMap(([name, placement]) => {
      const planned = isPlanned(placement)
      if (planned && found.has(name))
        return [`${name} now exists: drop its \`planned\` flag and confirm the rung it was assigned`]
      if (!planned && !found.has(name))
        return [`${name} is placed but no workspace package declares that name`]
      return []
    })
    expect(stale).toEqual([])
  })

  // #79: `visibleTo` has the same unvalidated parallel-list shape
  // `FEATURE_MAY_DEPEND_ON` had before the "on both sides of the line" test
  // below started checking every one of its entries against PLACEMENT — a
  // renamed or removed key (`editor-host`, say) would leave a stale string
  // here that `violation`'s own early `if (!a || !b) return null` treats as a
  // silent non-match rather than a failure. The literal kinds ('app',
  // 'feature') stand for any package of that kind, per the comment above
  // PLACEMENT, and are not PLACEMENT keys themselves, so they're allowed
  // alongside real ones.
  it('keeps every visibleTo entry pointing at a real PLACEMENT key or kind literal', () => {
    const knownKindLiterals = new Set(['app', 'feature'])
    const stale = placed.flatMap(([name, placement]) =>
      placement.kind === 'side'
        ? placement.visibleTo
            .filter((entry) => !knownKindLiterals.has(entry) && !(entry in PLACEMENT))
            .map(
              (entry) =>
                `${name}.visibleTo contains "${entry}", which is neither a PLACEMENT key nor a known kind literal (${[...knownKindLiterals].join(', ')})`,
            )
        : [],
    )
    expect(stale).toEqual([])
  })

  it('has no declared dependency pointing the wrong way', () => {
    const violations = projects.flatMap((project) =>
      project.workspaceDeps.flatMap((dep) => {
        const reason = violation(project.name, dep)
        return reason === null ? [] : [`${project.dir}/package.json: ${reason}`]
      }),
    )
    expect(violations).toEqual([])
  })

  // Table-driven against `violation` itself, not the workspace on disk: the
  // review that asked for this pointed out that `throw`ing inside
  // `case 'feature':` still left every test above green, since nothing on
  // disk is a feature or depends on one yet — the `planned` assertion two
  // tests up guarantees that. These cases exercise both directions (a
  // feature reaching out, and something reaching in) without waiting for a
  // second feature package to exist.
  it('keeps a feature package on both sides of the line #35 drew', () => {
    const FEATURE = '@papercut/feature-terrain'

    // Off the allow-list: two rungs a plain "strictly lower rung" rule would
    // admit (`viewport`, `fixtures`), the peer it may never reach
    // (`editor-host`, and a feature reaching a feature — there being only
    // one on disk, `FEATURE` stands in for both), and an app, which is not
    // reachable by any package.
    for (const to of ['@papercut/viewport', '@papercut/fixtures', '@papercut/editor-host', FEATURE, '@papercut/editor'])
      expect(violation(FEATURE, to), `${FEATURE} -> ${to}`).not.toBeNull()

    // On the allow-list: every one of these must be legal, or the feature
    // package this PR unblocks can't actually import what #35 promised it.
    for (const to of FEATURE_MAY_DEPEND_ON) expect(violation(FEATURE, to), `${FEATURE} -> ${to}`).toBeNull()

    // The reverse arrow: a package reaching INTO a feature, refused by its
    // own branch rather than falling through to the generic "arrow from apps
    // to packages points one way" message, which would misname a feature as
    // an app.
    expect(violation('@papercut/editor-host', FEATURE)).toContain('#35')
    expect(violation('@papercut/ui', FEATURE)).toContain('#35')
    expect(violation('@papercut/editor-host', FEATURE)).not.toContain('the arrow from apps to packages points one way')

    // `violation` treats an unplaced package as a non-match (see the early
    // `if (!a || !b) return null`), so a name in the allow-list that a rename
    // left stale would silently stop mattering instead of failing loudly.
    for (const name of FEATURE_MAY_DEPEND_ON) expect(name in PLACEMENT, name).toBe(true)
  })

  it('keeps runtime libraries off the root', () => {
    // A package's `dependencies` field is the one that says "my shipped
    // source imports this"; `devDependencies` covers private tooling
    // (typescript, vitest, eslint...) that the code it type-checks or tests
    // never imports. `peerDependencies` counts too — a package that expects
    // its consumer to supply a library (`ui`'s `react`, say) still imports
    // it, it just doesn't install it — so a name only under `peerDependencies`
    // is exactly as live an import target as one under `dependencies`. Only
    // `tooling`-kind packages are exempt: `eslint-rules`' `eslint` peer names
    // the linter it plugs into, not something its own source imports, and the
    // root legitimately carries that same name as a devDependency.
    //
    // Every runtime library also stands for its `@types/` twin: a type-only
    // `import type … from 'three'` resolves against `@types/three` alone,
    // with no runtime `three` in sight, so a root `@types/three` re-hoists
    // exactly like a root `three` would — the gap `8b6b80d` didn't close,
    // since it only ever named the runtime packages, not their types.
    const runtimeLibraries = new Set(
      projects
        .filter((project) => project.dir !== '.' && PLACEMENT[project.name]?.kind !== 'tooling')
        .flatMap((project) => {
          const pkg = readPackageJson(project.dir)
          return [...names(pkg.dependencies), ...names(pkg.peerDependencies)]
        })
        .filter((name) => !(name in PLACEMENT)),
    )
    for (const name of [...runtimeLibraries]) runtimeLibraries.add(typesTwin(name))

    const rootPkg = readPackageJson('.')
    const rootNames = [
      ...names(rootPkg.dependencies),
      ...names(rootPkg.devDependencies),
      ...names(rootPkg.peerDependencies),
      ...names(rootPkg.optionalDependencies),
    ]
    const violations = [...new Set(rootNames)]
      .filter((name) => runtimeLibraries.has(name))
      .sort()
      .map(
        (name) =>
          `package.json: root declares "${name}", which a workspace package also declares under "dependencies" (or its "@types/" twin) — remove it from the root; a root copy re-hoists into node_modules and lets any package import it without declaring it`,
      )
    expect(violations).toEqual([])
  })

  it("keeps every package's exports map explicit", () => {
    const violations = projects
      .filter((project) => project.dir !== '.')
      .flatMap((project) =>
        exportsProblems(readPackageJson(project.dir).exports).map((problem) => `${project.dir}/package.json: ${problem}`),
      )
    expect(violations).toEqual([])
  })

  // Table-driven against `exportsProblems` itself, for the reason the feature
  // test above gives: no `package.json` on disk contains a wildcard, so the
  // assertion above passes just as happily against a check that has stopped
  // looking. These cases are the proof it has not — the fourth and fifth are
  // the ones the pre-#46 implementation let through.
  it('still catches a wildcard wherever #46 moved it', () => {
    expect(exportsProblems(undefined), 'no exports field at all').not.toEqual([])
    expect(exportsProblems('./src/*.ts'), 'string-valued wildcard').not.toEqual([])
    expect(exportsProblems({ './*': './src/index.ts' }), 'wildcard subpath key').not.toEqual([])

    // The shape #46 introduced. Every consumer that resolves the
    // `development` condition — Vite's dev server and vitest — reaches this
    // one, and the old check saw a non-string value one level down and
    // reported nothing.
    const conditions = { development: './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' }
    expect(exportsProblems({ '.': { ...conditions, development: './src/*.ts' } }), 'wildcard in development').not.toEqual([])
    expect(exportsProblems({ '.': { ...conditions, default: './dist/*.js' } }), 'wildcard in default').not.toEqual([])

    // ...and the real shape must still read as clean, or the check above is
    // just failing everything.
    expect(exportsProblems({ '.': conditions, './package.json': './package.json' })).toEqual([])
  })

  it('has an acyclic workspace graph', () => {
    const edges = new Map(projects.map((project) => [project.name, project.workspaceDeps]))
    const state = new Map<string, 'visiting' | 'done'>()
    const cycles: string[] = []

    const walk = (name: string, path: string[]): void => {
      if (state.get(name) === 'done') return
      if (state.get(name) === 'visiting') {
        cycles.push([...path.slice(path.indexOf(name)), name].join(' -> '))
        return
      }
      state.set(name, 'visiting')
      for (const dep of edges.get(name) ?? []) walk(dep, [...path, name])
      state.set(name, 'done')
    }

    for (const project of projects) walk(project.name, [])
    expect(cycles).toEqual([])
  })
})
