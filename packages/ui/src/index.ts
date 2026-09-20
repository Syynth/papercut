/**
 * The ui package's public surface — the editor's design vocabulary.
 *
 * Issue #12's rule: this is not "the package that contains Mantine", it is the
 * package that holds the vocabulary, and Mantine is an implementation detail of
 * it. The dependency on `@mantine/core` is declared here and nowhere else, and
 * so is the one stylesheet: an app imports `@papercut/ui/styles.css`, which
 * carries Mantine's base styles and the frame's own rules in that order.
 *
 * Three layers, in the order a panel author meets them:
 *
 * - `frame.tsx` — the five regions and what goes in them (rail buttons,
 *   verbs, icon switches, chips, sections, rows, hints), all icon-only with
 *   the words in a tooltip per the 2026-09-12 ruling.
 * - `primitives.tsx` — the form controls a panel is written in, on Mantine.
 * - `icons.tsx` — the glyphs, by name, so a declaration can carry one.
 *
 * Absent, deliberately: the arrow to `@papercut/registry` (declarations
 * only, never handlers) that would let a control resolve a command id to its
 * title and chord. The app does that join today; the day two apps need it,
 * it moves here.
 *
 * Written out rather than `export *`, matching the other packages.
 */

export {
  ColorInput,
  Field,
  Note,
  NumberInput,
  Panel,
  Segmented,
  Select,
  Slider,
  TextInput,
  Toggle,
} from './primitives'

export {
  Action,
  Actions,
  BarDivider,
  BarGroup,
  BarLabel,
  BarSlider,
  BarValue,
  Brand,
  Chip,
  FileButton,
  Frame,
  Hint,
  IconSegmented,
  InspectorHead,
  Item,
  Kbd,
  LayerRange,
  MaterialLayers,
  List,
  Overlay,
  Pill,
  RailButton,
  RailGap,
  RailRule,
  Row,
  Section,
  StatusHints,
  StatusRight,
  Tip,
  TopButton,
  TopGroup,
  TopGrow,
  TopSep,
  Verb,
} from './frame'
export type { IconOption, MaterialLayerRow } from './frame'

export { Dialog, DialogManifest, Menu, MenuDivider, MenuItem, MenuLabel, TopCrumb } from './overlays'
export { Checkbox, Door, Doors, ErrorLine, RecentList, RecentRow, StartupScreen, StartupSection } from './startup'
export { CoverageMark, FaceMarks, FloatStage, MaterialRow, StageFloat, StagePanel, StageToolbar, SubjectRow, FieldGrid, SettingsBlock, SettingsDialog, Tagger, TaggerItem, Library, LibraryTab, LibraryItem, LibraryGroup, Derived, PairInput, AssetPicker, SettingsRailItem, SettingsRailNote, SettingsScope, SettingsSearch, SheetPreview, Status, Swatch, Table, TableRow } from './settings'

export { BarScrub, Scrub } from './scrub'
export type { ScrubProps } from './scrub'

export { ICON_NAMES, Icon, isIconName } from './icons'
export type { IconName } from './icons'

export { UiProvider } from './provider'
export { cssVariables, darkScale, shades, theme, themeOverride } from './theme'
export { colors, fontSize, fonts, frame, radius, space, tokens } from './tokens'
export type { Tokens } from './tokens'
export type { PickerOption } from './settings'
