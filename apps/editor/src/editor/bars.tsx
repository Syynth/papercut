/**
 * The context bar: the ACTIVE tool's mode switch, verbs and parameters in one
 * icon-only row. Switching tools swaps the whole bar.
 *
 * Which bar is the registry's decision where it can be: a tool's owner may
 * declare panels with `slot: 'bar'`, and `FeaturePanels` renders those under
 * the owner's own `when`s. The host's two tools declare no panels — Select
 * and Objects are the app's to draw, since their controls (the selection's
 * name, the sprite library) are things only the app holds.
 */

import type { Selection } from '@papercut/editor-host'
import { mergeParams, type EditorParams } from './params'
import { useDocument, useHost, useProject, useToolsSelector, useViewSelector } from '@papercut/editor-host'
import { MATCH_RULES, describeRegion, type MaterialDef, type RegionMatch, type ReadonlyMapDoc, type ReadonlyProjectDoc, type SnapMode } from '@papercut/document'
import { SPRITE_NAMES } from '@papercut/fixtures/textures'
import type { TerrainPanelProps } from '@papercut/feature-terrain'
import { always, chordFor, evaluate, panels, tools, type PanelSlot, type Platform } from '@papercut/registry'
import { BarDivider, BarGroup, BarLabel, BarScrub, BarValue, Chip, IconSegmented, Verb, type IconName } from '@papercut/ui'
import { useMemo, type ComponentType } from 'react'

import { run, setParams } from './commands'

const wholeDocument = (doc: ReadonlyMapDoc): ReadonlyMapDoc => doc
const materialsOf = (project: ReadonlyProjectDoc): readonly MaterialDef[] => project.materials

/**
 * The context bar as a region: the active tool's bar, re-rendered when the tool, its parameters or the selection change,
 * and when the document does once a stroke has closed (`settled`) — not on every tick of a drag.
 */
export function ContextBar({ platform }: { platform: Platform }) {
  const host = useHost()
  const tools = useToolsSelector((snapshot) => snapshot.context)
  const params = useMemo(() => mergeParams(tools), [tools])
  const selection = useViewSelector((snapshot) => snapshot.context.selection)
  const doc = useDocument(wholeDocument, { settled: true })
  const materials = useProject(materialsOf)
  const set = (changes: Partial<EditorParams>): void => setParams(host, changes)
  if (params.tool === 'select')
    return <SelectBar doc={doc} selection={selection} params={params} set={set} platform={platform} onDelete={() => run(host, 'selection.delete')} onClear={() => run(host, 'selection.set', { id: null })} onRegion={(op) => run(host, 'selection.region', { op })} />
  if (params.tool === 'object') return <ObjectBar params={params} set={set} />
  return <FeaturePanels slot="bar" tool={params.tool} doc={doc} materials={materials} params={params} platform={platform} selection={selection} />
}

/**
 * The panels the active tool's owner declared for `slot`, in declaration
 * order, each shown only while its own `when` holds (#9, #12). The rule is
 * the registry's rather than a list of feature names: the tool registry says
 * whose tool `terrain` is, and that owner's panels are the ones that edit the
 * parameters a stroke with that tool reads — the same join by declaring owner
 * that `Host.toolContract` makes for the handler.
 *
 * The cast is the app's to make and nobody else's. A `PanelDecl` carries an
 * opaque component because `registry` sits below React (#3), and what props
 * it takes is the feature's business; an app is the only thing that sees both
 * halves (#35), and this app installs one feature, whose panels take the doc,
 * the parameters, a setter and the platform.
 */
export function FeaturePanels({
  slot,
  tool,
  doc,
  materials,
  params,
  platform,
  selection,
}: {
  slot: PanelSlot
  tool: string
  doc: ReadonlyMapDoc
  /** The project's material library, for a feature's material chips. */
  materials: readonly MaterialDef[]
  params: EditorParams
  platform: Platform
  selection: Selection | null
}) {
  const host = useHost()
  const owner = tools.ownerOf(tool)
  // A feature's panels set the feature's own parameters: the command it declared, under its owner's name.
  const setOwn = (changes: Partial<EditorParams>) => void host.dispatch(`${owner}.params`, changes)
  // Derived per render, never held: the same rule `dispatch` follows (#8's
  // finding 2). A panel gated on the ramp verb has to appear the render after
  // the verb changed, and this component re-renders with the parameters.
  const keys = host.contextKeys()
  if (owner === undefined) return null

  return (
    <>
      {panels
        .all()
        .filter((decl) => panels.ownerOf(decl.id) === owner && (decl.slot ?? 'inspector') === slot && evaluate(decl.when ?? always, keys).available)
        .map((decl) => {
          const Component = decl.component as ComponentType<TerrainPanelProps & { dispatch?: (id: string, args?: unknown) => void; selection?: Selection | null }>
          return <Component key={decl.id} doc={doc} materials={materials} params={params} set={setOwn} platform={platform} dispatch={(id, args) => void host.dispatch(id, args)} selection={selection} />
        })}
    </>
  )
}

/** The glyphs the fixture sprites have; the rest get a monogram chip. */
const SPRITE_ICONS: Partial<Record<string, IconName>> = { tree: 'tree', bush: 'bush', rock: 'rock', lamp: 'lamp', sign: 'sign' }

/** What the selection is, in words: the object's or structure's name, or which point of which sketch. */
export function describeSelection(doc: ReadonlyMapDoc, selection: Selection | null): string | null {
  switch (selection?.kind) {
    case 'object':
      return doc.objects[selection.id]?.name ?? null
    case 'structure':
      return doc.structures[selection.id]?.name ?? null
    case 'sketchPoint':
      return doc.structures[selection.structure] ? `point ${selection.index + 1} of ${doc.structures[selection.structure]?.name}` : null
    case 'region':
      return doc.structures[selection.structure] ? describeRegion(selection) : null
    default:
      return null
  }
}

/** The snap setting, as both host tools offer it (ruling of 2026-09-12, "Select tool"); icons, as every bar control is. */
export function SnapControl({ value, onChange }: { value: SnapMode; onChange: (snap: SnapMode) => void }) {
  return (
    <>
      <BarLabel>Snap</BarLabel>
      <IconSegmented
        value={value}
        onChange={onChange}
        options={[
          { value: 'grid', icon: 'snapGrid', title: 'Snap to whole cells' },
          { value: 'half', icon: 'snapHalf', title: 'Snap to half cells' },
          { value: 'free', icon: 'snapFree', title: 'No snapping — holding ctrl (⌘ on a Mac) does this too' },
        ]}
      />
    </>
  )
}

/** Each Match rule as the bar shows it: its glyph, and what a double-click takes by it. */
const MATCH: Record<RegionMatch, { icon: IconName; title: string }> = {
  run: { icon: 'matchRun', title: 'Run: the full straight edge, to where it turns' },
  loop: { icon: 'matchLoop', title: 'Loop: the edge, on round the corners, all the way' },
  sameKind: { icon: 'matchKind', title: 'Same kind: connected tops, or connected feet, whatever their height' },
  sameTrim: { icon: 'matchTrim', title: 'Same trim: connected edges switched on, or off, like this one' },
  flat: { icon: 'matchFlat', title: 'Flat: every connected face in the same plane, whatever it is painted with' },
  material: { icon: 'matchMaterial', title: 'Material: connected faces showing the same material, across heights' },
  tile: { icon: 'matchTile', title: 'Tile: connected faces holding the same pasted tile' },
  surface: { icon: 'matchSurface', title: 'Surface: connected tops across steps up to the Step beside this' },
  wall: { icon: 'matchWall', title: 'Wall: connected side faces, round corners and up and down' },
  layer: { icon: 'matchLayer', title: 'Layer: the connected voxels of one storey' },
  island: { icon: 'matchIsland', title: 'Island: everything connected, without going below the clicked layer' },
  column: { icon: 'matchColumn', title: 'Column: straight down from the click, to the floor or the first gap' },
  samePiece: { icon: 'matchPiece', title: 'Same piece: connected voxels of the same shape, as a run of ramps is' },
}
/** The rules that are a test of one element against the clicked one, and so can be asked everywhere; the rest are about how elements join. */
const SIMILAR: readonly RegionMatch[] = ['sameKind', 'sameTrim', 'flat', 'material', 'tile', 'layer', 'samePiece']

export function SelectBar({
  doc,
  selection,
  params,
  set,
  platform,
  onDelete,
  onClear,
  onRegion,
}: {
  doc: ReadonlyMapDoc
  selection: Selection | null
  params: EditorParams
  set: (changes: Partial<EditorParams>) => void
  platform: Platform
  onDelete: () => void
  onClear: () => void
  onRegion: (op: 'expand' | 'contract' | 'invert' | 'pair') => void
}) {
  const named = describeSelection(doc, selection)
  const region = params.selectMode === 'region'
  const held = selection?.kind === 'region'
  const rule = params.selectMatch[params.selectElement]
  const moving = params.selectVerb === 'move' && params.selectElement === 'voxel'
  return (
    <>
      {/* The mode first, as every tool's bar has it (ruling of 2026-09-12): things that stand on the map, or a region of the terrain itself. */}
      <IconSegmented
        value={params.selectMode}
        onChange={(selectMode) => set({ selectMode })}
        options={[
          { value: 'objects', icon: 'objects', title: 'Objects and structures: click to select, drag to move' },
          { value: 'region', icon: 'marquee', title: 'A region of the terrain: its voxels, its faces or its edges' },
        ]}
      />
      {/* What is selected is said on the stage, in a pill beside the mouse hints (the owner, 2026-09-21), not here: it belongs to the view, under every tool. */}
      <BarDivider />
      {region ? (
        <>
          <IconSegmented
            value={params.selectElement}
            onChange={(selectElement) => set({ selectElement })}
            options={[
              { value: 'voxel', icon: 'voxel', title: 'Select voxels: what Move, Fill and Carve act on' },
              { value: 'face', icon: 'faceOf', title: 'Select faces: what paint and extrusion act on' },
              { value: 'edge', icon: 'edgeOf', title: 'Select edges: what fringes, pickets and rails act on' },
            ]}
          />
          <BarDivider />
          <IconSegmented
            value={params.selectFootprint}
            onChange={(selectFootprint) => set({ selectFootprint })}
            options={[
              { value: 'brush', icon: 'brush', title: 'Brush: takes what the drag passes over' },
              { value: 'rect', icon: 'rect', title: 'Rectangle: from the press to the pointer' },
            ]}
          />
          {params.selectFootprint === 'brush' ? <BarScrub label="Size" title="Brush size: drag to change, click to type" value={params.selectSize} min={1} max={12} onChange={(selectSize) => set({ selectSize })} /> : null}
          <BarDivider />
          {/* What a double-click takes: the element's default rule (design pass of 2026-09-20). The other rules join it here as they are built. */}
          {/* One unit, so the bar's overflow never leaves the label on the bar with its buttons in the menu. */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <BarLabel>Match</BarLabel>
            <IconSegmented
              value={rule}
              onChange={(next) => set({ selectMatch: { ...params.selectMatch, [params.selectElement]: next } })}
              options={MATCH_RULES[params.selectElement].map((value) => ({ value, icon: MATCH[value].icon, title: `${MATCH[value].title}. Double-click takes it; triple-click takes the next whole out` }))}
            />
          </span>
          {/* Only the switches the picked rule reads. */}
          {rule === 'run' || rule === 'loop' ? <Verb icon="followSlopes" active={params.selectFollowSlopes} title="Follow slopes: a run or a loop carries on down a ramp's side and onto the rim below" onClick={() => set({ selectFollowSlopes: !params.selectFollowSlopes })} /> : null}
          {rule === 'surface' ? <BarScrub label="Step" title="How big a change of height is still the same surface, in half-tiles: 0 is level ground only" unit="½" value={params.selectStep} min={0} max={8} onChange={(selectStep) => set({ selectStep })} /> : null}
          {rule === 'flat' || rule === 'wall' || rule === 'material' || rule === 'tile' ? <Verb icon="band" active={params.selectBand} title="Band: on a side face, keep to the clicked layer — one course of the wall" onClick={() => set({ selectBand: !params.selectBand })} /> : null}
          {rule === 'material' || rule === 'tile' ? <Verb icon={params.selectAnyLayer ? 'anyLayer' : 'topLayer'} active={params.selectAnyLayer} title="Any layer: match what a face holds on any of its layers, not only the one that shows on top" onClick={() => set({ selectAnyLayer: !params.selectAnyLayer })} /> : null}
          {SIMILAR.includes(rule) ? <Verb icon={params.selectEverywhere ? 'everywhere' : 'connected'} active={params.selectEverywhere} title="Everywhere: take every match on the map, within the layer view, connected to the click or not" onClick={() => set({ selectEverywhere: !params.selectEverywhere })} /> : null}
          <BarDivider />
          <IconSegmented
            value={params.selectDepth}
            onChange={(selectDepth) => set({ selectDepth })}
            options={[
              { value: 'surface', icon: 'depthSurface', title: 'Surface: only what the press touches' },
              { value: 'through', icon: 'depthThrough', title: 'Through: on down through the volume from the face you press, within the layer view' },
            ]}
          />
          <BarDivider />
          {/* How a new region meets the one there is the modifiers' to say (design pass of 2026-09-20): shift adds, alt takes away, and a plain press replaces. The four buttons that said the same are gone from the bar. */}
          <BarGroup>
            <Verb icon="expand" title="Grow the region by what is beside it" disabled={!held} onClick={() => onRegion('expand')} />
            <Verb icon="contract" title="Shrink the region by its rim" disabled={!held} onClick={() => onRegion('contract')} />
            <Verb icon="invert" title="Select everything else of the same kind, within the layer view" disabled={!held} onClick={() => onRegion('invert')} />
            {params.selectElement === 'edge' ? <Verb icon="pair" title="Pair: every top also takes its wall's foot, and every foot its top" disabled={!held} onClick={() => onRegion('pair')} /> : null}
            {/* Move is a way of dragging, so it is a toggle: on, a drag carries the selected voxels instead of taking a region. */}
            <Verb
              icon="move"
              active={moving}
              title={params.selectElement === 'voxel' ? 'Move: drag the selected voxels. Press a top to slide them over the ground, a cliff to slide them along and up it. Shift holds one way; alt leaves a copy' : 'Move carries voxels: switch the selection to voxels to use it'}
              disabled={params.selectElement !== 'voxel'}
              onClick={() => set({ selectVerb: moving ? 'select' : 'move' })}
            />
          </BarGroup>
          <BarDivider />
          <Verb icon="clear" title="Clear the selection" disabled={named === null} onClick={onClear} />
        </>
      ) : (
        <>
          <BarGroup>
            <Verb icon="trash" title="Delete the selection" kbd={chordFor('selection.delete', undefined, platform)} disabled={named === null} onClick={onDelete} />
            <Verb icon="clear" title="Clear the selection" disabled={named === null} onClick={onClear} />
          </BarGroup>
          <BarDivider />
          <SnapControl value={params.snap} onChange={(snap) => set({ snap })} />
        </>
      )}
    </>
  )
}

export function ObjectBar({ params, set }: { params: EditorParams; set: (changes: Partial<EditorParams>) => void }) {
  return (
    <>
      <BarLabel>Sprite</BarLabel>
      <BarGroup>
        {SPRITE_NAMES.map((name) => (
          <Chip key={name} title={name} icon={SPRITE_ICONS[name]} active={params.spriteName === name} onClick={() => set({ spriteName: name })} />
        ))}
      </BarGroup>
      <BarDivider />
      <BarValue>{params.spriteName}</BarValue>
      <BarDivider />
      <SnapControl value={params.snap} onChange={(snap) => set({ snap })} />
    </>
  )
}
