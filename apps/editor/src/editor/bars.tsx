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
import { describeRegion, type MaterialDef, type ReadonlyMapDoc, type ReadonlyProjectDoc, type SnapMode } from '@papercut/document'
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
  onRegion: (op: 'expand' | 'contract' | 'invert') => void
}) {
  const named = describeSelection(doc, selection)
  const region = params.selectMode === 'region'
  const held = selection?.kind === 'region'
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
      <BarDivider />
      <BarLabel>Selection</BarLabel>
      <BarValue>{named ?? 'nothing'}</BarValue>
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
              { value: 'fill', icon: 'fill', title: 'Fill: the connected flat under the press' },
            ]}
          />
          {params.selectFootprint === 'brush' ? <BarScrub label="Size" title="Brush size: drag to change, click to type" value={params.selectSize} min={1} max={12} onChange={(selectSize) => set({ selectSize })} /> : null}
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
          <IconSegmented
            value={params.selectCombine}
            onChange={(selectCombine) => set({ selectCombine })}
            options={[
              { value: 'replace', icon: 'replace', title: 'Replace the selection' },
              { value: 'add', icon: 'add', title: 'Add to the selection — holding shift does this too' },
              { value: 'subtract', icon: 'subtract', title: 'Take from the selection — holding alt does this too' },
              { value: 'intersect', icon: 'intersect', title: 'Keep only what both hold' },
            ]}
          />
          <BarDivider />
          <BarGroup>
            <Verb icon="expand" title="Grow the region by what is beside it" disabled={!held} onClick={() => onRegion('expand')} />
            <Verb icon="contract" title="Shrink the region by its rim" disabled={!held} onClick={() => onRegion('contract')} />
            <Verb icon="invert" title="Select everything else of the same kind, within the layer view" disabled={!held} onClick={() => onRegion('invert')} />
            {/* Move is designed (docs/design/terrain-tools-round) and is the next piece of the selection work. */}
            <Verb icon="move" title="Move the region — not built yet" disabled onClick={() => undefined} />
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
