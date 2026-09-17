# Decision log

Decisions made during development, captured as they happen so the reasoning
behind them is not lost. This is a data-capture mechanism, not a findings file:
entries record what was decided and why, at the moment it was decided.

Each entry:

```
## <short description>
- **WHEN:** <date, YYYY-MM-DD>
- **PROJECT:** <project/repo name>
- **SYSTEM:** <short tag — e.g., "editor-ui", "sidecar", "asset-pipeline", "cross-system", or a spec name>
- **SCOPE:** <interpreted scope — e.g., "minor/local", "moderate", "architectural">
- **WHAT:** <what was decided>
- **WHY:** <the rationale — this is the most important field>
```

`- **STATUS:** tentative` after SCOPE marks a decision the author expects may change.

---

## Camera orbit follows DCC modifier conventions
- **WHEN:** 2026-09-10
- **PROJECT:** papercut
- **SYSTEM:** editor-ui
- **SCOPE:** minor/local
- **WHAT:** Option/Alt+drag orbits the viewport camera, matching Maya/Unity. Eyedropper stays on Option+click, disambiguated from orbit by a small drag threshold. Right-drag pans, scroll/pinch zooms. Middle-drag orbit is kept as a secondary binding.
- **WHY:** The editor is developed on a MacBook trackpad, which has no middle button, so middle-drag orbit is unreachable in normal use. The previous trackpad fallback (Option+Shift+drag) was undiscoverable and contradicted its own code comment. Aligning with Maya/Unity means anyone arriving from a 3D tool already knows the gesture, so the binding does not have to be taught.

## Monorepo layout, toolchain, and publishing posture
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** The prototype is promoted to a pnpm + Turborepo monorepo: `packages/core`, `packages/runtime`, `packages/exporter`, `apps/editor`, with `apps/desktop` reserved for the undecided Electron/Tauri shell. The extras spec and its JSON Schema stay inside `core` until a third party implements it standalone. `packages/runtime` is built as a properly consumable package but stays private; publishing machinery waits for an outside consumer.
- **WHY:** Three independent consumers now justify real packages rather than the advisory `check-boundaries.mjs` script — a runtime game devs install, a headless exporter CLI needing core without a browser, and a desktop shell that is a separate build target. pnpm's strict `node_modules` makes the `core <- runtime <- editor` layering structural: core cannot import three.js if it is not a declared dependency, replacing a custom script with resolution failure. Turborepo is adopted up front rather than deferred so orchestration is configured once against the final shape instead of retrofitted. Keeping runtime private avoids committing to semver before anyone outside the repo depends on it, while still building it as if it will be published.
- **STATUS:** layout superseded 2026-09-11 by [#3](https://github.com/Syynth/papercut/issues/3) — `packages/core` and `packages/exporter` were both dropped; the shipped layout is `document`, `geometry`, `runtime`, `fixtures`, `ui`, `viewport`, `eslint-rules` and `apps/editor`. Toolchain and publishing posture stand.

## Restructure into packages before adding CI and lint tooling
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** The monorepo split happens first; CI, linting, formatting, and git hooks are configured afterwards, against the final package layout.
- **WHY:** The codebase is small enough (~8.4k lines across three already-separated layers) to hold in one head, so the move is cheapest now and only gets harder as the code grows. Configuring lint, CI, and hooks against the current single-package layout would mean configuring all of it twice. The safety net during the move is the existing 53 tests and typecheck run locally — the gate exists, it is simply not yet automated.

## Mantine as the UI component library
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** editor-ui
- **SCOPE:** moderate
- **WHAT:** Mantine is adopted as the editor's component library, replacing the eight hand-rolled primitives in `src/editor/ui.tsx`. The CSS custom properties in `styles.css` are mapped onto a Mantine theme rather than kept as a parallel token system. `@mantine/form` is the form layer for engine-defined custom types.
- **WHY:** Mantine ships near-exact equivalents of the primitives already hand-rolled for the dense inspector — `NumberInput`, `Slider`, `ColorInput`, `Select` — plus the accessibility-heavy overlay components (menus, dialogs, tooltips, popovers) the editor does not have yet and would otherwise have to build itself. It also supplies a real form layer, which matters because brief §13 makes forms generated from engine-defined JSON Schema a firm requirement rather than a nice-to-have. Writing and owning less of this code is worth more than full control over the look.

## XState actors as the editor's control-flow model
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** Editor state, tool state, panel state and async work are all modelled as communicating XState actors. The document store (`core/store.ts`) is the one deliberate exception and keeps its mutable-plus-revision model: machines own control flow and tell the store to apply commands, but never hold the map in machine context. Per-frame viewport telemetry also stays out of machines.
- **WHY:** Several forces point the same way. The editor is already full of implicit state machines written as unions plus scattered conditionals — `Viewport.dragging` is the clearest case, and extending it by hand produced a play-mode inconsistency on the first attempt. Statecharts make those transitions declarative and testable without a browser. As the brief's remaining tools arrive (buildings, blocks, prefabs, fences, engine-defined types), every tool having the same actor shape means the shared framework emerges uniformly rather than being refactored into existence later. Async work — worker meshing, file I/O, export, autosave — needs cancellation, progress and failure handling, which is what the actor model is built for and which is painful to bolt on afterwards. Beyond those, this is the author's default from experience, and coding agents operate more reliably against explicit statecharts than against ad-hoc state scattered through handlers.

## The document has one write path and one read path, both mechanically enforced
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** All document mutation goes through the XState actor, which is the sole holder of a write handle. `createDocumentStore()` returns a reader and a writer; only the machine receives the writer, and once `core` is its own package the writer is not part of its public exports. Consumers see the document as a deep-readonly type, so any direct write is a compile error. Reads go through a single `useDocument(selector)` hook that subscribes to the revision counter internally. The document itself stays mutable behind the store and never enters machine context.
- **WHY:** Consistency has to be enforced by the toolchain rather than by convention, because coding agents do not reliably follow prose rules but do respond immediately to a failing typecheck. The current design is honoured only by discipline: `store.doc` is public and mutable and is read 44 times across the editor, so nothing prevents the next read becoming a write. A deep-readonly view was verified to reject every write shape (indexed assignment, record assignment, array mutation, property replacement) while leaving reads untouched. A single read hook closes the matching hazard on the read side: derived state keyed on `doc` never recomputes because `doc` never changes identity, which already shipped one bug in the coverage readout, and reading the document without subscribing to the revision silently fails to re-render.

## Editor architecture decisions move onto wayfinder maps
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** The architecture decisions taken while charting the editor refactor are recorded on the wayfinder map [Map: the editor's behavior on actors and commands](https://github.com/Syynth/papercut/issues/2) and its child tickets, rather than being restated as entries here. This log links to the map instead. Decisions taken outside a charted effort continue to be captured here in full.
- **WHY:** A wayfinder ticket holds the question, the alternatives that were weighed, and the reasoning that produced the answer. Transcribing that into a two-line WHY written after the fact is lossy duplication of the better record. Settled while charting: `Command` names the intent layer and the existing undo entry is renamed `Edit`; commands ride with the actors that handle them across several packages, dispatched through a single root-actor entry point; package boundaries from `monorepo-migration.md` are re-opened because the command layer, the UI package and extensibility all bear on them; UI primitives live in `packages/ui`, the only package depending on Mantine, with a lint rule forbidding CSS and inline styles elsewhere; extensibility is a standing constraint on every boundary decision rather than a deliverable of this effort.

## Prototype decisions taken up front
- **WHEN:** 2026-09-10 *(migrated from `PLAN.md` on 2026-09-11 when that file was retired)*
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** The expensive-to-reverse choices were made before the prototype started, and everything else was deliberately left open.

  | Decision | Choice | Where |
  |---|---|---|
  | Document model | Normalised, serializable, mutated in place behind a revision counter | `core/document.ts`, `core/store.ts` |
  | Undo | Patches with an automatically derived inverse; tools never write `undo()` | `core/edits.ts` |
  | Paint addressing | Stable grid coordinates; cliff faces keyed by **absolute half-tile level** | `core/paint.ts` |
  | Height units | Integer half-tiles (`height: 3` is 1.5 tiles) | `core/document.ts` |
  | World scale | One tile is one world unit, always; texel density is texture detail only | `core/document.ts` |
  | File format | Versioned JSON, single file, migrations from v0 | `core/io.ts` |

- **WHY:** These are the decisions that are cheap now and expensive later, so they were worth making blind rather than discovering. Two have since proved themselves in measurement rather than argument. Mutation-plus-revision exists because a brush stroke writes cells sixty times a second and deep-cloning parallel arrays of tens of thousands of entries per tick is the wrong cost to pay for reference equality. Keying cliff paint by absolute half-tile level — rather than by a row counted from the top, or a row of a swept profile — is the entire mechanism behind "paint survives sculpt", which needed no cleanup code at all, and it is also what makes the brief's section 5 profile strip a cheap change rather than a data migration.

## Decisions deliberately deferred during the prototype
- **WHEN:** 2026-09-10 *(migrated from `PLAN.md` on 2026-09-11 when that file was retired)*
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** Four choices were consciously left open rather than guessed at. **Electron vs Tauri** — the prototype stayed a plain Vite web app, which keeps HMR and defers the choice until there is a heavy scene to smoke-test both with. **Meshing in a worker** — not done; benchmarked instead. **WebGL2 vs WebGPU** — WebGL2, since nothing in the slice needs compute. **Terrain as a voxel view** (brief §7) — closed as "no, not now"; terrain stays a heightfield. Relatedly, the tool layer was left as a switch statement over three tools rather than a plugin API.
- **WHY:** Each deferral was cheap to hold open and expensive to get wrong. The mesher is a pure function with no three.js import, so moving it into a worker stays a wiring change rather than a rewrite — and the benchmark said it is not needed: a brush tick costs about 1 ms once neighbour dirtying is restricted to cells actually on a chunk border, against 6.9 ms for the naive 3x3 neighbourhood. Coupling the heightfield to a voxel grid without evidence is an expensive decision made blind, and blocks are not in the slice. The tool layer stayed concrete for the same reason the rest did: brief section 4's generality waits until a second template kind exists to generalise from, because a plugin API invented before its second consumer is an API designed against one example.
- **STATUS:** Electron vs Tauri settled 2026-09-13 — Electron, see "The desktop shell is Electron" below. The other three deferrals stand.

## Tests and scripts are exempt from the custom lint rules
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** Test files and `scripts/` are exempt from every custom lint rule, scoped out by flat-config `files:` globs. `packages/fixtures` is **not** exempt. This amends [#20](https://github.com/Syynth/papercut/issues/20), which had decided no escape hatches beyond `packages/ui`. `noInlineConfig` is unchanged: there are still no inline suppressions anywhere, and an exemption remains a path glob in a config file rather than a comment in source. Detail and consequences on that ticket.
- **WHY:** Because #20 removed inline suppressions, code that must violate a rule has no recourse at all — it cannot be written. That bites first in the least avoidable place: the test asserting a rule actually fires needs a violating fixture by construction. A blanket exemption was chosen over a per-rule judgement so the boundary is a path, not an argument to be relitigated in every rule's ticket. `packages/fixtures` was initially included and then pulled back out: it is described as dev-only, but the sample map and procedural textures it generates are loaded by the real editor, so its output has to satisfy the same invariants as anything else. The line that survives is that tests and scripts describe or drive the system from outside it, while fixtures produces data that flows into it.

## The brief's "hardcode first" guidance is superseded: the prototype is done and this is the foundation
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** The brief's "Read this first" guidance — don't build plugin APIs, generic tool frameworks, or extensible registries until two or three concrete cases need them; hardcode first, extract later — is retired for this project. Abstractions that make agent-written code reliable and checkable are justified before a second human consumer exists, including extension surfaces. The map's direction stands: actors all the way up, an enumerable command layer, enforced package boundaries, and the feature-module registry as a deliverable ([#9](https://github.com/Syynth/papercut/issues/9), [#21](https://github.com/Syynth/papercut/issues/21)). The brief's principle that the artist is the primary user and "friendly wins" is **not** retired; only its guidance on when to abstract is. Recorded in response to [`docs/audit-2026-09-11.md`](audit-2026-09-11.md) §1.
- **WHY:** The brief was written for the exploratory prototype — its own status line says so — and "hardcode first" was the right rule for that phase: build the smallest thing that teaches something, then stop and show it. The prototype is done and has answered what it was built to answer (`FINDINGS.md`). What is being built now is the real foundation for the actual work, and the rule for a foundation is not the rule for a probe. Alongside that: most of this codebase will be written by coding agents, and agents operate reliably against explicit statecharts, declared seams and mechanically enforced boundaries, and unreliably against ad-hoc state and prose rules — so the abstractions the brief deferred are what makes agent output trustworthy at all, and deferring them costs more in review and rework than building them costs up front. The brief's warning was about human cognitive cost, and that does not carry over. It is also the author's established default across projects.

## No native binary dependencies for tooling; the export CLI is cut rather than carry one
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** `@napi-rs/canvas` is removed and `apps/export-cli` with it. The headless glTF exporter needed a 2D canvas — both the procedural texture generator and three's `GLTFExporter` draw through one — and no canvas-free path exists yet. The runtime's `./export` subpath stays; it works in the editor, which has a real canvas. The CLI returns once export has a canvas-free texture path (raw RGBA crossing the boundary, the reshape #3 costed out), which is now the prerequisite for both the CLI and for moving `textures.ts` into `packages/fixtures`.
- **WHY:** The owner's words: *"definitely get rid of it, if there's not a good replacement, the cli can just be cut for now."* A native binary in a dev CLI is not worth its install and CI cost while the CLI is not load-bearing, and shimming a DOM into node so browser code can run is the wrong direction — the right fix is a texture path that never needed a canvas, and that is a design decision, not a dependency swap.

## Four rulings on the restructure's follow-up decisions (#33, #37, #38, #39)
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** Recorded on the wayfinder map's tickets, which hold the reasoning: [#38](https://github.com/Syynth/papercut/issues/38) tests are exempt from all lint; [#39](https://github.com/Syynth/papercut/issues/39) `minimumReleaseAgeStrict` on and CI never caches lockfile verification; [#37](https://github.com/Syynth/papercut/issues/37) `rules-of-hooks` now, `exhaustive-deps` with the actor migration; [#33](https://github.com/Syynth/papercut/issues/33) emit `.d.ts` and use project references.
- **WHY:** Three followed the recommendation. #33 went against it — no emit was recommended because nothing consumes built output — on the strength of the standing "private for now, built as if publishable" posture: a package that only resolves as bundler-read source is not built as if publishable, and retrofitting emit later across seven packages is the drift the restructure exists to prevent.

## Four architectural rulings: feature placement, the texture boundary, package surfaces, sheet.ts (#35, #32, #34, #36)
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** Recorded on the map's tickets, which hold the alternatives and reasoning. [#35](https://github.com/Syynth/papercut/issues/35): features sit beside the host, both on the registry, only apps import features, and the registry holds the tool/stroke contract types. [#32](https://github.com/Syynth/papercut/issues/32): raw RGBA is the texture crossing type, `runtime` never touches a canvas, and export takes an injected PNG encoder — no native code. [#34](https://github.com/Syynth/papercut/issues/34): a barrel exports what has an outside consumer plus the types to name it; `runtime` narrows now, `document` with the document actor. [#36](https://github.com/Syynth/papercut/issues/36): `sheet.ts` stays in `apps/editor` as the file-I/O edge until the file-I/O abstraction owns it.
- **WHY:** All three followed the recommendation. #35 is the VS Code shape — extensions and workbench never import each other — and is what makes "replaceable from outside the tree" true by construction. #32 is what lets `fixtures` complete, gives "no canvas in runtime" a compiler check, and revives the headless exporter without the native dependency that got it cut. #34 keeps the write machinery from becoming a permanent public surface by accident of a move.

## No pixel baselines yet: CI asserts structural signals and keeps screenshots as artifacts (#60)
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** ci
- **SCOPE:** moderate
- **WHAT:** Recorded on [#60](https://github.com/Syynth/papercut/issues/60). The tour runs in CI and fails on what a machine judges reliably — console errors, a frame below a luminance floor, status-bar values, mesh and triangle counts — and uploads its screenshots as workflow artifacts for the human gate. No checked-in pixel baselines and no orphan baselines branch. Revisit pixel diffing when a stable GPU runner exists.
- **WHY:** Both rendering bugs this project has had were caught by a human looking at screenshots, not by a pixel diff, and CI renders through SwiftShader, where GL output is not stable enough across runs for a diff without perpetual tolerance-tuning. A luminance floor catches the one class a machine can name — the black frame — without pretending to judge the rest.

## Four map tickets closed with tentative defaults so building can start (#10, #14, #22, #23)
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **STATUS:** tentative
- **WHAT:** The last four open decision tickets on the map — verification strategy (#10), the keymap registry (#14), the `enq`-purity rule (#22), and the command argument schema (#23) — are closed with the dispatcher's recommended answers recorded as defaults. Each ticket holds its default and the reasoning. The map's route is clear and the actor migration is filed as the build handoff.
- **WHY:** The owner's words: *"this is all dumb, i just want to switch to building the app."* After eight rulings in one sitting, a further six-question round on #10 was the wrong ratio of deciding to building. Recording explicit defaults is strictly better than building against implicit ones: every default is visible, attributed to the agent rather than the owner, and reversible by reopening the ticket. The defaults are not guesses — each follows from research already on the map (#4, #5, the Standard Schema and v6 measurements) and from rulings already made (#13, #35).

## Wayfinding is retired; finish the refactor on the pump, then build features together
- **WHEN:** 2026-09-11
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** No more wayfinder maps or decision tickets. The refactor — the actor migration (#66), emit and references (#46), and the tail (#48, #56) — is finished on the autonomous pump with adversarial review and the protected `main`. After that, feature work is the owner and the assistant building directly, in conversation, with no orchestration ceremony. The decision log stays.
- **WHY:** The owner's words: *"i tried the wayfinding thing, i have decided i hate it, and i just want to finish the refactor so we can make the editor good"* and *"once the refactor is done, i want to switch to just you and i building features together."* The map did its job — the architecture is decided and recorded — and the cost of continuing to run every question through it exceeded its value once the decisions were made. The refactor still benefits from the pump's review loop because it is large, mechanical, and dangerous to get wrong; feature work does not.

## Pump agents run on Opus, not Fable, unless the work is genuinely critical
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** minor/local
- **WHAT:** Adversarial review and known-hard builds run on Opus; ordinary builds, the merge train, fixes, lessons and retro on Sonnet; the light lane on Haiku. Fable is reserved for work the owner judges critical — the actor migration was; nothing after it is by default.
- **WHY:** The owner's words: *"maybe stick to opus instead of fable unless it's really critical."* Credit control: the review tier is the quality bar and needs a strong model, but the top tier on every review across every wave is spend the outcome does not need.


## App frame: rail of subjects, Select first, per-tool context bar
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** editor-ui
- **SCOPE:** architectural
- **WHAT:** The frame is: a left rail of *subject* tools (Select, Terrain, Objects, Buildings, Fences; Level settings behind a gear at the bottom); a context bar showing the active tool's mode switch first, then its verbs with keys, then parameters, with each tool remembering its own settings; a stacked collapsible inspector; a status bar of hints. Select is the first tool and Esc returns to it; it is one polymorphic tool over voxel regions and objects (shape: marquee/lasso/brush; combine: replace/add/subtract; region verbs: move, expand, contract, invert). Camera is gestures in every tool, not a rail item. New terrain types, object kinds and styles are entries in the level's library, added from each subject's inspector section, not verbs. A slicer-style layer-view range (upper and lower bound) sits on the right edge of the viewport. Keys are a default preset in the keymap; other conventions are alternate binding lists.
- **WHY:** Voxel regions are an underlying concept, so selection must be a region editor (expand, contract, move), not a click-an-object affordance. Subject tools match the brief's firm requirement for curated, named tools and the conventions of every reference art app the artist already knows; mode-first context bars keep each subject's verbs discoverable. Art apps differ in shortcuts, so the layout is a preset and the door stays open for Blender-like/Aseprite-like sets. The layer view lets the artist dial in on a single height the way slicers do. Mockup: `docs/design/select-first.html`.

## Tool and verb buttons are icon-only; label and key live in the tooltip
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** editor-ui
- **SCOPE:** moderate
- **WHAT:** Every button in the rail and the bars is icon-only by default — tools, verbs, top-bar actions, mode switches, shape and combine rules, and library chips (materials, catalog entries, styles). The label and the keyboard shortcut are shown in a tooltip on hover or focus, never inline. Only readouts (a size) and menus that display a chosen value (a keymap preset) keep words. A preference ("Icons only" / "Icons + labels") turns inline labels on for those who want them; the default stays icon-only. (Amended the same day: the first draft exempted modes and chips; the owner's instruction was all of them.)
- **WHY:** Icon-only bars keep the context bar dense enough that a tool's whole verb set fits without scrolling, matching the convention of the art apps the artist already uses; the tooltip carries the discoverability (name + key) without spending bar width on it.

## UI overhaul first; selection and viewport plumbing follow it
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** editor-ui
- **SCOPE:** moderate
- **WHAT:** Build the new frame (rail, context bar, stacked inspector, status hints, layer-view slider) first, on top of PR #96 and against the host as it stands: Select drives the existing object tool, region verbs are greyed by `when` predicates, the layer slider ships as UI. Typed region selection on the view actor and the viewport's height clipping come after the frame is up. Buildings and Fences are dotted rail items without bars until their features exist.
- **WHY:** The frame needs almost nothing the host lacks — it is layout over existing tool and view state — so building it first gives visible progress and makes the plumbing gaps concrete before they are designed.

## The map needs real voxel data, not only a heightmap
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** document
- **SCOPE:** architectural (future)
- **WHAT:** The terrain today is a heightmap of columns (`TerrainData.height` in half-tiles, one value per cell). The document must eventually hold actual voxel data — occupancy per cell per layer — so that overhangs, caves, the brief's Blocks fallback and true 3D region selection are representable. Not scheduled; recorded so the frame and selection work do not bake the heightmap assumption in deeper than necessary.
- **WHY:** Voxel regions are an underlying concept of the editor and a heightmap cannot represent them; the layer view and region selection are designed against voxels, and the document should catch up rather than the UI regress to columns.

## The visual tour runs by hand, not on every PR
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** ci
- **SCOPE:** moderate
- **WHAT:** The `visual` job (Chromium install + `pnpm tour`, screenshots as an artifact) leaves `gate.yml` for its own `visual.yml` on `workflow_dispatch` only — `gh workflow run visual.yml --ref <branch>` when a rendering change warrants it. The per-PR path is the `gate` job alone (build, bundle-size, test, typecheck, lint; ~1 minute). `gate` stays the one required check; `strict` (branch must be up to date) stays on for now.
- **WHY:** The tour took ~4 minutes to the gate's ~1 and was never a required check, so it only ever added wall-clock to every PR without gating anything; right now that wait is an impediment to iterating on the UI, and a human looking at the running editor catches what the tour was for.

## Select tool: snapping, modifiers, nudge, framing, context menu
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** editor-ui
- **SCOPE:** moderate
- **WHAT:** Dragging an object snaps by default (grid; half/free as the Objects bar offers), with a modifier key temporarily disabling snapping. Modifier keys constrain a drag (e.g. to one axis). With an object selected, the arrow keys nudge it one grid cell. Dropping an object into water is allowed for now (a setting may prevent it later). Framing an object is a viewport operation, not tied to double-click (binding undecided). Selection gets a context menu; cut/copy/paste work on it.
- **WHY:** Continuous placement without snapping does not fit a grid-based level; the modifier conventions (constrain, snap-off, nudge) are what every reference art app trains, so they cost nothing to learn.

## Water is a heightmap bound to the terrain; terrain sculpted to the water's height clears it
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** document
- **SCOPE:** architectural
- **WHAT:** Water cannot exist at the same height as the terrain under it. Raising or flattening a cell to or above its water level clears the water in the same edit; setting water at or below terrain height does nothing. Unlike the terrain, which is to become voxel data (#100), water stays a per-cell height.
- **WHY:** Water is a surface, not volume: it is exactly what a heightmap represents, and a cell that is both land and water at one height is not a state the renderer or the game can mean anything by.

## Sculpt strokes apply on a cell boundary crossing with hysteresis
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** feature-terrain
- **SCOPE:** minor/local
- **STATUS:** tentative
- **WHAT:** A sculpt stroke applies once per cell, when the pointer has fully passed from one cell into the next, decided from the pointer's position on the press plane rather than from the picked surface, with a dead zone past the boundary. The dead zone's size is dialed in by feel on a prototype and then fixed.
- **WHY:** Applying on every change of the picked surface re-triggers off the geometry the stroke just raised and chatters along edges; the artist wants a stroke that lands where the brush clearly is.

## Water is its own tool, not a terrain verb
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** editor-ui
- **SCOPE:** moderate
- **WHAT:** Water leaves the Terrain tool's verbs and becomes a rail subject of its own, with its own bar and settings: the water line's height (defaulting to the layer view's top handle), fill and drain as its modes, and room for later behaviour (flow, shore) that terrain has no place for. Picking looks through water everywhere: every tool edits the ground under it, and previews draw there.
- **WHY:** Water is not terrain — it is a surface bound to the heightmap with behaviours and settings of its own (ruling of the same date) — and the rail's rule is one subject per item. Folded into terrain it could only ever be "pool at the pressed cell", which never made sense.

## The level is a scene graph of structures; kinds register their handlers per layer
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** document
- **SCOPE:** architectural
- **WHAT:** A level document is a scene graph of *structures*. Each structure has a kind, a transform relative to the structure it sits in, and kind-specific data. Any kind can be a child of any kind: a sketch extrusion can be placed inside a voxel volume, and a voxel volume can be the child of a sketch extrusion it sits on. The first kinds: a *voxel volume* (the current heightmap re-homed, growing into true voxel data per #100; its edges can be dragged to resize) and a *sketch* (a closed profile on a sketch plane, extruded). Level extent is derived from the structures, not authored; camera bounds stay authored. Objects, camera and atmosphere remain level-level. Every terrain-shaped concern — data and reversible patches, meshing, height-at-point, picking to a surface, which tools address it, which material kind it consumes — is dispatched per kind: a kind registers its handler in each layer it touches (data in `document`, mesher in `geometry`, scene bits in `runtime`, tools in a `feature-*`), the same way features register today. Materials gain kinds too (sheet tiles; Ferr2D-style fill + edges with tiling parameters). Water becomes a structure. Transforms are integer position plus 90° yaw for voxel kinds, free for sketch kinds.
- **WHY:** One document with a structure list generalizes both the grid editor and the CAD-style sketch workflow without a second document, store or command set; it makes "a voxel grid on top of an island" ordinary rather than a hybrid special case, and lets an author re-edit a sketch or resize a volume without breaking what sits on it. Voxel data and the Water tool were already heading here.

## Sketch workflow: Ferr2D-style points, closed profiles first, one height, two-material dressing
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** feature-sketch
- **SCOPE:** moderate
- **WHAT:** A profile is a sequence of points each flagged corner or smooth; curves are generated between smooth points, no handles. A sketch first produces a closed profile extruded to one height (island, plateau, platform); holes, open paths with thickness (walls, fences) and open paths with width (roads, rivers) follow later. Terraces come from nesting sketches, not per-point height; later the cap itself may be meshed and subdivided so its points can be moved up and down. Sketch planes are horizontal, placed relative to the parent structure. Points snap to the grid by default, half-cell available, free with the modifier — the same convention as object drags. Dressing is two materials: a cap material (fill plus a rim edge along the outline) and a wall material (body, a top edge where it meets the cap, a bottom edge where it meets the ground below, inner and outer corner pieces), each edge with width, segment length and tile/stretch repeat. Corners are geometry first: smooth points round a corner and the bands wrap around it, hard corners mitre; corner textures are a later refinement. Ferr2D's per-direction edges do not carry over; walls read alike in top-down 3D and lighting differentiates them.
- **WHY:** The reference (Paper Mario: TTYD terraces) is exactly cap-with-lip over wall-with-seams; corner/smooth points give a level artist an island in a dozen clicks; one height plus nesting is what the scene graph already provides; horizontal planes keep every "what is under this point" query simple until voxels (#100) land.

## Sketch workflow validated in the lab; fold it into the app
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** feature-sketch
- **SCOPE:** moderate
- **WHAT:** The sketch lab (branch `lab/sketch`, apps/sketch-lab) proved the workflow: corner/smooth points with no handles, one height per sketch, tiers by nesting (a child's plane is its parent's cap), the two-material dressing, and click-to-select. Two things the lab added become part of the model: the wall's side profile is *drawn* — a polyline of (outward offset, height) points from ground to lip, smoothed like the outline, swept around it — not a parameter; and the lip style (flat / skirt / bevel) is a per-material choice to keep. Follow-up requirement, not for the lab: segments of a sketch that run along its parent's edge must be able to *link* so the two share one wall instead of stacking two. The mesher (`packages/geometry/src/sketch.ts`) is real code and lands on main; the lab app stays on its branch as the record.
- **WHY:** Drawing an island and a tier on it took a handful of clicks and read as the reference art; the drawn profile gave the cut-earth silhouette a parameter could not; the doubled wall at a flush tier edge is the one visible flaw, and it is a data question (linked segments), not a workflow one.

## No format migrations until real data exists
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** document
- **SCOPE:** minor/local
- **WHAT:** `formatVersion` bumps freely and old shapes are simply not read; `deserialize` rejects them. Migrations start when a level worth keeping exists.
- **WHY:** Nothing has been authored outside prototypes; a migration now would be code protecting no data.

## Drag modifiers follow the reference art apps; Select picks structures too
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** editor-ui
- **SCOPE:** moderate
- **WHAT:** One snap setting (grid / half / free) serves every drag. Holding Ctrl (Cmd on a Mac) frees one drag or press from snapping; holding Shift constrains a drag to the axis it has travelled further along. This replaces the sketch tool's earlier Shift-for-free. The arrows nudge the selection one cell along the world axes. Select is one tool over everything: a press on an object selects and drags it; a press on any structure's surface — the ground included — selects that structure and drags it by its placement in its parent (voxel volumes to whole cells; the root never moves); a press on nothing clears.
- **WHY:** Photoshop, Figma and Blender all put snap-off on Ctrl/Cmd and axis constraint on Shift, so those hands already know it; the ground being selectable is what a scene graph of structures means — the level has no special-cased terrain to click past.

## Public demo on GitHub Pages, deployed from main via Actions
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** ci / deploy
- **SCOPE:** moderate
- **WHAT:** The editor is published as a static GitHub Pages site so people can try it. A workflow builds apps/editor on every push to main and uploads it with actions/deploy-pages. There is no gh-pages branch.
- **WHY:** The demo should always match main, and main is already protected by the gate, so anything that ships has passed it. The artifact flow keeps build output out of git history and avoids a second branch to manage.

## The project is named Papercut
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** The editor is named "Papercut", replacing the placeholder "papercut". This entry records the name only. Renaming the repo, packages, or app is a separate step.
- **WHY:** The name fits the vision: flat 2D art cut out and arranged in 3D space, in a Paper Mario style. Developers use "papercuts" to mean small annoying bugs, and that meaning is a welcome joke, not a drawback. Other names were rejected: Foldout (Unity already uses the word for a UI control), Proscenium (hard to spell and say), Terrarium (too close to Terraria), and Papercraft (Papercraft Games already makes a level tool, Folded Paper Engine; the word is a generic hobby term; and it suggests the reverse workflow, 3D model to flat paper). Accepted trade-offs: PaperCut Software, the print-management company, owns papercut.com and dominates search results, and `papercut` is taken on npm.

## The project is Papercut
- **WHEN:** 2026-09-12
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** The project is named Papercut. The GitHub repository is `Syynth/papercut` (renamed in place; the old name redirects for git and the API, but not for the Pages site, which now lives at https://syynth.github.io/papercut/), the package scope is `@papercut/*`, and the header and page title carry the name. The checkout folder on disk keeps its old name.
- **WHY:** The owner's choice of name; no rationale recorded.

## UI state lives in actors; the UI is regions that select from them
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** editor-ui
- **SCOPE:** architectural
- **WHAT:** State the UI reads lives in xstate actors on the host, read through selectors: what the artist set (tools, view), and what the viewport observes (hover, brush cells, camera, frame stats) in a viewport actor. No hand-rolled stores and no React context for editor state. The app is a composition of regions that each select only what they show and dispatch their own commands; nothing passes interaction state down as props. Things that must reach the viewport object (frame, sweep) are commands its actor answers with emitted events. Artists will later configure terrains and textures live, so the art stays derived in one place.
- **WHY:** Actors are already how the editor's behaviour is built and inspected, and selector reads re-render only what changed. The god component re-rendered the whole editor on every pointer move (400 ms of script a second, measured).

## No tilt-shift; post-processing off for now
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** viewport
- **SCOPE:** moderate
- **WHAT:** Tilt-shift is removed from the editor entirely. The post-processing stack is bypassed by default: the viewport renders straight to the canvas, and bloom is off everywhere. The composer stays built so a probe can measure it.
- **WHY:** Tilt-shift was never asked for. On an M5 Mac, anything drawn through the composer rendered cut off past a view depth, and neither a 24-bit multisampled target nor dropping tilt-shift fixed it; the level must render on every machine before any post effect.

## Performance work is measurement first
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** Performance changes start from `pnpm perf`: it drives a set of tasks on the real GPU and measures frame time (CPU per phase and GPU), memory footprint, allocations and leaks, and each fix is compared against a saved run. Leaks are fixed first, then React updates, then the rest by what the numbers show.
- **WHY:** The editor is slow and memory-hungry, and guessing at causes had already cost time (the post-processing chase); a harness makes each change's effect visible and keeps regressions from sneaking back.

## The layer view is a GPU section cut with flat caps
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** viewport
- **SCOPE:** moderate
- **WHAT:** The layer view is drawn on the GPU, not by clamping heights and remeshing. A clipping plane removes everything above the ceiling; what the ceiling cuts through shows a flat cap in the cut colour (not the terrain's top texture); what lies below the floor darkens in the shader. Picking lands on the cap at the ceiling. Moving the slider changes uniforms and never rebuilds geometry.
- **WHY:** Remeshing every chunk per slider step cost 863 ms of script and 425 MiB a second, and near the bottom of the range almost every chunk changes every step, so rebuilding only what changed could not fix it. A flat cap is an acceptable look for a view that exists to show structure, not finished art.

## Pan holds the pressed point under the cursor
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** editor-viewport
- **SCOPE:** minor/local
- **WHAT:** A right-drag pan keeps the world point that was under the cursor at the press under the cursor for the whole drag. The press grabs the surface under it (or the plane at the orbit target's height over the sky); each move re-casts the cursor's ray onto that plane and slides the rig by the difference. Pixels-per-unit scaling is only a fallback for a ray that misses the plane (cursor above the horizon).
- **WHY:** The old pan slid the target by a fixed per-pixel amount scaled by distance, so the ground drifted relative to the cursor — the tools felt janky and unusable. Anchoring the gesture to the thing under the cursor is the convention every 2D and CAD tool uses, and it makes the pan feel like dragging the map itself.

## The view cube sets the editor's view, not the game's rig
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** editor-viewport
- **SCOPE:** moderate
- **WHAT:** A chamfered view cube overlays the viewport corner. Clicking a face, edge or corner animates the editor camera to that view; clicking the same view again toggles the editor between perspective and orthographic; dragging the cube orbits. That projection is editor view state on the view actor (`view.set {projection}`), alongside showGrid and gameCamera — NOT the document's `camera.projection`, which stays the game's rig. Game-camera mode and play honour the rig's projection; free editing honours the view's. Views from below are inert on the cube: the terrain is a top skin, there is nothing to see under it.
- **WHY:** Aligning to a face and flipping to ortho is how you inspect and line things up while building, the way Blender's numpad views work; it says nothing about how the game looks, and one map is built under many views. Making the toggle a document edit would dirty the level, land in undo, and change the shipped game each time someone squared up a wall.

## Web UI updates ship separately from the Electron shell, without code signing
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** desktop-shell
- **SCOPE:** architectural
- **WHAT:** The desktop app updates in two layers. The web UI bundle (the `apps/editor` build) is rebuilt often and updated in place in installed apps, with no code signing and no reinstall. The Electron shell (main process, preload, native integration) updates through a full signed installer release, and only when a shell change needs one.
- **WHY:** The web UI is where changes happen often, and those changes should reach the desktop app as fast as they reach Pages. If every UI change needed a signed, notarized installer, each one would carry the full cost of a shell release: signing, notarization, and a full app download. Keeping the shell small and rarely changed limits that cost to the rare changes that need it.

## Web bundles are signed downloads, applied through a reload prompt
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** desktop-shell
- **SCOPE:** architectural
- **WHAT:** CI publishes each web bundle next to the Pages deploy as `bundle.zip` plus a `manifest.json` (version, sha256, `minShellApi`), signed with a key held in a CI secret. The shell checks the manifest's signature against a public key built into the app, then unpacks the bundle to a versioned folder in the app's data directory and serves the active bundle through a custom `app://` protocol. Every installer includes a starting bundle. A bundle that needs a newer shell API is held back until the shell updates. The window never loads the remote Pages site directly. When a new bundle is ready, the user sees "Update ready, reload": the document is saved, then the window reloads into the new bundle.
- **WHY:** The renderer will have file access through the preload script, so a tampered bundle could do real damage. Checking a signature means only CI can ship UI code to installed apps, and a hash served from the same host as the bundle wouldn't guarantee that. Unpacking into versioned folders keeps the app working offline and makes rollback a pointer switch. A reload throws away in-memory state, so the user decides when it happens, and the document is saved first.
- **STATUS:** amended 2026-09-13 — no `bundle.zip`; see "Web bundles are delivered as a signed per-file manifest, not a zip" below.

## The desktop shell is Electron
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** desktop-shell
- **SCOPE:** architectural
- **WHAT:** The desktop shell is Electron, built in `apps/desktop`. This settles the Electron-vs-Tauri question that "Decisions deliberately deferred during the prototype" held open. The heavy-scene smoke test planned to decide it won't be run.
- **WHY:** The owner has used Tauri and is unhappy with it. Its main advantage is a Rust backend, and papercut has no use for one: the app is a TypeScript web UI in a thin desktop wrapper. The goal is a shell that works predictably. Electron ships its own Chromium, so the editor runs on the same engine on every platform instead of each OS's webview. Its packaging and update path is mature and widely used. A smoke test wouldn't change a choice already made on first-hand experience.

## Papercut gets its own signing credentials, after an unsigned end-to-end build
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** desktop-shell
- **SCOPE:** moderate
- **WHAT:** Papercut's macOS signing uses its own credentials (certificate, notarization API key or app-specific password, CI secrets), set up alongside brink's rather than reusing them. brink (`~/code/rs/brink`) is a reference for the process only. Signing comes after an unsigned build works end to end: packaged app, bundle updater, and CI publishing.
- **WHY:** Separate credentials mean one project's secrets can be revoked or rotated, or can leak, without affecting the other. Proving the whole update pipeline unsigned first means a signing failure can't hide a pipeline bug, or the other way round.
- **STATUS:** amended 2026-09-13 — the Developer ID certificate is the team's existing one; see "Papercut reuses the team's Developer ID certificate, with its own notarization key" below.

## The desktop app's bundle ID is dev.syynth.papercut
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** desktop-shell
- **SCOPE:** moderate
- **WHAT:** The Electron app's `appId` (the macOS bundle identifier) is `dev.syynth.papercut`, and its product name is `Papercut`. This intentionally breaks from brink's `dev.<product>.<app>` pattern (`dev.brink.studio`).
- **WHY:** The ID names the publisher, not the product, so future apps can share the `dev.syynth` prefix. It needs to be picked once and kept: signing, notarization, and the permissions and keychain entries macOS grants the app are all tied to it. The product name needs the same care, because Electron names the app's data folder after it, and renaming would strand autosaves and downloaded bundles.

## Web bundles are delivered as a signed per-file manifest, not a zip
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** desktop-shell
- **SCOPE:** moderate
- **WHAT:** Amends "Web bundles are signed downloads, applied through a reload prompt". There's no `bundle.zip`. CI publishes a signed `manifest.json` next to the Pages deploy, listing every file in the bundle with its path, size and sha256, plus the version and `minShellApi`. The shell downloads each file directly from the Pages site and checks it against the manifest before switching to the new version. A file whose hash matches one in the version already installed is copied locally instead of downloaded. The rest of that entry still holds: the signature check, versioned folders, `app://`, the reload prompt.
- **WHY:** Pages already serves every file in the bundle, so a zip would be a second copy of the same bytes. The signature covers every file's hash, so the security stays the same. Vite names assets by content hash, so most files are unchanged between commits and an update only fetches what changed. There's no zip step in CI and no unzip dependency in the shell.

## Every bundle declares the shell API it needs, and a mismatch asks for a full app update
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** desktop-shell
- **SCOPE:** moderate
- **WHAT:** Every signed bundle manifest includes `minShellApi`, the lowest shell API version (`SHELL_API_VERSION`, which the preload exposes) the bundle works with. The value comes from the editor, where the code that depends on the shell lives. If a newer bundle's `minShellApi` is above the running shell's version, the shell doesn't install it and tells the user a full app update is needed. It's never silently skipped. Only the shell API version counts; the shell's release version is ignored.
- **WHY:** The update path, a live bundle reload or a full reinstall, has to be decided from data the bundle carries, not guessed from what changed. An API version changes only when the preload's surface changes, so ordinary shell releases don't force every bundle to need a newer app. Telling the user means an out-of-date app doesn't quietly stop getting updates.

## The first shell ships a generic, folder-scoped filesystem API as a Developer ID app
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** desktop-shell
- **SCOPE:** architectural
- **WHAT:** The first shell build exposes a generic filesystem API to the web bundle: read, write, list, stat, mkdir, rename, delete and watch, plus native open and save dialogs. Every path must fall inside a folder the user granted through a native dialog, and the main process enforces this. Grants persist across launches and can be revoked. The macOS build is a Developer ID app without the App Sandbox, using the hardened-runtime entitlements Electron needs plus Info.plist usage descriptions for the protected folders (Documents, Desktop, Downloads, removable and network volumes). The app won't target the Mac App Store.
- **WHY:** The owner wants to iterate on what the app does with the filesystem, and anything in the shell (preload API, entitlements, Info.plist) changes only through a full app update. A generic API in the first build lets file features change freely through bundle updates. Limiting access to granted folders means a bad or compromised bundle can reach your project folders but not `~/.ssh` or the rest of your home folder. The App Sandbox and the Mac App Store are ruled out because the app updates its own bundles, and the App Store wouldn't allow that.

## Papercut reuses the team's Developer ID certificate, with its own notarization key
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** desktop-shell
- **SCOPE:** minor/local
- **WHAT:** Amends "Papercut gets its own signing credentials, after an unsigned end-to-end build". When signing is set up, papercut signs with the team's existing Developer ID Application certificate rather than a new one. It gets its own App Store Connect API key for notarization and its own CI secrets. The order is unchanged: signing still comes after the unsigned pipeline works end to end, through CI.
- **WHY:** A Developer ID certificate identifies the team, not an app, and Apple limits how many a team can have. A second one would add nothing, because both would carry the same name and Team ID. The notarization key is the credential that can actually be scoped and revoked per project, so it's the one kept separate.

## The desktop app reports its web bundle version alongside the shell version
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** desktop-shell
- **SCOPE:** minor/local
- **WHAT:** Wherever the desktop app reports its version (for now, the About panel), it shows both the shell's release version and the web bundle it's serving: the bundle's sequence number and short commit, or "built-in bundle" before any update. For example, `0.1.0 (bundle 25 · 9c649e3)`. It updates when a reload switches bundles.
- **WHY:** The bundle updates without the shell's version changing, so the shell version alone doesn't tell you which editor is running. Two installs of the same release can be on different bundles, and a bug report or a check that an update landed needs both numbers.

## Terrain paint is dual-grid autotiling over materials, on tops and cliff faces
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** cross-system (document, geometry, feature-terrain)
- **SCOPE:** architectural
- **WHAT:** What the artist paints is a material, never a tile; the tile is derived. A material is a library entry on the level (name, sheet, region, role hint of top/wall/ramp/any), added, renamed, reordered and deleted from the Terrain inspector; its order is its draw priority. Each material is authored as a dual-grid set of 16 whole tiles indexed by which of an offset tile's four corners hold it. Cells store a top material and a wall material; a cliff band may override the wall material at the existing stable address (cell, side, level). The mesher emits each top and each band as four quarters, each sampling the quarter of the offset tile at its corner, with the corner mask computed per cell so height discontinuities fall on the split. A cliff face is autotiled in face space: bands above/below/beside count, the top surface and the ground count as edges, a bend in the face counts as connected. At a corner holding several materials the runtime atlas composites the lowest material's full tile under each higher one's masked tile, cached per combination; per-pair authored transitions are a later override. Ground at the foot of a cliff treats a taller same-material neighbour as connected, so there is no rim at the base (tentative). The raw tile brush stays only as an escape hatch (a per-cell stamp layer); its interaction is to be redesigned.
- **WHY:** The current paint stores raw tile ids, so nothing painted autotiles, cliffs cannot be dressed in a material of their own, corners are impossible with a four-neighbour mask, and materials cannot be managed at all. Dual grid gives real corners from 16 tiles the artist draws whole, and treating a cliff face as the same kind of grid makes one brush work everywhere.

## Ramps are 45°, one tile per cell, with run length set by drag
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** cross-system (document, geometry, feature-terrain)
- **SCOPE:** moderate
- **WHAT:** A ramp cell always slopes at 45°, dropping one tile over one cell; ramp art is a strip per material of tiles one cell wide and √2 cells tall, in single / left-edge / middle / right-edge variants, plus a half-length piece that drops one half-tile over half a cell for odd drops. With the Ramp verb, press on a cliff face and drag back to choose how many cells the run spans; a length that does not meet the drop is refused. Clicking any cell of a ramp removes the whole run; shift-click removes too. The direction dropdown and the ramp inspector panel go away.
- **WHY:** A √2-tall tile lets pixel art be drawn at true scale on a 45° slope instead of being stretched. A per-cell ramp with a fixed drop that ignored the neighbour left gaps, and a ramp could not be removed because its cliff face no longer existed to click and its top supplied no direction.

## Sculpt verbs: Raise/Lower and Smooth take a strength; Flatten shows a target height
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** feature-terrain
- **SCOPE:** moderate
- **WHAT:** Sculpt has four verbs: Raise (shift lowers), Flatten, Smooth, Ramp. Strength is an integer number of half-tiles per pass and applies to Raise/Lower and to Smooth, which moves each cell toward the mean of its neighbours by at most the strength. Flatten sets cells to a height shown in the bar, sampled at the press and editable. Water is not a terrain verb (ruling of 2026-09-12 stands; the interim pooling verb is removed when the Water tool lands).
- **WHY:** Raising by one half-tile per pass makes large changes tedious, and flattening and smoothing are different operations that a single strength cannot serve.

## Numeric tool parameters are scrub fields, not sliders
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** editor-ui
- **SCOPE:** moderate
- **WHAT:** Brush size, strength, flatten height, the sculpt dead zone and any future numeric parameter are shown as a number that can be dragged horizontally to change, clicked to type into, or nudged with arrow keys (shift for coarse steps). Sliders leave the bar and the inspector for these; the `[` `]` size keys stay.
- **WHY:** These are small exact values a slider cannot reliably land on; a slider track spends bar width the icon-only bar does not have; typing a value must be possible; and scrubbable fields are the convention in the reference art apps.

## The voxel model is scheduled now, built with the sculpt verbs; a voxel is a cube; one material per voxel
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** cross-system (document, geometry, feature-terrain)
- **SCOPE:** architectural
- **WHAT:** The 2026-09-12 ruling that the map needs real voxel data (#100) is scheduled: the document becomes voxels and the reworked sculpt verbs (Raise/Lower with strength, Flatten with a height, Smooth, Ramp by drag) are written against it as one piece of work, with Water and the material paint following. A voxel is a full cube, one tile on every side; a half-height slab is a voxel shape, as are the 45° ramp and the half-length ramp piece, each with a direction. Every voxel carries one material. Contiguous flat areas of same-material tops autotile dual-grid style by drawing the offset tile centred on each cell corner; where a height edge crosses a corner the tile is split into the quarters that belong to each cell, so the two renderings are the same picture. Side faces autotile the same way in face space. A per-face material override at (cell, side, level) stays for exceptions, at the address the cliff paint layer already uses.
- **WHY:** Every sculpt verb touches height, so building them on columns and again on voxels is the same code written twice, while the paint addressing is already voxel-shaped; the no-migrations ruling makes changing the document cheap now. Cubes rather than half-tile voxels because the tile is the unit everywhere and a half step should look like the exception in the data; whole-tile layers keep the layer view, region selection and outliner half the size; cubes match the brief's Blocks fallback and the voxel-art convention the artist knows; and half-tile heights were an open question that slabs keep possible without making them the norm.

## Any number of terrains may meet at a corner; unauthored transitions composite and are shown
- **WHEN:** 2026-09-13
- **PROJECT:** papercut
- **SYSTEM:** cross-system (document, geometry, feature-terrain)
- **SCOPE:** moderate
- **WHAT:** Amends the dual-grid ruling of the same date. A transition tile is authored as the transition itself (half grass, half path) and tagged per corner; the tile at a cell corner is the one tagged exactly like its four cells, for any number of terrains. Two, three or four terrains meeting at a corner is allowed. Where no tile is authored for the exact combination, the corner is composited with no extra art: the lowest terrain in the library order from its edge set, then each higher terrain's edge-set tile over it. Composited corners are shown in the editor (a toggleable mark) and the distinct missing combinations are counted and named, so transitions are drawn on demand; an authored tile always wins over the composite. Library order matters only for composited corners and for which terrain is the shape when a template is placed.
- **WHY:** A complete set for six terrains is about 1,300 tiles, so restricting corners to pairs is an authoring budget, not a property of the model. Compositing from the edge sets gives every corner a plausible look for free, and showing what was composited turns the gap into a to-do list the artist works off as the level needs it.

## Materials are a project setting, not a map setting
- **WHEN:** 2026-09-14
- **PROJECT:** papercut
- **SYSTEM:** cross-system (document, project format, feature-terrain)
- **SCOPE:** architectural
- **WHAT:** The material library (id, name, role, top and side terrain refs, priority order) lives in the project file, `papercut.json`, and every map in the project paints from it; a map stores only the material ids its voxels hold. Sheets and their terrain-set sidecars are listed by the project too. A map opened with no project falls back to the built-in placeholder set.
- **WHY:** A material is the artist's palette, and a palette that is per map cannot be shared: two maps in one project would drift, and "terrain type management" as a project setting (the LDtk model) is only possible if the project owns the list. Ids stay stable so moving the list out of the map does not touch what voxels store.
- **STATUS:** amended 2026-09-14 — the fallback for a map with no project is moot; see "The app opens projects only; a map is opened within its project" below.

## The resolution profile is a project setting, with no per-map override
- **WHEN:** 2026-09-14
- **PROJECT:** papercut
- **SYSTEM:** project format
- **SCOPE:** moderate
- **WHAT:** The resolution profile (texel density and filtering) is asked for when the project is created and stored in `papercut.json`. Every sheet added to the project is checked against it and a mismatch is reported, never rescaled. No per-map override; the brief's cascade is deferred until a map actually needs one.
- **WHY:** Mixed texel density is the fastest way to make pixel art in 3D look wrong (brief, resolution section). One profile per project makes every sheet and every map line up by construction, and an override is a warning surface nobody has asked for yet.

## The project file lists its maps, in order
- **WHEN:** 2026-09-14
- **PROJECT:** papercut
- **SYSTEM:** project format
- **SCOPE:** minor/local
- **WHAT:** `papercut.json` lists the project's maps by path, in order, the way LDtk's world list does. The list is the project's map order in the UI; a map file present in `maps/` but absent from the list is reported, not silently included or ignored.
- **WHY:** An ordered list is authored intent (which map comes first, which are part of the game) where a folder glob is an accident of filenames. Listing also lets a missing file be reported, the same rule the sheet list follows.

## The app opens projects only; a map is opened within its project
- **WHEN:** 2026-09-14
- **PROJECT:** papercut
- **SYSTEM:** project format
- **SCOPE:** architectural
- **WHAT:** There is no door for a loose `.map.json`, no standalone-map mode, and no migration of today's map files: the project format starts fresh and the map format is defined as the project's. Recents are projects.
- **WHY:** Nobody has made a map yet; the project is a day and a half old, so there is no legacy to keep alive, and a second way in (brink needs two because a story can be one file) would only add a code path and a badge for an identity papercut does not have.

## The terrain setup screen works like Tiled's terrain editor
- **WHEN:** 2026-09-14
- **PROJECT:** papercut
- **SYSTEM:** terrain-tools / settings
- **SCOPE:** moderate (the design of the sidecar authoring UI, #146)
- **WHAT:** Painting on the map stays as it is: pick a material and paint. The setup screen in Project settings (the Terrains section) works the way Tiled's terrain editor does: the artist picks an image (a sheet), a terrain list sits beside the image, and terrains are assigned by clicking or dragging over tile corners in the image; every tagged corner shows as a translucent wedge in the terrain's colour so the whole set reads at a glance. That tagging is what decides how textures are painted onto the terrain. Sets stay corner-only; Tiled's edge and mixed set types are not adopted.
- **WHY:** Both familiarity and reach. The people who will tag sheets already know Tiled's editor and should not have to learn a second idiom for the same job. Tagging corners directly on the image also works for any sheet layout, hand-drawn or third-party, where the template-placing approach in the terrain-tools mockup only fits tiles laid out on its fixed 4 × 4 block.

## Tagging in the Terrains editor is undoable
- **WHEN:** 2026-09-17
- **PROJECT:** papercut
- **SYSTEM:** terrain-tools / settings
- **SCOPE:** moderate
- **WHAT:** The Terrains editor keeps its own undo history while it is open: ⌘Z / ⌘⇧Z, with Undo and Redo buttons in its tools row, step through strokes, terrain adds, removals, renames and recolours, each as one entry, separate from the map's undo. The history clears when the settings modal closes. The other Project settings stay as they were: not undoable.
- **WHY:** Tagging is authoring by hand, stroke after stroke, and a slip should cost one keypress, the way it does in Tiled and on the map itself. A rename in a settings field is not that, so the rest of the settings keep their brink-style no-undo.

## Asset pickers are rich typeaheads
- **WHEN:** 2026-09-17
- **PROJECT:** papercut
- **SYSTEM:** editor-ui
- **SCOPE:** moderate (a shared control, used everywhere assets are picked)
- **WHAT:** Every control that picks an asset of the game — a sheet, a terrain, a material, a sprite, a map — is a rich typeahead, not a plain dropdown: type to filter as you go, rows carry a thumbnail or swatch and a second line of detail (size, tile size, where it lives, what uses it), keyboard up/down/enter, and the current value shown as such a row. Plain selects stay for short fixed lists (a filtering mode, a projection).
- **WHY:** A real game has hundreds of images, terrains and sprites; a dropdown of names does not scale and gives no way to tell two similar assets apart.

## A sheet's tile size may divide the density; tilesets are managed in Sheets
- **WHEN:** 2026-09-17
- **PROJECT:** papercut
- **SYSTEM:** project format / settings
- **SCOPE:** architectural (amends "The resolution profile is a project setting", 2026-09-14)
- **WHAT:** A sheet's tile size may be the project's texel density or an integer divisor of it; such a sheet is scaled up by nearest neighbour into the atlas (16 px in a 48 px project draws at 3×). Any other size is refused with the reason. Sheets are managed in one place, the Sheets section of Project settings: it is where a tileset is viewed, imported and annotated — its tile size and the rest of its settings are applied there, and images found in `sheets/` but not listed are noticed there and offered for listing. The terrain editor picks from that section's list, showing only the sheets compatible with the project's density.
- **WHY:** A game mixes kits authored at different pixel sizes, and an integer upscale of pixel art loses nothing, so the density rule only needs to forbid what would resample. One place for a tileset's settings means the terrain editor never has to explain why a sheet is missing; it simply lists what fits.
