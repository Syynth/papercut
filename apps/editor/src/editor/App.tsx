/**
 * The editor: the startup screen until a project is open, then the frame
 * and its regions.
 *
 * A composition root and nothing else. Each region — top bar, rail, context
 * bar, stage, inspector, status bar — selects exactly what it shows from the
 * host's actors and the document, and dispatches its own commands, so a
 * change re-renders the regions that read it and no others. This component
 * re-renders only when a project opens or closes.
 *
 * It used to hold all of it: the hovered surface, the brush cells, the
 * camera, the frame stats, the document, and every callback, passed down as
 * props. Every pointer move and every tick of a drag re-rendered the whole
 * editor, which `pnpm perf` measured at 400 ms of script a second just for
 * moving the mouse (#131).
 */

import { Suspense, lazy, useEffect, useMemo } from 'react'

import { useHost, useProjectSelector } from '@papercut/editor-host'
import { Frame } from '@papercut/ui'

import { ContextBar } from './bars'
import { InspectorRegion } from './inspector'
import { detectPlatform, installKeyDispatcher } from './keys'
import { Rail } from './rail'
import { saveNow, type Session } from './session'
import { Stage } from './stage'
import { NewMapDialog } from './dialogs'
import { NoMapStage } from './nomap'
import { NewProjectDialog, Startup } from './startup'
import { StatusBar } from './status'
import { TopBar } from './top'

/**
 * The settings modal, on demand: it is a third of the editor's code — the
 * image library with its import and relink dialogs, the tagger, the material
 * library, the keymap table — and none of it is reachable until the modal is
 * opened, so it is a chunk of its own rather than a third of the entry
 * bundle. Not for first paint, which reads from local disk: an installed app
 * fetches its UI bundle file by content hash, so a change on either side of
 * this boundary re-ships only its own chunk. Nothing waits for it: the
 * fallback is nothing, and the modal renders when it arrives.
 */
const ProjectSettings = lazy(async () => ({ default: (await import('./settings')).ProjectSettings }))

/** How long the document has to sit still before it is written to its file. */
const AUTOSAVE_DELAY_MS = 1200

export default function App({ session }: { session: Session }) {
  // Built at the composition root (`main.tsx`), never here: the viewport is
  // handed `host.input` before React has rendered anything, and a host built
  // by a hook is rebuilt when React remounts.
  const host = useHost()
  const platform = useMemo(detectPlatform, [])
  const folder = useProjectSelector((snapshot) => snapshot.context.folder)
  // A project can be open with no map (ruling of 2026-09-19): the stage then offers its maps and a new one.
  const hasMap = useProjectSelector((snapshot) => snapshot.context.map !== null)

  // One listener for the whole editor, holding no key names: what is bound is
  // declared in `editor-host`'s keymap and resolved through the registry (#14).
  useEffect(() => installKeyDispatcher(host, { platform }), [host, platform])

  // Scripting hook: scripts/tour.mjs, probe.mjs and perf.mjs drive the real editor in a headless browser, and it is
  // handy from the console. Nothing in the app reads it (scripts/global.ts types it). Here rather than on the stage
  // because a project can be open with no map, and so no stage (ruling of 2026-09-19).
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__host = host
  }, [host])

  // Autosave, subscribed rather than rendered: a document change schedules a
  // write of the map file, it does not re-render anything. The project file
  // is written with it; a project edit alone is written on its own.
  //
  // A save still waiting out the delay is flushed on `pagehide` rather than
  // dropped: closing the window, or the desktop shell reloading into an
  // updated bundle, would otherwise lose the last edit made inside the delay.
  useEffect(() => {
    if (folder === null) return
    let pending: ReturnType<typeof setTimeout> | undefined
    let failing = false
    const save = (): void => {
      pending = undefined
      if (host.children.project.getSnapshot().context.folder === null) return
      saveNow(host, session)
        .then(() => {
          if (failing) host.dispatch('view.set', { notice: 'Saved' })
          failing = false
          if (session.persistFailure) {
            host.dispatch('view.set', { notice: session.persistFailure })
            session.persistFailure = null
          }
        })
        .catch((error: unknown) => {
          failing = true
          host.dispatch('view.set', { notice: `Not saved: ${error instanceof Error ? error.message : String(error)}` })
        })
    }
    const schedule = (): void => {
      clearTimeout(pending)
      pending = setTimeout(save, AUTOSAVE_DELAY_MS)
    }
    const unsubscribe = host.reader.subscribe(schedule)
    const project = host.children.project.subscribe(schedule)
    const flush = (): void => {
      if (pending === undefined) return
      clearTimeout(pending)
      save()
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      clearTimeout(pending)
      unsubscribe()
      project.unsubscribe()
    }
  }, [host, session, folder])

  if (folder === null) {
    return (
      <>
        <NewProjectDialog session={session} />
        <Startup session={session} />
      </>
    )
  }

  return (
    <>
      <NewProjectDialog session={session} />
      <NewMapDialog session={session} />
      <Suspense fallback={null}>
        <ProjectSettings session={session} platform={platform} />
      </Suspense>
      <Frame
        top={<TopBar platform={platform} session={session} />}
        rail={<Rail platform={platform} />}
        bar={<ContextBar platform={platform} />}
        stage={hasMap ? <Stage platform={platform} /> : <NoMapStage session={session} />}
        inspector={<InspectorRegion platform={platform} />}
        status={<StatusBar />}
      />
    </>
  )
}
