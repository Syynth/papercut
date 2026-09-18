/**
 * App-scoped preferences: the editor's, on this machine, following the
 * artist between projects (Project settings › App). Kept in `localStorage`
 * and applied to the view actor at boot; the settings section edits both.
 */

const PREFS_KEY = 'papercut:prefs'

export interface EditorPrefs {
  /** The grid on when a project opens. */
  showGrid: boolean
  /** The marks on corners still to author on when a project opens. */
  showMissing: boolean
  /** The colour a face with nothing on it, and a corner no tile answers, is drawn. */
  fallback: number
  /** How the free editor camera projects when a project opens. */
  projection: 'perspective' | 'orthographic'
}

export const DEFAULT_PREFS: EditorPrefs = { showGrid: true, showMissing: false, fallback: 0xff00ff, projection: 'perspective' }

export function loadPrefs(): EditorPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<EditorPrefs> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS }
    return {
      showGrid: typeof raw.showGrid === 'boolean' ? raw.showGrid : DEFAULT_PREFS.showGrid,
      showMissing: typeof raw.showMissing === 'boolean' ? raw.showMissing : DEFAULT_PREFS.showMissing,
      fallback: typeof raw.fallback === 'number' && Number.isInteger(raw.fallback) && raw.fallback >= 0 && raw.fallback <= 0xffffff ? raw.fallback : DEFAULT_PREFS.fallback,
      projection: raw.projection === 'orthographic' ? 'orthographic' : 'perspective',
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(prefs: EditorPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // A private window; the preference holds for the session.
  }
}
