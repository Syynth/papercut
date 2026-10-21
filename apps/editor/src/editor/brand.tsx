/**
 * The brand's mark and wordmark (`brand/`, made by `brand/source/export_brand.py`)
 * for the startup screens. The dark versions: the editor's chrome is dark.
 *
 * The startup screen's mark moves: papercut-mark-loop-dark.svg plays its intro
 * (planes, axes, the block dropping in, the top half lifting off), then the top
 * half bobs over the cut for as long as the screen shows. The animation is CSS
 * inside the SVG, so an <img> plays it, and it holds still under reduced motion.
 */

import markLoop from '../../../../brand/papercut-mark-loop-dark.svg?url'
import markStill from '../../../../brand/papercut-mark-dark.svg?url'
import wordmark from '../../../../brand/papercut-wordmark-dark.svg?url'

/** The mark; `moving` for the bobbing loop. Decorative: the name beside it says what it is. */
export function BrandMark({ moving = false }: { moving?: boolean }) {
  return moving ? <img src={markLoop} alt="" width={661} height={668} /> : <img src={markStill} alt="" width={661} height={652} />
}

export function Wordmark() {
  return <img src={wordmark} alt="papercut" width={1537} height={334} />
}
