/**
 * The vocabulary's icon set: every glyph a tool, verb, mode or chip can name.
 *
 * Inline rather than a dependency, and named rather than imported: a
 * `ToolDecl` and a keybinding are data, and a glyph a declaration can name by
 * string is as storable as the rest of it. Drawn on a 24-unit grid with a
 * 1.7 stroke so they read at 16–18px; filled shapes say so explicitly, since
 * the `<svg>` sets `fill="none"` for the rest.
 *
 * Adding one is adding a key here and nothing else — the map IS the set, and
 * `IconName` is derived from it so a declaration naming a glyph that does not
 * exist fails to compile rather than rendering a blank.
 */

import type { ReactElement } from 'react'

const GLYPHS = {
  // tools
  select: <path d="M5 3l14 9-7 1.5L8 21 5 3z" fill="currentColor" stroke="none" />,
  terrain: <path d="M2 18 8 6l4 6 2.5-3L21 18Z" />,
  // the three kinds of face a material's art can be for
  faceFloor: <path d="M12 4 21 12 12 20 3 12Z" />,
  faceWall: (
    <>
      <rect x="5" y="3" width="14" height="18" />
      <path d="M5 9h14M5 15h14M12 3v6M9 9v6M15 9v6M12 15v6" />
    </>
  ),
  faceRamp: <path d="M3 20h18V6Z" />,
  objects: (
    <>
      <path d="M12 3l5 7h-3l4 6H6l4-6H7z" />
      <path d="M12 16v5" />
    </>
  ),
  buildings: (
    <>
      <path d="M3 11 12 4l9 7v9H3z" />
      <path d="M9 20v-6h6v6" />
    </>
  ),
  sketch: (
    <>
      <path d="M5 17 8 6l8 2 3 8-7 3z" />
      <circle cx="8" cy="6" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="16" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="16" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="5" cy="17" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  pen: <path d="M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3" />,
  check: <path d="M5 12l5 5L20 7" />,
  fences: <path d="M5 7v13M12 7v13M19 7v13M2 11h20M2 16h20M3.5 8 5 5l1.5 3M10.5 8 12 5l1.5 3M17.5 8 19 5l1.5 3" />,
  level: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1l2.1-2.1M17 7l2.1-2.1" />
    </>
  ),

  // top bar
  undo: <path d="M9 14 4 9l5-5M4 9h10.5a5 5 0 0 1 0 10H11" />,
  redo: <path d="m15 14 5-5-5-5M20 9H9.5a5 5 0 0 0 0 10H13" />,
  frameAll: (
    <>
      <path d="M12 4v16M4 12h16" />
      <circle cx="12" cy="12" r="5.5" />
    </>
  ),
  sweep: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3" />
    </>
  ),
  play: <path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />,
  save: (
    <>
      <path d="M4 4h12l4 4v12H4z" />
      <path d="M8 4v5h7V4M7 20v-6h10v6" />
    </>
  ),
  open: <path d="M3 7h6l2 2h10v11H3z" />,
  export: <path d="M12 3v12M8 7l4-4 4 4M4 15v5h16v-5" />,
  grid: <path d="M4 4h16v16H4zM4 12h16M12 4v16" />,
  // snapping: where on the grid a drag lands — a line crossing, a half-cell point, or anywhere
  snapGrid: (
    <>
      <path d="M4 4h16v16H4zM4 12h16M12 4v16" opacity="0.55" />
      <circle cx="12" cy="12" r="2.8" fill="currentColor" stroke="none" />
    </>
  ),
  snapHalf: (
    <>
      <path d="M4 4h16v16H4zM4 12h16M12 4v16" opacity="0.55" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="16" cy="8" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="8" cy="16" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="16" cy="16" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),
  snapFree: (
    <>
      <circle cx="12" cy="12" r="8" strokeDasharray="3 3" opacity="0.55" />
      <circle cx="12" cy="12" r="2.8" fill="currentColor" stroke="none" />
    </>
  ),
  camera: (
    <>
      <path d="M3 8l9-5 9 5v8l-9 5-9-5z" />
      <path d="M12 21v-8l9-5M12 13 3 8" />
    </>
  ),

  // verbs
  move: <path d="M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3" />,
  expand: (
    <>
      <rect x="8.5" y="8.5" width="7" height="7" />
      <path d="M3 3l4 4M3 7V3h4M21 3l-4 4M21 7V3h-4M3 21l4-4M3 17v4h4M21 21l-4-4M21 17v4h-4" />
    </>
  ),
  contract: (
    <>
      <rect x="8.5" y="8.5" width="7" height="7" />
      <path d="M3 3l4 4M7 3v4H3M21 3l-4 4M17 3v4h4M3 21l4-4M7 21v-4H3M21 21l-4-4M17 21v-4h4" />
    </>
  ),
  invert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </>
  ),
  clear: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  raise: <path d="M4 20h16M12 16V5M8 9l4-4 4 4" />,
  lower: <path d="M4 20h16M12 4v11M8 11l4 4 4-4" />,
  flatten: <path d="M3 14h18M6 18h12M12 4v6M9 7l3 3 3-3" />,
  smooth: <path d="M3 15c3-7 6-7 9 0s6 7 9 0M3 20h18" />,
  ramp: <path d="M3 19h18M3 19 21 7v12" />,
  water: <path d="M3 10c3-3 6-3 9 0s6 3 9 0M3 15c3-3 6-3 9 0s6 3 9 0M3 20c3-3 6-3 9 0s6 3 9 0" />,
  rotate: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v5h-5" />
    </>
  ),
  scale: <path d="M3 21 21 3M21 3h-7M21 3v7M3 21h7M3 21v-7" />,

  // modes, shapes, rules
  sculpt: <path d="M3 18 9 7l4 6 2.5-3L20 18Z" />,
  paint: (
    <>
      <path d="M4 4h12v5H4z" />
      <path d="M16 6h3v5h-7v3" />
      <rect x="10" y="14" width="4" height="7" />
    </>
  ),
  tile: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
  material: (
    <>
      <path d="M4 4h16v16H4z" />
      <path d="M4 14c4-6 8 6 16-4" />
    </>
  ),
  tint: (
    <>
      <path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z" />
      <path d="M9 14a3 3 0 0 0 3 3" />
    </>
  ),
  brush: (
    <>
      <circle cx="12" cy="12" r="6" strokeDasharray="3 3" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  rect: <rect x="4" y="6" width="16" height="12" rx="1" strokeDasharray="3 3" />,
  fill: (
    <>
      <path d="M6 11 13 4l7 7-7 7z" />
      <path d="M4 21c0-2 2-4 2-4s2 2 2 4a2 2 0 0 1-4 0z" fill="currentColor" stroke="none" />
    </>
  ),
  square: <rect x="5" y="5" width="14" height="14" rx="1" />,
  circle: <circle cx="12" cy="12" r="7.5" />,
  marquee: <rect x="4" y="4" width="16" height="16" rx="1" strokeDasharray="3 3" />,
  lasso: (
    <>
      <path d="M12 4c5 0 8 2.5 8 5.5S17 15 12 15 4 12.5 4 9.5 7 4 12 4z" />
      <path d="M7 14c-1 2-1 4 1 6" />
    </>
  ),
  replace: <rect x="5" y="5" width="14" height="14" rx="1" />,
  add: (
    <>
      <rect x="4" y="4" width="11" height="11" rx="1" />
      <path d="M17 13v8M13 17h8" />
    </>
  ),
  subtract: (
    <>
      <rect x="4" y="4" width="11" height="11" rx="1" />
      <path d="M13 17h8" />
    </>
  ),
  place: (
    <>
      <path d="M12 21s-6-6-6-11a6 6 0 0 1 12 0c0 5-6 11-6 11z" />
      <path d="M12 7v6M9 10h6" />
    </>
  ),
  arrange: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <path d="M10 6.5h5.5V14" />
    </>
  ),
  faceLeft: <path d="M15 5 7 12l8 7z" fill="currentColor" stroke="none" />,
  faceRight: <path d="M9 5l8 7-8 7z" fill="currentColor" stroke="none" />,

  // sprites and materials
  tree: (
    <>
      <path d="M12 3l5 7h-3l4 6H6l4-6H7z" />
      <path d="M12 16v5" />
    </>
  ),
  pine: (
    <>
      <path d="M12 3l4 5h-2l3 4h-2l3 4H6l3-4H7l3-4H8z" />
      <path d="M12 16v5" />
    </>
  ),
  rock: <path d="M4 17l3-8 5-3 6 3 2 8z" />,
  bush: <path d="M5 17a4 4 0 0 1 3-7 5 5 0 0 1 9 1 3.5 3.5 0 0 1 2 6z" />,
  sign: (
    <>
      <path d="M12 21V8" />
      <path d="M5 4h12l3 3-3 3H5z" />
    </>
  ),
  lamp: (
    <>
      <path d="M12 21V9" />
      <path d="M9 9h6l-1-5h-4z" />
      <circle cx="12" cy="4" r="1" fill="currentColor" stroke="none" />
      <path d="M8 21h8" />
    </>
  ),
  mountains: <path d="M2 19 8 8l3 5 3-8 8 14z" />,
  layers: (
    <>
      <path d="M12 3 3 8l9 5 9-5z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 16 9 5 9-5" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M3 3l18 18M10 6a10 10 0 0 1 2-1c6 0 10 7 10 7a17 17 0 0 1-3 4M6 8a17 17 0 0 0-4 4s4 7 10 7a9 9 0 0 0 3-.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="1" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="1" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </>
  ),
  warn: (
    <>
      <path d="M12 3 2 20h20z" />
      <path d="M12 9v5M12 17v.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  folder: <path d="M3 7h6l2 2h10v10H3z" />,
  map: (
    <>
      <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
      <path d="M9 3v15M15 6v15" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
  close: <path d="M18 6L6 18M6 6l12 12" />,
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </>
  ),
  unlink: (
    <>
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
      <path d="M4 4l16 16" />
    </>
  ),
} satisfies Record<string, ReactElement>

export type IconName = keyof typeof GLYPHS

/** Every glyph name, for a palette or a test that wants to enumerate them. */
export const ICON_NAMES = Object.keys(GLYPHS) as readonly IconName[]

export function isIconName(name: string): name is IconName {
  return Object.hasOwn(GLYPHS, name)
}

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="ui-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[name]}
    </svg>
  )
}
