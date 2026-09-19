import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAseprite } from '@papercut/aseprite'
import { renderFrame } from '@papercut/aseprite-render'
import { readAsepriteSheet } from '@papercut/aseprite-sheet'
import { plainGrid } from '@papercut/document'
import { MemoryFs, createProjectFolder, decodeImage, listImage, openProject, rawImageCodec } from '@papercut/project'
import { describe, expect, it } from 'vitest'

/**
 * `.aseprite` files as project images, end to end (decision-log 2026-09-19):
 * found in `sheets/`, listed, opened at the frame the entry names, with the
 * file's frame count beside the pixels. Uses the fixtures Aseprite wrote for
 * the golden test, so these are files Aseprite made, not ones built to pass.
 *
 * Repo-wide because reading the fixtures needs `node:fs`; `project` itself
 * compiles with no Node types.
 */

const FIXTURES = join(new URL('..', import.meta.url).pathname, 'packages/aseprite-render/fixtures')
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)))

/** A project at `/p` with `layers.aseprite` (12×10, two frames) in `sheets/`. */
async function projectWithSheet(): Promise<MemoryFs> {
  const fs = new MemoryFs()
  await createProjectFolder(fs, '/p', { name: 'P', texelDensity: 4 }, rawImageCodec)
  await fs.writeFile('/p/sheets/layers.aseprite', fixture('layers.aseprite'))
  return fs
}

describe('.aseprite files in a project', () => {
  it('are found in sheets/ as unlisted images', async () => {
    const fs = await projectWithSheet()
    expect((await openProject(fs, '/p', rawImageCodec)).unlisted).toEqual(['sheets/layers.aseprite'])
  })

  it('open at frame 0 once listed, flattened as Aseprite shows it, with their frame count', async () => {
    const fs = await projectWithSheet()
    const project = (await openProject(fs, '/p', rawImageCodec)).project
    await listImage(fs, '/p', project, 'sheets/layers.aseprite', plainGrid(2))
    const opened = await openProject(fs, '/p', rawImageCodec)
    const [set] = opened.sets
    expect(opened.warnings).toEqual([])
    expect(opened.project.images[0]?.frame).toBe(0)
    expect(set?.frames).toBe(2)
    expect(set?.source?.data).toEqual(renderFrame(parseAseprite(fixture('layers.aseprite')), 0).data)
  })

  it('open at the frame the entry names', async () => {
    const fs = await projectWithSheet()
    const listed = await listImage(fs, '/p', (await openProject(fs, '/p', rawImageCodec)).project, 'sheets/layers.aseprite', plainGrid(2))
    const text = JSON.parse(await fs.readTextFile('/p/papercut.json')) as { images: Array<{ frame: number }> }
    expect(listed.images[0]?.frame).toBe(0)
    text.images[0]!.frame = 1
    await fs.writeFile('/p/papercut.json', JSON.stringify(text))
    const opened = await openProject(fs, '/p', rawImageCodec)
    expect(opened.sets[0]?.source?.data).toEqual(renderFrame(parseAseprite(fixture('layers.aseprite')), 1).data)
  })

  it('draw their last frame, and say so, when the entry names one past it', async () => {
    const fs = await projectWithSheet()
    await listImage(fs, '/p', (await openProject(fs, '/p', rawImageCodec)).project, 'sheets/layers.aseprite', plainGrid(2))
    const text = JSON.parse(await fs.readTextFile('/p/papercut.json')) as { images: Array<{ frame: number }> }
    text.images[0]!.frame = 7
    await fs.writeFile('/p/papercut.json', JSON.stringify(text))
    const opened = await openProject(fs, '/p', rawImageCodec)
    expect(opened.sets[0]?.source?.data).toEqual(renderFrame(parseAseprite(fixture('layers.aseprite')), 1).data)
    expect(opened.warnings).toEqual(['layers.aseprite: It has 2 frames, so frame 2 is drawn instead of frame 8.'])
  })

  it('bring their own grid to an import; other images go to the codec', async () => {
    const decoded = await decodeImage(rawImageCodec, fixture('blend-rgb.aseprite'))
    expect(decoded).toMatchObject({ frames: 1, frame: 0, grid: { tile: 16, margin: { x: 0, y: 0 }, spacing: { x: 0, y: 0 } }, warnings: [] })
    expect(readAsepriteSheet(fixture('blend-rgb.aseprite')).grid?.from).toBe('grid')
    const raw = await rawImageCodec.encode({ width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 4]) })
    expect(await decodeImage(rawImageCodec, raw)).toMatchObject({ frames: 1, frame: 0, grid: null, image: { width: 1, height: 1 } })
  })
})
