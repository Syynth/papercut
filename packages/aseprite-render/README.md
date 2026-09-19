# @papercut/aseprite-render

Renders a frame of a parsed Aseprite file (`@papercut/aseprite`) to RGBA
pixels the way Aseprite composes it: all nineteen blend modes, cel × layer
opacity, hidden and reference layers, flattened or composited groups, cel
z-indexes, linked cels, and tilemaps with flips.

The blenders are a port of Aseprite's own integer arithmetic (MIT; see
LICENSE), so output matches Aseprite's to the bit. The fixtures in
`fixtures/` were written by Aseprite from `make.lua`, with Aseprite's own PNG
of each frame, and the repo's golden test compares against them exactly.

```ts
import { parseAseprite } from '@papercut/aseprite'
import { renderFrame } from '@papercut/aseprite-render'

const { width, height, data } = renderFrame(parseAseprite(bytes), 0)
```

One deliberate difference: indexed sprites are composed in RGBA, as Aseprite
draws them on its canvas, not in palette indices as its "Save As PNG" does.
The two agree for opaque, normal-blend layers.
