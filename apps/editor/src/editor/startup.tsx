/**
 * The startup screen and the New Project dialog (design of 2026-09-14).
 *
 * Two doors and the recents. In the desktop app a folder comes from the
 * shell's native dialog, which is also what grants it; in a browser there is
 * no folder to pick, so Open… lists the projects in the memory tree and New
 * Project… takes a name and makes a folder for it under `/projects`.
 */

import { useEffect, useState } from 'react'

import { useHost, useViewSelector } from '@papercut/editor-host'
import { slugOf } from '@papercut/project'
import { Action, Checkbox, Dialog, DialogManifest, Door, Doors, ErrorLine, Field, NumberInput, RecentList, RecentRow, Segmented, StartupScreen, StartupSection, TextInput } from '@papercut/ui'

import { run } from './commands'
import { MEMORY_PROJECTS_DIR, createProjectAt, memoryProjects, openProjectAt, recents, reopenLast, setReopenLast, type Session } from './session'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A home folder path shortened the way a shell shows it. */
function shorten(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

export function Startup({ session }: { session: Session }) {
  const host = useHost()
  const [list, setList] = useState(recents)
  const [reopen, setReopen] = useState(reopenLast)
  const [error, setError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState<Array<{ folder: string; name: string }> | null>(null)

  const open = async (folder: string): Promise<void> => {
    setError(null)
    try {
      await openProjectAt(host, session, folder)
    } catch (caught) {
      setError(messageOf(caught))
      setList(recents())
    }
  }

  const onOpen = async (): Promise<void> => {
    if (session.dialogs) {
      const folder = await session.dialogs.openFolder({ title: 'Open a project folder' })
      if (folder) await open(folder)
    } else {
      setChoosing(await memoryProjects(session))
    }
  }

  return (
    <StartupScreen name="papercut" tagline="Open a project to begin.">
      <Doors>
        <Door tone="ok" title="New Project…" body="Pick a folder — your art can already be in it. Creates papercut.json and the placeholder sheet." onClick={() => run(host, 'view.set', { dialog: 'new-project' })} />
        <Door tone="accent" title="Open…" body="Open a project folder — the one papercut.json sits in." onClick={() => void onOpen()} />
      </Doors>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <StartupSection label="Recent">
        <RecentList empty="No recent projects yet — anything you open shows up here.">
          {list.map((r) => (
            <RecentRow key={r.folder} name={r.name} path={shorten(r.folder)} onClick={() => void open(r.folder)} />
          ))}
        </RecentList>
      </StartupSection>
      <Checkbox
        checked={reopen}
        onChange={(on) => {
          setReopen(on)
          setReopenLast(on)
        }}
      >
        Reopen last project on launch
      </Checkbox>
      <Dialog opened={choosing !== null} onClose={() => setChoosing(null)} title="Open a project" description="The projects this browser holds. The desktop app opens any folder.">
        <RecentList empty="No projects here yet.">
          {(choosing ?? []).map((p) => (
            <RecentRow
              key={p.folder}
              name={p.name}
              path={p.folder}
              onClick={() => {
                setChoosing(null)
                void open(p.folder)
              }}
            />
          ))}
        </RecentList>
      </Dialog>
    </StartupScreen>
  )
}

const DENSITIES = [
  { value: 16, label: '16 px' },
  { value: 32, label: '32 px' },
  { value: 0, label: 'Custom' },
]

/** The New Project dialog, open while the view's dialog is `new-project`: from the startup door, the project menu or the shell's menu. */
export function NewProjectDialog({ session }: { session: Session }) {
  const host = useHost()
  const opened = useViewSelector((snapshot) => snapshot.context.dialog) === 'new-project'
  const onClose = (): void => run(host, 'view.set', { dialog: null })
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [texelDensity, setDensity] = useState(16)
  const [custom, setCustom] = useState(false)
  // Both off by default (rulings of 2026-09-19): a project is set up around its own art, and its maps come after.
  const [firstMap, setFirstMap] = useState(false)
  const [placeholder, setPlaceholder] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // In a browser the folder follows the name; a shell folder is chosen.
  const memory = session.dialogs === null
  const target = memory ? `${MEMORY_PROJECTS_DIR}/${slugOf(name || 'untitled')}` : folder

  useEffect(() => {
    if (!opened) return
    setError(null)
    setName('')
    setFolder('')
  }, [opened])

  const choose = async (): Promise<void> => {
    if (!session.dialogs) return
    const picked = await session.dialogs.openFolder({ title: 'Where the project folder goes' })
    if (picked) setFolder(picked)
  }

  const create = async (): Promise<void> => {
    if (!name.trim() || !target) return
    setBusy(true)
    setError(null)
    try {
      await createProjectAt(host, session, { folder: target, name: name.trim(), texelDensity, firstMap, placeholder })
      onClose()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  const slug = slugOf(name || 'untitled')
  return (
    <Dialog
      opened={opened}
      onClose={onClose}
      title="New Project"
      description="Creates the project file in the folder you choose. Anything already there is left alone, and images under sheets/ are offered for listing."
      footer={
        <>
          <Action title="Cancel" onClick={onClose} />
          <Action title="Create Project" tone="accent" disabled={busy || !name.trim() || !target} onClick={() => void create()} />
        </>
      }
    >
      <Field label="Name">
        <TextInput value={name} onChange={setName} placeholder="Harbour Town" />
      </Field>
      <Field label="Location" hint={memory ? 'This browser keeps its projects in memory; the desktop app uses a folder on disk' : 'The folder the project is created in'}>
        {memory ? <TextInput value={target} onChange={() => undefined} /> : (
          <>
            <TextInput value={folder} onChange={setFolder} placeholder="Choose a folder…" />
            <Action title="Choose…" onClick={() => void choose()} />
          </>
        )}
      </Field>
      <Field label="Texel density" hint="Pixels per tile. Every sheet added to the project is checked against it; a mismatch is reported, never rescaled">
        <Segmented
          value={custom ? 0 : texelDensity}
          options={DENSITIES}
          onChange={(value) => {
            setCustom(value === 0)
            if (value > 0) setDensity(value)
          }}
        />
        {custom ? <NumberInput value={texelDensity} min={1} max={256} onChange={setDensity} /> : null}
      </Field>
      <Checkbox checked={firstMap} onChange={setFirstMap}>
        Start with an empty map
      </Checkbox>
      <Checkbox checked={placeholder} onChange={setPlaceholder}>
        Include the placeholder tileset, so the default materials draw with something
      </Checkbox>
      <DialogManifest
        title="Will create"
        rows={[
          { name: 'papercut.json', note: 'name, resolution profile, the sheet and material lists', tone: 'accent' },
          ...(firstMap ? [{ name: `maps/${slug}.map.json`, note: 'an empty 32 × 32 map, opened first' }] : []),
          ...(placeholder ? [{ name: 'sheets/ground.png', note: `the placeholder tileset at ${texelDensity} px, its terrain set in papercut.json, yours to replace`, tone: 'ok' as const }] : []),
        ]}
      />
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </Dialog>
  )
}
