/**
 * The stage while the project has no map open (ruling of 2026-09-19): the
 * project's maps to open, a door to a new one, and the map files in the folder
 * the project does not list, each with what its stamp says. Nothing here reads
 * the document, which is a placeholder until a map is opened.
 */

import { useSyncExternalStore } from 'react'

import { useHost, useProject } from '@papercut/editor-host'
import type { StrayMap } from '@papercut/project'
import { Door, Doors, RecentList, RecentRow, StartupScreen, StartupSection } from '@papercut/ui'

import { run } from './commands'
import { adoptMap, openMapAt, type Session } from './session'

const mapLabel = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.map\.json$/, '')
const nameOf = (p: { name: string }): string => p.name
const mapsOf = (p: { maps: readonly string[] }): readonly string[] => p.maps

/** What a stray's verdict says to the artist. */
export function strayNote(stray: StrayMap): string {
  switch (stray.verdict) {
    case 'ours':
      return 'this project’s, unlisted — add it'
    case 'foreign':
      return stray.project === null ? 'no project stamp — Import Map, coming, is the way in' : 'another project’s — Import Map, coming, is the way in'
    case 'unreadable':
      return `not a map: ${stray.reason ?? 'unreadable'}`
  }
}

/** What clicking a stray does: an unlisted map of this project's is listed and opened; anything else is explained. */
export function onStray(host: ReturnType<typeof useHost>, session: Session, stray: StrayMap): Promise<unknown> {
  if (stray.verdict === 'ours') return adoptMap(host, session, stray.path)
  run(host, 'view.set', { notice: `${stray.path}: ${strayNote(stray)}` })
  return Promise.resolve()
}

export function NoMapStage({ session }: { session: Session }) {
  const host = useHost()
  const project = useProject(nameOf)
  const maps = useProject(mapsOf)
  const strays = useSyncExternalStore(session.strays.subscribe, session.strays.get)
  const notify = (notice: string): void => run(host, 'view.set', { notice })
  const attempt = (work: Promise<unknown>): void => void work.catch((error: unknown) => notify(error instanceof Error ? error.message : String(error)))
  return (
    <StartupScreen name={project} tagline="No map is open.">
      <Doors>
        <Door tone="ok" title="New Map…" body="An empty 32 × 32 map, listed and opened." onClick={() => run(host, 'view.set', { dialog: 'new-map' })} />
        <Door tone="accent" title="Project Settings…" body="Images, terrain sets and materials: the setup a map is painted with." onClick={() => run(host, 'view.set', { settings: 'general' })} />
      </Doors>
      {maps.length > 0 ? (
        <StartupSection label="Maps">
          <RecentList empty="">
            {maps.map((path) => (
              <RecentRow key={path} name={mapLabel(path)} path={path} onClick={() => attempt(openMapAt(host, session, path))} />
            ))}
          </RecentList>
        </StartupSection>
      ) : null}
      {strays.length > 0 ? (
        <StartupSection label="In maps/, not listed">
          <RecentList empty="">
            {strays.map((stray) => (
              <RecentRow key={stray.path} name={stray.name ?? mapLabel(stray.path)} path={`${stray.path} · ${strayNote(stray)}`} onClick={() => attempt(onStray(host, session, stray))} />
            ))}
          </RecentList>
        </StartupSection>
      ) : null}
    </StartupScreen>
  )
}
