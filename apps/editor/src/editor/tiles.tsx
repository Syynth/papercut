/**
 * The Tiles section (ruling of 2026-09-18): the sheet the Tiles verb pastes
 * from, and the rectangle of it picked as the stamp. Drag across the sheet to
 * pick; the stamp's top-left lands on the face pressed.
 *
 * It is the app's rather than the terrain feature's for the reason the
 * Materials section is: it draws the loaded sheets, which no feature holds.
 * Only a sheet the project lists and that loaded at the profile's tile size is
 * offered — the atlas takes no other.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'

import { useHost, useProject } from '@papercut/editor-host'
import type { TerrainParams } from '@papercut/feature-terrain'
import type { LoadedSet } from '@papercut/geometry'
import type { ReadonlyProjectDoc } from '@papercut/document'
import { Field, Note, Section, Select } from '@papercut/ui'

import { run } from './commands'
import { rgbaToCanvas } from './rgba'

const imagesOf = (project: ReadonlyProjectDoc) => project.images

type Tile = readonly [column: number, row: number]

export function TilesPicker({ stamp, sets }: { stamp: TerrainParams['stamp']; sets: readonly LoadedSet[] }) {
  const host = useHost()
  const images = useProject(imagesOf)
  const sheets = useMemo(() => sets.filter((s): s is LoadedSet & { imageId: number } => s.imageId !== undefined), [sets])
  const nameOf = (id: number): string => images.find((i) => i.id === id)?.name ?? `Image ${id}`
  const [chosen, setChosen] = useState<number | null>(stamp?.image ?? sheets[0]?.imageId ?? null)
  const sheet = sheets.find((s) => s.imageId === chosen) ?? sheets[0] ?? null
  const canvas = useRef<HTMLCanvasElement>(null)
  const [drag, setDrag] = useState<{ from: Tile; to: Tile } | null>(null)

  const columns = sheet?.set.columns ?? 0
  const rows = sheet?.set.rows ?? 0

  // The picked rectangle, from the drag while it lasts, else from the stamp when it is this sheet's.
  const picked = useMemo((): { x: number; y: number; w: number; h: number } | null => {
    if (drag) {
      const x = Math.min(drag.from[0], drag.to[0])
      const y = Math.min(drag.from[1], drag.to[1])
      return { x, y, w: Math.abs(drag.to[0] - drag.from[0]) + 1, h: Math.abs(drag.to[1] - drag.from[1]) + 1 }
    }
    if (!stamp || !sheet || stamp.image !== sheet.imageId || columns === 0) return null
    const first = stamp.tiles[0][0]
    return { x: first % columns, y: Math.floor(first / columns), w: stamp.tiles[0].length, h: stamp.tiles.length }
  }, [drag, stamp, sheet, columns])

  const source = useMemo(() => (sheet ? rgbaToCanvas(sheet.image) : null), [sheet])
  useEffect(() => {
    const c = canvas.current
    if (!c || !sheet || !source) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    // Drawn at the sheet's own pixels and scaled to the column by CSS, so it fits whatever width the inspector has.
    c.width = sheet.image.width
    c.height = sheet.image.height
    // About one screen pixel, in sheet pixels, at the inspector's usual width: what the grid and outline are drawn at.
    const px = Math.max(1, sheet.image.width / 272)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(source, 0, 0)
    const cell = sheet.set.tile
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
    ctx.lineWidth = px
    ctx.beginPath()
    for (let x = 1; x < columns; x++) {
      ctx.moveTo(x * cell, 0)
      ctx.lineTo(x * cell, c.height)
    }
    for (let y = 1; y < rows; y++) {
      ctx.moveTo(0, y * cell)
      ctx.lineTo(c.width, y * cell)
    }
    ctx.stroke()
    if (picked) {
      ctx.fillStyle = 'rgba(233, 162, 59, 0.18)'
      ctx.fillRect(picked.x * cell, picked.y * cell, picked.w * cell, picked.h * cell)
      ctx.strokeStyle = '#e9a23b'
      ctx.lineWidth = 2 * px
      ctx.strokeRect(picked.x * cell + px, picked.y * cell + px, picked.w * cell - 2 * px, picked.h * cell - 2 * px)
    }
  }, [sheet, source, columns, rows, picked])

  const tileAt = (event: PointerEvent<HTMLCanvasElement>): Tile => {
    const box = event.currentTarget.getBoundingClientRect()
    const cell = box.width / Math.max(1, columns)
    const clamp = (v: number, n: number): number => Math.max(0, Math.min(n - 1, v))
    return [clamp(Math.floor((event.clientX - box.left) / cell), columns), clamp(Math.floor((event.clientY - box.top) / cell), rows)]
  }
  const commit = (from: Tile, to: Tile): void => {
    if (!sheet) return
    const x0 = Math.min(from[0], to[0])
    const y0 = Math.min(from[1], to[1])
    const tiles: number[][] = []
    for (let y = y0; y <= Math.max(from[1], to[1]); y++) {
      const row: number[] = []
      for (let x = x0; x <= Math.max(from[0], to[0]); x++) row.push(y * columns + x)
      tiles.push(row)
    }
    void run(host, 'terrain.params', { stamp: { image: sheet.imageId, tiles }, paintVerb: 'tiles', terrainMode: 'paint' })
  }

  return (
    <Section title="Tiles" summary={picked && sheet ? `${nameOf(sheet.imageId)} · ${picked.w}×${picked.h}` : sheets.length}>
      {sheets.length === 0 ? (
        <Note>No sheet at the project&rsquo;s tile size has loaded. Images are listed in Project settings.</Note>
      ) : (
        <>
          <Field label="Sheet">
            <Select value={String(sheet?.imageId ?? '')} options={sheets.map((s) => ({ value: String(s.imageId), label: nameOf(s.imageId) }))} onChange={(value) => setChosen(Number(value))} />
          </Field>
          {sheet ? (
            <canvas
              ref={canvas}
              style={{ width: '100%', aspectRatio: `${sheet.image.width} / ${sheet.image.height}`, imageRendering: 'pixelated', cursor: 'crosshair', touchAction: 'none', display: 'block' }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                const at = tileAt(event)
                setDrag({ from: at, to: at })
              }}
              onPointerMove={(event) => {
                if (drag) setDrag({ from: drag.from, to: tileAt(event) })
              }}
              onPointerUp={(event) => {
                if (!drag) return
                commit(drag.from, tileAt(event))
                setDrag(null)
              }}
            />
          ) : null}
          <Note>Drag across the sheet to pick tiles, then click a top or a wall: the picked tiles&rsquo; top-left lands there, on the active material layer. ⇧ click clears them; ⌥ click picks up a pasted tile.</Note>
        </>
      )}
    </Section>
  )
}
