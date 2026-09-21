import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { createDocument, createMap } from '@papercut/document'
import { HostProvider, createHost } from '@papercut/editor-host'
import { UiProvider } from '@papercut/ui'

import App from './editor/App'
import { loadPrefs } from './editor/prefs'
import { installWorkspace } from './editor/workspace'
import { createSession, installShellMenu, openFolder, openProjectAt, recents, reopenLast, watchProjectFolder } from './editor/session'
import { features } from './features'
// The vocabulary's stylesheet — Mantine's base plus the frame — then the
// app's own remainder, which only paints what the vocabulary does not.
import '@papercut/ui/styles.css'
import './editor/styles.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('No #root element')
const root = rootElement

// The composition root, and the reason it is here rather than in `App`: the
// host must exist BEFORE and OUTSIDE any render (`editor-host`'s react glue
// says why — a host built by a hook is rebuilt when React remounts, orphaning
// every closure bound to the first one), and the viewport it drives is
// imperative.
//
// `createDocument` hands back a reader and the actor's logic, and that is all
// an app ever holds (#13): there is no store here to write through, so the
// second write path #66 kept open until step 7 is closed by the type graph.
// Named `source` rather than `document` because this file uses the DOM's.
//
// The document starts as a placeholder: the app opens projects, and the map
// arrives when one does (`session.ts`). Until then the startup screen shows
// and nothing reads the document.
const source = createDocument(createMap(2, 2, 'No map'))
// The features are installed here and nowhere else (#35): only an app composes
// a feature into a host. Their commands are dispatchable from this point on,
// and the panels they declare are what the left-hand column renders.
const host = createHost({ document: source, features })

async function boot(): Promise<void> {
  const session = await createSession()
  // The machine's preferences are the view's starting state.
  host.dispatch('view.set', loadPrefs())
  // And what was in hand comes back: the tool, its settings, every feature's parameters.
  installWorkspace(host)
  installShellMenu(host, session)
  watchProjectFolder(host, session)

  // `UiProvider` sits outside the host: it is the one place Mantine is mounted
  // and the tokens become CSS variables, and it needs nothing from the host.
  const app = (
    <UiProvider>
      <HostProvider host={host}>
        <App session={session} />
      </HostProvider>
    </UiProvider>
  )

  // Not StrictMode-doubled: the viewport owns a WebGL context and a render loop,
  // and mounting it twice in development costs a context without proving
  // anything. The React tree below it is still strict.
  const wrapped: ReactNode = import.meta.env.DEV ? app : <StrictMode>{app}</StrictMode>
  createRoot(root).render(wrapped)

  // Reopen the last project when asked to, and after a RELOAD the project that was open — the desktop shell reloads
  // into an updated bundle and promises the map comes back. A failure leaves the startup screen, which says why on the
  // next attempt.
  const reloaded = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'reload'
  const folder = reloaded ? openFolder() : reopenLast() ? (recents()[0]?.folder ?? null) : null
  if (folder !== null) await openProjectAt(host, session, folder).catch((error: unknown) => console.warn(`[editor] could not reopen ${folder}: ${String(error)}`))
}

void boot()
