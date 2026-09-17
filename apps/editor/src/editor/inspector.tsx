/**
 * The inspector: a stack of collapsible sections, opened for what the active
 * tool cares about, with the level's own settings at the bottom behind the
 * rail's gear (2026-09-12 frame).
 *
 * Order is fixed and every section is always mounted, so an artist who folds
 * one finds it where they left it: what changes with the tool is the header
 * and which sections open by default. The three Level sections are the one
 * exception — the gear on the rail opens and closes them together.
 */

import { useMemo } from 'react'

import { materialById, type Atmosphere, type CameraRig, type DeepReadonly, type MapObject, type MaterialDef, type Placement, type ReadonlyMapDoc, type ReadonlyProjectDoc } from '@papercut/document'
import { useDocument, useHost, useProject, useToolsSelector, useViewSelector, type Selection } from '@papercut/editor-host'
import { mergeParams, type EditorParams } from './params'
import { chordFor, type Platform } from '@papercut/registry'
import { Action, Actions, InspectorHead, Note, Section } from '@papercut/ui'

import { useArt } from './art'
import { run, setParams } from './commands'
import type { LoadedSet } from '@papercut/geometry'

import { MaterialsPicker } from './materials'

import { FeaturePanels } from './bars'
import {
  AtmosphereProperties,
  CameraRigProperties,
  CoverageProperties,
  FacingProperties,
  ObjectProperties,
  OutlinerList,
  StructureProperties,
  useCoverageFlags,
} from './panels'

const TITLES: Record<string, string> = { select: 'Select', terrain: 'Terrain', object: 'Objects' }

const wholeDocument = (doc: ReadonlyMapDoc): ReadonlyMapDoc => doc
const materialsOf = (project: ReadonlyProjectDoc): readonly MaterialDef[] => project.materials

/**
 * The inspector as a region: it reads the document settled — once a stroke has closed, not on every tick of a drag — and
 * the tool parameters, selection, level toggle and last notice from their actors, and builds its own commands. Nothing
 * above it passes it state.
 */
export function InspectorRegion({ platform }: { platform: Platform }) {
  const host = useHost()
  const doc = useDocument(wholeDocument, { settled: true })
  const tools = useToolsSelector((snapshot) => snapshot.context)
  const params = useMemo(() => mergeParams(tools), [tools])
  const selection = useViewSelector((snapshot) => snapshot.context.selection)
  const levelOpen = useViewSelector((snapshot) => snapshot.context.levelOpen)
  const notice = useViewSelector((snapshot) => snapshot.context.notice)
  const art = useArt()
  const materials = useProject(materialsOf)

  const selected = selection?.kind === 'object' ? (doc.objects[selection.id] ?? null) : null
  const updateObject = (id: string, changes: Partial<MapObject>): void => run(host, 'objects.update', { id, changes })

  const onSettings = (): void => run(host, 'view.set', { settings: 'images' })

  return (
    <Inspector
      doc={doc}
      params={params}
      selection={selection}
      platform={platform}
      selected={selected}
      deleteKbd={chordFor('selection.delete', undefined, platform)}
      levelOpen={levelOpen}
      onLevelToggle={(open) => run(host, 'view.set', { levelOpen: open })}
      terrain={art.terrain}
      materials={materials}
      terrainWarning={art.terrainWarning}
      onSettings={onSettings}
      onSelect={(id) => {
        // Select an object from a list, and go to Select so the drag and the keys act on it.
        run(host, 'selection.set', { id })
        setParams(host, { tool: 'select' })
      }}
      onObject={(changes) => {
        if (selected) updateObject(selected.id, changes)
      }}
      onObjectChange={updateObject}
      onStructure={(id, changes) => {
        if (changes.name !== undefined) run(host, 'structure.rename', { id, name: changes.name })
        if (changes.placement !== undefined) run(host, 'structure.place', { id, placement: changes.placement })
      }}
      onDelete={() => run(host, 'selection.delete')}
      onRig={(changes) => run(host, 'camera.set', changes)}
      onAtmosphere={(changes) => run(host, 'atmosphere.set', changes)}
      onFix={(id) => updateObject(id, { display: 'billboardY' })}
      message={notice}
    />
  )
}

export function Inspector({
  doc,
  params,
  platform,
  selection,
  selected,
  deleteKbd,
  levelOpen,
  onLevelToggle,
  terrain,
  materials,
  terrainWarning,
  onSettings,
  onSelect,
  onObject,
  onObjectChange,
  onStructure,
  onDelete,
  onRig,
  onAtmosphere,
  onFix,
  message,
}: {
  doc: ReadonlyMapDoc
  params: EditorParams
  platform: Platform
  selection: Selection | null
  selected: DeepReadonly<MapObject> | null
  deleteKbd?: string
  levelOpen: boolean
  onLevelToggle: (open: boolean) => void
  /** The terrain sets the map draws from, for the material swatches. */
  terrain: readonly LoadedSet[]
  /** The project's material library, for the chips and the terrain-set summary. */
  materials: readonly MaterialDef[]
  terrainWarning: string | null
  /** Open the Project settings on Sheets. */
  onSettings: () => void
  /** Select an object by id, from the outliner or the coverage list. */
  onSelect: (id: string) => void
  /** A change to the selected object. */
  onObject: (changes: Partial<MapObject>) => void
  /** A change to any object by id. */
  onObjectChange: (id: string, changes: Partial<MapObject>) => void
  /** A change to a structure's name or placement, by id. */
  onStructure: (id: string, changes: { name?: string; placement?: Placement }) => void
  onDelete: () => void
  onRig: (changes: Partial<CameraRig>) => void
  onAtmosphere: (changes: Partial<Atmosphere>) => void
  onFix: (id: string) => void
  message: string | null
}) {
  const flags = useCoverageFlags(levelOpen)
  const structure = selection?.kind === 'structure' ? doc.structures[selection.id] ?? null : null
  const isTerrain = params.tool === 'terrain'

  return (
    <>
      <InspectorHead>{TITLES[params.tool] ?? params.tool}</InspectorHead>

      <Section title="Selection" summary={selected ? selected.name : structure ? structure.name : 'empty'} accent={selected !== null || structure !== null} defaultOpen>
        {selected ? (
          <ObjectProperties object={selected} deleteKbd={deleteKbd} onChange={onObject} onDelete={onDelete} />
        ) : structure ? (
          <StructureProperties doc={doc} structure={structure} deleteKbd={deleteKbd} onChange={(changes) => onStructure(structure.id, changes)} onDelete={onDelete} />
        ) : (
          <Note>Nothing selected. Click anything with Select: an object, a sketch, the ground.</Note>
        )}
      </Section>

      {selected ? (
        <Section title="Facing & flip" summary={`${selected.facing.facings} facing${selected.facing.facings === 1 ? '' : 's'}`} defaultOpen={false}>
          <FacingProperties object={selected} onChange={onObject} />
        </Section>
      ) : null}

      {isTerrain ? (
        <Section title={params.terrainMode === 'sculpt' ? 'Sculpt' : 'Paint'} summary={params.terrainMode === 'sculpt' && params.sculptVerb === 'ramp' ? 'ramp' : `${params.brush.size} · ${params.brush.shape}`}>
          <FeaturePanels slot="inspector" tool={params.tool} doc={doc} materials={materials} params={params} platform={platform} selection={selection} />
        </Section>
      ) : null}
      {isTerrain ? <MaterialsPicker active={params.material} sets={terrain} /> : null}

      {isTerrain ? (
        <Section title="Terrain sets" summary={materialById(materials, params.material)?.top.sheet ?? '—'} defaultOpen={false}>
          <Note>Every material draws from a terrain set: a sheet and the sidecar that tags its tiles. The project's sheets are managed in Project settings.</Note>
          {terrainWarning ? <Note tone="warn">{terrainWarning}</Note> : null}
          <Actions>
            <Action title="Sheets…" onClick={onSettings} />
          </Actions>
        </Section>
      ) : null}

      <Section title="Objects" summary={doc.objectOrder.length} defaultOpen={params.tool !== 'terrain'}>
        <OutlinerList doc={doc} selectedId={selected?.id ?? null} onSelect={onSelect} onChange={onObjectChange} />
      </Section>

      <Section title="Camera rig" summary={`${Math.abs(doc.camera.bounds.yawMax - doc.camera.bounds.yawMin)}° yaw`} open={levelOpen} onToggle={onLevelToggle}>
        <CameraRigProperties rig={doc.camera} onChange={onRig} />
      </Section>

      <Section title="Atmosphere" summary={doc.atmosphere.preset} open={levelOpen} onToggle={onLevelToggle}>
        <AtmosphereProperties atmosphere={doc.atmosphere} onChange={onAtmosphere} />
      </Section>

      <Section title="Coverage" summary={flags === null ? undefined : flags === 0 ? 'clean' : `${flags} flagged`} accent={flags !== null && flags > 0} open={levelOpen} onToggle={onLevelToggle}>
        {levelOpen ? <CoverageProperties onSelect={onSelect} onFix={onFix} /> : null}
      </Section>

      {message ? (
        <Section title="Last action" defaultOpen>
          <Note>{message}</Note>
        </Section>
      ) : null}
    </>
  )
}
