import { useEffect, useMemo, useSyncExternalStore } from 'react'

import { parseRoute, routeHash, type Route, type Tab } from './route.js'

/**
 * The fragment as an external store, and the one place that writes it.
 *
 * `useSyncExternalStore` rather than `useState` + an effect because the fragment genuinely is an
 * external mutable store, and the mirrored version has a real failure here rather than a theoretical
 * one: its subscription is installed in an effect, so a change between the render-phase read and the
 * effect flush is lost — and StrictMode's add/remove/re-add widens exactly that window in dev, which
 * is where Back and Forward get tested. This re-reads the snapshot at subscribe time and after every
 * notification, so it cannot miss one, and it leaves no second copy of "which tab" to drift.
 *
 * The one thing it does not see is `pushState`/`replaceState`, which do not fire `hashchange`. That
 * asymmetry is load-bearing rather than an obstacle — it is what stops the recipe mirror reading back
 * its own write — so writes announce themselves on a private event instead.
 */

/** Our own writes do not fire `hashchange`, so they say so on this. */
const ROUTE_EVENT = 'cow-drop:route'

/**
 * The last fragment this app wrote, so a change that is not ours can be told from one that is — which
 * is what keeps the recipe mirror from feeding itself.
 *
 * Seeded at import time with whatever the page loaded on, before React renders. The initial fragment
 * is already read during the first render (the shell's `imported`), so classifying it as a self-write
 * stops that work happening twice. Module state, therefore not SSR-safe — irrelevant for a Vite SPA,
 * but worth knowing rather than discovering.
 */
let ourHash: string = window.location.hash

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  window.addEventListener(ROUTE_EVENT, onChange)
  return () => {
    window.removeEventListener('hashchange', onChange)
    window.removeEventListener(ROUTE_EVENT, onChange)
  }
}

/** A string snapshot, so the store's identity check is a value comparison. */
function snapshot(): string {
  return window.location.hash
}

/**
 * Write the fragment. **The only writer** — anything using `location.hash =` directly would escape
 * the ledger below, be misread as an external change, and could re-adopt a recipe the user had moved
 * on from.
 *
 * `push` for what the user chose, so Back moves between tabs; `replace` for what the page derived, so
 * keystrokes do not fill the back button. Call `push` only from event handlers: from an effect,
 * StrictMode's double invocation pushes twice and Back needs two presses in development only.
 */
export function writeHash(hash: string, mode: 'push' | 'replace'): void {
  if (hash === window.location.hash) return
  ourHash = hash
  if (mode === 'push') window.history.pushState(null, '', hash)
  else window.history.replaceState(null, '', hash)
  window.dispatchEvent(new Event(ROUTE_EVENT))
}

/** The active route, and a push for the one move that is not a link click. */
export function useRoute(): { route: Route; navigate: (tab: Tab) => void } {
  const hash = useSyncExternalStore(subscribe, snapshot)
  // Memoised on the string: `parseRoute` returns a fresh object — and a freshly parsed recipe — per
  // call, so `route.recipe` must never end up in a dependency array. Adoption is event-driven instead.
  const route = useMemo(() => parseRoute(hash), [hash])

  return { route, navigate: (tab) => writeHash(routeHash({ tab }), 'push') }
}

/**
 * Fires for a fragment this app did not write — Back, Forward, or a link pasted into an already-open
 * page, which now loads its recipe rather than needing a reload — and never for one it did.
 *
 * That asymmetry is the whole point: without it the recipe mirror would read back its own write and
 * set state from it on every keystroke.
 */
export function useExternalRoute(onExternal: (route: Route) => void): void {
  const hash = useSyncExternalStore(subscribe, snapshot)

  useEffect(() => {
    if (hash === ourHash) return
    ourHash = hash
    onExternal(parseRoute(hash))
    // `onExternal` is deliberately not a dependency: this must run when the fragment changes, not
    // when the page re-renders with a fresh closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash])
}
