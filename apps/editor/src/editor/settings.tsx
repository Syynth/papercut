/**
 * Project settings (design of 2026-09-14, after brink's settings modal): a
 * rail of sections, one at a time. What is here is the project's — written
 * to `papercut.json` and shared with everyone who opens the folder — which
 * is what the scope switch says; app-scoped settings arrive with the first
 * setting that is the machine's rather than the project's.
 *
 * Which section is open is view state (`view.set { settings }`), so the
 * menu, the chord and an inspector's "Edit in Project settings…" all open
 * the same modal the same way.
 */

import { useState } from 'react'

import { useHost, useProject, useProjectSelector, useViewSelector, useViewportSelector, type SettingsSection } from '@papercut/editor-host'
import { chordFor, commands, keymap, type Platform } from '@papercut/registry'
import { Action, Field, FieldGrid, Kbd, Note, NumberInput, Row, Segmented, SettingsBlock, SettingsDialog, SettingsRailItem, SettingsRailNote, SettingsScope, SettingsSearch, Status, Table, TableRow, TextInput, Toggle } from '@papercut/ui'
import type { IconName } from '@papercut/ui'

import { useArt } from './art'
import { run } from './commands'
import { ImagesSettings } from './images'
import { MaterialsSettings } from './materials'
import { TerrainsSettings } from './terrains'
import { CameraRigProperties } from './panels'
import { loadPrefs, savePrefs, type EditorPrefs } from './prefs'
import { newMapIn, openMapAt, revealInFolder, type Session } from './session'

type Scope = 'project' | 'app'

const SECTIONS: ReadonlyArray<{ id: SettingsSection; title: string; icon: IconName; scope: Scope; keywords: string }> = [
  { id: 'general', title: 'General', icon: 'rect', scope: 'project', keywords: 'name folder maps order' },
  { id: 'resolution', title: 'Resolution', icon: 'grid', scope: 'project', keywords: 'texel density pixels per tile filtering nearest linear' },
  { id: 'images', title: 'Images', icon: 'tile', scope: 'project', keywords: 'library tileset sprites textures png grid tile size margin spacing import missing relink replace reveal' },
  { id: 'terrains', title: 'Terrain sets', icon: 'terrain', scope: 'project', keywords: 'sidecar tags corners transitions author edge set pairs tag paint image tiled' },
  { id: 'materials', title: 'Materials', icon: 'sculpt', scope: 'project', keywords: 'brush paint library priority top side role swatch delete repaint' },
  { id: 'camera', title: 'Camera rig', icon: 'camera', scope: 'project', keywords: 'yaw pitch fov bounds projection orthographic' },
  { id: 'editor', title: 'Editor', icon: 'grid', scope: 'app', keywords: 'grid missing marks projection defaults autosave' },
  { id: 'keymap', title: 'Keymap', icon: 'select', scope: 'app', keywords: 'shortcuts keys chords bindings' },
]

const matches = (section: (typeof SECTIONS)[number], query: string): boolean => {
  const q = query.trim().toLowerCase()
  return q === '' || section.title.toLowerCase().includes(q) || section.keywords.includes(q)
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function ProjectSettings({ session, platform }: { session: Session; platform: Platform }) {
  const host = useHost()
  const section = useViewSelector((snapshot) => snapshot.context.settings)
  const project = useProject((p) => p)
  const missing = useViewportSelector((snapshot) => snapshot.context.terrainWarning)
  const [selectedMaterial, setSelectedMaterial] = useState(0)
  const [selectedSheet, setSelectedSheet] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const art = useArt()
  const open = (next: SettingsSection): void => void run(host, 'view.set', { settings: next })
  const close = (): void => void run(host, 'view.set', { settings: null })
  const current = SECTIONS.find((s) => s.id === section)
  const scope: Scope = current?.scope ?? 'project'
  const shown = SECTIONS.filter((s) => matches(s, query))
  // A search that crosses scopes shows the other scope's hits too, marked; otherwise the rail is the active scope's.
  const searching = query.trim() !== ''
  const listed = searching ? shown : shown.filter((s) => s.scope === scope)
  const missingCount = missing ? missing.split('\n').length : 0
  const aside: Record<SettingsSection, string> = {
    general: `${project.maps.length} ${project.maps.length === 1 ? 'map' : 'maps'}`,
    resolution: `${project.resolution.texelDensity} px · ${project.resolution.filtering}`,
    images: `${project.images.length} ${project.images.length === 1 ? 'image' : 'images'}${missingCount ? ` · ${missingCount} with a problem` : ''}`,
    terrains: `${art.loadedTerrain.length} ${art.loadedTerrain.length === 1 ? 'set' : 'sets'} · ${art.loadedTerrain.reduce((n, s) => n + s.set.terrains.length, 0)} terrains`,
    materials: `${project.materials.length} materials · priority top to bottom`,
    camera: `${project.camera.projection} · ${project.camera.fov}°`,
    editor: 'This machine',
    keymap: `${keymap.all().length} bindings`,
  }

  return (
    <SettingsDialog
      opened={section !== null}
      onClose={close}
      title={current?.title ?? ''}
      wide={section === 'terrains' || section === 'images'}
      aside={<span>{section ? aside[section] : ''}</span>}
      rail={
        <>
          <SettingsScope scopes={[{ id: 'project', label: 'Project' }, { id: 'app', label: 'App' }]} active={scope} onChange={(next) => open(next === 'app' ? 'editor' : 'general')} />
          <SettingsRailNote>{scope === 'project' ? `Written to papercut.json — shared with everyone who opens ${project.name}.` : 'Yours, on this machine — they follow you between projects.'}</SettingsRailNote>
          <SettingsSearch value={query} onChange={setQuery} />
          {listed.map((s) => (
            <SettingsRailItem key={s.id} icon={s.icon} title={searching && s.scope !== scope ? `${s.title} · ${s.scope}` : s.title} active={s.id === section} onClick={() => open(s.id)} />
          ))}
          {listed.length === 0 ? <SettingsRailNote>Nothing matches.</SettingsRailNote> : null}
        </>
      }
    >
      {section === 'general' ? <GeneralSettings session={session} /> : null}
      {section === 'resolution' ? <ResolutionSettings /> : null}
      {section === 'images' ? <ImagesSettings session={session} sets={art.loadedTerrain} warning={art.terrainWarning} selected={selectedSheet} onSelect={setSelectedSheet} /> : null}
      {section === 'terrains' ? <TerrainsSettings session={session} sets={art.loadedTerrain} /> : null}
      {section === 'materials' ? <MaterialsSettings session={session} selected={selectedMaterial} onSelect={setSelectedMaterial} sets={art.terrain} /> : null}
      {section === 'camera' ? <CameraSettings /> : null}
      {section === 'editor' ? <EditorSettings /> : null}
      {section === 'keymap' ? <KeymapSettings platform={platform} /> : null}
    </SettingsDialog>
  )
}

// --- General ------------------------------------------------------------------

const mapLabel = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.map\.json$/, '')

function GeneralSettings({ session }: { session: Session }) {
  const host = useHost()
  const project = useProject((p) => p)
  const folder = useProjectSelector((snapshot) => snapshot.context.folder)
  const current = useProjectSelector((snapshot) => snapshot.context.map)
  const [newName, setNewName] = useState('')
  const notify = (notice: string): void => void run(host, 'view.set', { notice })
  const setMaps = (maps: readonly string[]): void => void run(host, 'project.maps.set', { maps: [...maps] })
  const move = (path: string, by: number): void => {
    const at = project.maps.indexOf(path)
    const to = at + by
    if (at < 0 || to < 0 || to >= project.maps.length) return
    const next = [...project.maps]
    next.splice(at, 1)
    next.splice(to, 0, path)
    setMaps(next)
  }
  return (
    <>
      <SettingsBlock title="Project">
        <FieldGrid>
          <Field label="Name">
            <TextInput value={project.name} onChange={(value) => (value.trim() ? run(host, 'project.set', { name: value }) : undefined)} />
          </Field>
          <Field label="Folder">
            <Row label="" value={folder ?? '—'} muted>
              {session.dialogs ? <Action title="Reveal in Finder" onClick={() => void revealInFolder(host, 'papercut.json').catch((error: unknown) => notify(messageOf(error)))} /> : null}
            </Row>
          </Field>
        </FieldGrid>
      </SettingsBlock>
      <SettingsBlock
        title="Maps"
        note="In the order the project shows them. Removing a map from the list leaves its file in the folder."
        action={
          <>
            <TextInput value={newName} onChange={setNewName} placeholder="New map name" />
            <Action
              title="Add map"
              disabled={!newName.trim()}
              onClick={() => {
                const mapName = newName.trim()
                setNewName('')
                newMapIn(host, session, mapName).catch((error: unknown) => notify(messageOf(error)))
              }}
            />
          </>
        }
      >
        <Table
          columns={[
            { title: 'Map', width: '1.4fr' },
            { title: 'File', width: '1.6fr' },
            { title: '', width: 'max-content' },
          ]}
        >
          {project.maps.map((path, index) => (
            <TableRow
              key={path}
              active={path === current}
              cells={[
                <>
                  {mapLabel(path)}
                  {path === current ? <Status tone="accent">open</Status> : null}
                </>,
                <code>{path}</code>,
                <>
                  <Action title="Open" disabled={path === current} onClick={() => void openMapAt(host, session, path).catch((error: unknown) => notify(messageOf(error)))} />
                  <Action title="↑" disabled={index === 0} onClick={() => move(path, -1)} />
                  <Action title="↓" disabled={index === project.maps.length - 1} onClick={() => move(path, 1)} />
                  <Action title="Remove" tone="danger" disabled={path === current || project.maps.length <= 1} onClick={() => setMaps(project.maps.filter((m) => m !== path))} />
                </>,
              ]}
            />
          ))}
        </Table>
      </SettingsBlock>
    </>
  )
}

// --- Resolution ---------------------------------------------------------------

const DENSITIES = [8, 16, 32, 64]

/**
 * The density is APPLIED, not typed live: changing it regenerates the placeholder art at the new size, re-cuts
 * every image along its grid and remeshes the map — a project-wide event, as the design said, not a field to
 * scrub through. An image's tile size has to divide the density (ruling of 2026-09-17), so a change can leave one
 * undrawable; the count says how many before it is applied.
 */
function ResolutionSettings() {
  const host = useHost()
  const resolution = useProject((p) => p.resolution)
  const images = useProject((p) => p.images)
  const [pending, setPending] = useState(resolution.texelDensity)
  const set = (changes: Partial<typeof resolution>): void => void run(host, 'project.set', { resolution: { ...resolution, ...changes } })
  const mismatched = images.filter((i) => pending % i.grid.tile !== 0).length
  return (
    <SettingsBlock title="Resolution profile" note="Pixels per tile, and how textures sample. Every image is cut along its own grid and scaled by a whole number to this; an image whose tile size does not divide it is reported in Images, never resampled.">
      <FieldGrid>
        <Field label="Texel density" hint="Applied when you say so: it redraws the placeholder art and remeshes the map">
          <Segmented value={DENSITIES.includes(pending) ? pending : 0} options={[...DENSITIES.map((d) => ({ value: d, label: `${d} px` })), { value: 0, label: 'Custom' }]} onChange={(d) => (d > 0 ? setPending(d) : undefined)} />
        </Field>
        <Field label="Custom" hint="Any whole number of pixels per tile">
          <NumberInput value={pending} min={1} max={256} onChange={setPending} />
        </Field>
        <Field label=" ">
          <Action title={pending === resolution.texelDensity ? 'Applied' : `Apply ${pending} px`} tone="accent" disabled={pending === resolution.texelDensity || pending < 1} onClick={() => set({ texelDensity: pending })} />
        </Field>
        <Field label="Filtering" hint="Nearest for pixel art; linear for high-resolution art">
          <Segmented
            value={resolution.filtering}
            options={[
              { value: 'nearest', label: 'Nearest' },
              { value: 'linear', label: 'Linear' },
            ]}
            onChange={(filtering) => set({ filtering })}
          />
        </Field>
      </FieldGrid>
      {pending !== resolution.texelDensity ? <Note tone={mismatched ? 'warn' : 'info'}>{mismatched ? `${mismatched} of the project's images ${mismatched === 1 ? 'has a tile size that does' : 'have tile sizes that do'} not divide ${pending} px and would stop drawing until regridded in Images.` : `Every image's tile size divides ${pending} px.`}</Note> : null}
    </SettingsBlock>
  )
}

// --- Camera rig ---------------------------------------------------------------

function CameraSettings() {
  const host = useHost()
  const camera = useProject((p) => p.camera)
  return (
    <SettingsBlock title="The rig every new map starts from" note="A map keeps its own rig once it exists; this is the default a new map is given. The game's camera bounds ship in the export.">
      <CameraRigProperties rig={camera} onChange={(changes) => run(host, 'project.set', { camera: { ...camera, ...changes, bounds: { ...camera.bounds, ...(changes.bounds ?? {}) } } })} />
    </SettingsBlock>
  )
}

// --- App: Editor -----------------------------------------------------------------

function EditorSettings() {
  const host = useHost()
  const [prefs, setPrefs] = useState(loadPrefs)
  const change = (changes: Partial<EditorPrefs>): void => {
    const next = { ...prefs, ...changes }
    setPrefs(next)
    savePrefs(next)
    // The preference is also the view, now: what a project opens with is what this one shows.
    run(host, 'view.set', changes)
  }
  return (
    <SettingsBlock title="When a project opens" note="Yours, on this machine. Each of these is also the view's own toggle; setting it here makes it the default every project opens with.">
      <Row label="Grid">
        <Toggle checked={prefs.showGrid} onChange={(showGrid) => change({ showGrid })} />
      </Row>
      <Row label="Marks on corners still to author">
        <Toggle checked={prefs.showMissing} onChange={(showMissing) => change({ showMissing })} />
      </Row>
      <Field label="Editor camera" hint="How the free camera projects; the game's rig has its own">
        <Segmented
          value={prefs.projection}
          options={[
            { value: 'perspective', label: 'Perspective' },
            { value: 'orthographic', label: 'Orthographic' },
          ]}
          onChange={(projection) => change({ projection })}
        />
      </Field>
    </SettingsBlock>
  )
}

// --- App: Keymap -----------------------------------------------------------------

function KeymapSettings({ platform }: { platform: Platform }) {
  const bindings = keymap.all().filter((b) => b.command !== null && !b.unbind)
  const titleOf = (id: string): string => commands.get(id)?.title ?? id
  const argsOf = (args: unknown): string => (args && typeof args === 'object' && Object.keys(args).length ? Object.entries(args).map(([k, v]) => `${k}: ${String(v)}`).join(', ') : '')
  return (
    <SettingsBlock title="Every binding" note="As declared by the editor and its features. Rebinding from here is a follow-up; a binding lower in the list wins over one above it on the same chord.">
      <Table
        columns={[
          { title: 'Chord', width: '0.8fr' },
          { title: 'Command', width: '1.4fr' },
          { title: 'Arguments', width: '1.2fr' },
          { title: 'Layer', width: '0.6fr' },
        ]}
      >
        {bindings.map((b, index) => (
          <TableRow
            key={`${b.chord}-${index}`}
            cells={[<Kbd>{chordFor(b.command as string, b.args, platform) ?? b.chord}</Kbd>, titleOf(b.command as string), <Status tone="muted">{argsOf(b.args)}</Status>, b.weight ?? 'feature']}
          />
        ))}
      </Table>
    </SettingsBlock>
  )
}
