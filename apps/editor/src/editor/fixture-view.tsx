/**
 * The Materials section's 3D view, as React sees it: a canvas, and the
 * imperative `FixtureView` that owns it. The scene is built the first time
 * the view is opened and thrown away when it closes; while it is open, a new
 * subject is a new fixture and new art is a new look.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import type { MaterialDef, ReadonlyProjectDoc } from '@papercut/document'
import { useProject } from '@papercut/editor-host'
import type { LoadedSet } from '@papercut/geometry'
import type { SceneAssets } from '@papercut/runtime'
import { FixtureView } from '@papercut/viewport'

import { useArt } from './art'
import { fixtureFor } from './fixture'

const materialsOf = (project: ReadonlyProjectDoc): readonly MaterialDef[] => project.materials
const filteringOf = (project: ReadonlyProjectDoc): 'nearest' | 'linear' => project.resolution.filtering

export function Fixture({ material, other, sets, fallback, onMissing }: { material: number; other: number | null; sets: readonly LoadedSet[]; fallback: number | undefined; /** What no tile answers on the fixture, named once each. Must be stable: it is called whenever the scene is rebuilt. */ onMissing: (missing: readonly string[]) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  /** The view, held outside React's refs so the unmount below can dispose of exactly the one that was made. */
  const [holder] = useState<{ view: FixtureView | null }>(() => ({ view: null }))
  const materials = useProject(materialsOf)
  const filtering = useProject(filteringOf)
  const art = useArt()
  const [failed, setFailed] = useState<string | null>(null)

  const doc = useMemo(() => fixtureFor({ material, other }), [material, other])
  const assets = useMemo((): SceneAssets => ({ terrain: [...sets], materials, filtering, fallback, sprites: art.sprites, textures: art.textures }), [sets, materials, filtering, fallback, art.sprites, art.textures])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    try {
      if (holder.view) {
        holder.view.setDocument(doc)
        holder.view.setAssets(assets)
      } else holder.view = new FixtureView(canvas, doc, assets)
      onMissing(holder.view.missing())
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    }
  }, [holder, doc, assets, onMissing])

  useEffect(
    () => () => {
      holder.view?.dispose()
      holder.view = null
    },
    [holder],
  )

  if (failed) return <p className="ui-note is-warn">The 3D view could not start: {failed}</p>
  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none', cursor: 'grab' }} />
}
