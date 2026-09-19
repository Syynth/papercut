# @papercut/aseprite

Reads Aseprite files (`.ase` / `.aseprite`) into a typed model of everything
the format stores: header, layers (with their tree), frames, cels (image,
linked and tilemap), palettes, tags, slices, tilesets, colour profile,
external files and user data with its typed property maps.

No DOM, no Node: one dependency, `fflate`, for the zlib streams inside cels
and tilesets. Built as if published; it knows nothing about papercut.

```ts
import { parseAseprite, resolveCel, paletteAt } from '@papercut/aseprite'

const file = parseAseprite(bytes)
file.layers      // every layer, in file order; `parent` gives the tree
file.frames[0]   // { duration, cels, paletteChanges }
file.tags        // { name, from, to, direction, repeat, … }
file.slices      // { name, keys: [{ frame, bounds, center, pivot }] }
file.warnings    // what was skipped without failing
resolveCel(file, layer, frame) // a cel with its link followed
paletteAt(file, frame)          // the palette in effect on a frame
```

Pixels stay in the file's own colour mode. To turn a frame into RGBA, use
`@papercut/aseprite-render`.

Format reference: https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md
