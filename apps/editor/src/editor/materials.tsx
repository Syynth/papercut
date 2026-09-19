/**
 * What the rest of the editor needs of materials: the inspector's PICKER — the
 * project's list in priority order with a swatch from its art, click to make
 * one the brush's — and DELETING one, the one way, wherever it is offered. The
 * library itself is the Materials section of Project settings
 * (`materials-section.tsx`, decisions of 2026-09-19).
 *
 * This is the app's rather than the terrain feature's because the swatches
 * need pixels: the loaded terrain sets live on the viewport actor, which no
 * feature package holds. Every edit is one `project.materials.set` with the
 * whole list, because the list's order is the materials' priority.
 */

import { useState, useSyncExternalStore, type ReactNode } from 'react'

import { materialById, materialOfTag, slotMaterial, tagOf, type MaterialDef, type ReadonlyMapDoc, type ReadonlyProjectDoc } from '@papercut/document'
import { useDocumentSelector, useHost, useProject, type SettingsSection } from '@papercut/editor-host'
import { templateTags, type LoadedSet } from '@papercut/geometry'
import { Action, Actions, Dialog, Field, Item, List, Note, Section, Select } from '@papercut/ui'

import { run } from './commands'
import { findTile } from './coverage'
import { tileUrl } from './preview'
import { repaintAndDeleteMaterial, resyncTerrainSets, type Session } from './session'

/** The swatch a material shows: its own solid tile, or nothing when nobody has drawn one. */
export function swatchFor(sets: readonly LoadedSet[], material: number): string | undefined {
  const found = findTile(sets, templateTags(15, null, tagOf(material)))
  return found === null ? undefined : `url(${tileUrl(found.loaded, found.index)}) center / cover`
}

const cssColor = (color: number): string => `#${color.toString(16).padStart(6, '0')}`
const materialsOf = (project: ReadonlyProjectDoc): readonly MaterialDef[] => project.materials
const imagesOf = (project: ReadonlyProjectDoc): ReadonlyProjectDoc['images'] => project.images

/** How many tiles across the project's images carry a tag naming the material: what deleting it clears. */
function tilesTagged(images: ReadonlyProjectDoc['images'], id: number): number {
  let n = 0
  for (const image of images) for (const tags of Object.values(image.terrain.tiles)) if (tags.some((tag) => materialOfTag(tag) === id)) n++
  return n
}

/** How many faces of the open map hold each material on any material layer, by id. Walks every face, so it is selected settled. */
function usage(doc: ReadonlyMapDoc): Record<number, number> {
  const counts: Record<number, number> = {}
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (!s || s.kind !== 'voxel') continue
    for (const stack of Object.values(s.paint.faces)) {
      for (const m of new Set(stack.map(slotMaterial))) if (m !== null) counts[m] = (counts[m] ?? 0) + 1
    }
  }
  return counts
}

const sameCounts = (a: Record<number, number>, b: Record<number, number>): boolean => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[Number(k)] === b[Number(k)])
}

/**
 * Deleting a material, the one way, wherever it is offered — the Materials page and the tagger (ruling of
 * 2026-09-19). Any material can go, the last one included. One a map paints with asks what to repaint with, or
 * whether to leave those faces unpainted; one nothing paints with goes at once. Its tags go with it either way,
 * cleared by the host. `onDeleted` gets the id to select next, or -1 when none is left.
 */
export function useDeleteMaterial(session: Session, onDeleted: (next: number) => void): { remove: (id: number) => void; mapsUsing: (id: number) => number; dialog: ReactNode } {
  const host = useHost()
  const materials = useProject(materialsOf)
  const images = useProject(imagesOf)
  const counts = useDocumentSelector(usage, { equal: sameCounts, settled: true })
  const summaries = useSyncExternalStore(session.summaries.subscribe, session.summaries.get)
  const currentMap = host.children.project.getSnapshot().context.map
  // The open map is counted from the document, since its paint may not be on disk yet; the others from their files.
  const mapsUsing = (id: number): number => summaries.filter((s) => (s.path === currentMap ? (counts[id] ?? 0) > 0 : s.materials.has(id))).length
  const [deleting, setDeleting] = useState<{ from: MaterialDef; to: number | null } | null>(null)
  const notify = (notice: string): void => void run(host, 'view.set', { notice })
  const remove = (id: number): void => {
    const material = materialById(materials, id)
    if (!material) return
    const next = materials.find((m) => m.id !== id)?.id ?? -1
    if (mapsUsing(id) > 0) {
      setDeleting({ from: material, to: next === -1 ? null : next })
      return
    }
    const tagged = tilesTagged(images, id)
    run(host, 'project.materials.set', { materials: materials.filter((m) => m.id !== id).map((m) => ({ ...m })) })
    // Its tags went with it (in the host); the loaded sets follow, so the map and the tagger stop drawing them.
    if (tagged > 0) resyncTerrainSets(host)
    onDeleted(next)
    notify(tagged > 0 ? `${material.name} deleted; its tags on ${tagged} ${tagged === 1 ? 'tile' : 'tiles'} are cleared` : `${material.name} deleted`)
  }
  const dialog = deleting ? (
    <Dialog
      opened
      onClose={() => setDeleting(null)}
      title={`Delete ${deleting.from.name}`}
      description={`${mapsUsing(deleting.from.id)} ${mapsUsing(deleting.from.id) === 1 ? 'map paints' : 'maps paint'} with it. Everything made of it is repainted as whatever you pick — or left unpainted — in every map, and that cannot be undone beyond this map's history.${tilesTagged(images, deleting.from.id) > 0 ? ` Its tags on ${tilesTagged(images, deleting.from.id)} tiles are cleared.` : ''}`}
      width={460}
      footer={
        <>
          <Action title="Cancel" onClick={() => setDeleting(null)} />
          <Action
            title="Repaint and delete"
            tone="danger"
            onClick={() => {
              const { from, to } = deleting
              setDeleting(null)
              repaintAndDeleteMaterial(host, session, from.id, to)
                .then(() => {
                  onDeleted(to ?? -1)
                  notify(to === null ? `${from.name} deleted; everything it painted is unpainted` : `${from.name} deleted; everything it painted is now ${materialById(materials, to)?.name ?? 'another material'}`)
                })
                .catch((error: unknown) => notify(error instanceof Error ? error.message : String(error)))
            }}
          />
        </>
      }
    >
      <Field label="Repaint as">
        <Select
          value={deleting.to === null ? '' : String(deleting.to)}
          options={[...materials.filter((m) => m.id !== deleting.from.id).map((m) => ({ value: String(m.id), label: m.name })), { value: '', label: 'Nothing — leave those faces unpainted' }]}
          onChange={(value) => setDeleting({ ...deleting, to: value === '' ? null : Number(value) })}
        />
      </Field>
    </Dialog>
  ) : null
  return { remove, mapsUsing, dialog }
}

/** The inspector's picker. `active` is the active material's ID, what the brush paints and what a face's layers hold — never a position in the list. */
export function MaterialsPicker({ active, sets }: { active: number; sets: readonly LoadedSet[] }) {
  const host = useHost()
  const materials = useProject(materialsOf)
  const counts = useDocumentSelector(usage, { equal: sameCounts, settled: true })
  const material = materialById(materials, active)
  const select = (id: number): void => void run(host, 'terrain.params', { material: id })
  const openSettings = (section: SettingsSection): void => void run(host, 'view.set', { settings: section })
  return (
    <Section title="Materials" summary={material ? `${materials.length} · ${material.name}` : materials.length}>
      <List>
        {[...materials].reverse().map((m) => (
          <Item key={m.id} name={m.name} meta={counts[m.id] ?? 0} swatch={swatchFor(sets, m.id) ?? cssColor(m.color)} active={m.id === active} onClick={() => select(m.id)} />
        ))}
      </List>
      <Note>The project's library, shared by every map in it. Which material draws over which is the material layer each is painted on.</Note>
      <Actions>
        <Action title="Edit in Project settings…" onClick={() => openSettings('materials')} />
      </Actions>
    </Section>
  )
}
