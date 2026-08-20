import { useState } from 'react'

/**
 * Where the dismissal is remembered. Versioned like every other key this app writes, so that saying
 * something materially different later can ship as `:v2` and be shown again to everyone — rather than
 * being silently swallowed by a flag people set against the old wording.
 */
const KEY = 'cow-drop:beta-notice-dismissed:v1'

/** Whether this browser has already closed the notice. A blocked or absent store reads as "no". */
function dismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    // Private browsing with storage denied. Showing the notice again is the harmless failure.
    return false
  }
}

/** Remember the dismissal, best effort — a full quota must not swallow the click. */
function remember(): void {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    // Nothing useful to do: the notice still closes for this page load, it just comes back next time.
  }
}

/**
 * The standing beta caveat: a full-bleed bar above everything, closed for good once closed.
 *
 * It renders *outside* `main` so it spans the window rather than the 900px page column — this is the
 * first thing on the page, ahead of even the error banner, because it frames what the whole deployment
 * is rather than reporting on anything that happened in it. Its text still lines up with the page
 * content below, so the bar reads as part of the layout and not as browser chrome.
 *
 * Dismissal is per-browser and permanent, which is the deal being struck: it can be this prominent
 * precisely because nobody has to read past it twice. That means it is genuinely possible to use the
 * app without ever having seen it — a returning user on a cleared profile aside — so nothing else may
 * depend on it having been read; README and the About tab say the same thing where it keeps.
 */
export function BetaNotice() {
  // Lazily, during render: reading it in an effect would flash the bar on every reload for someone who
  // closed it months ago, and a bar that reappears is worse than one that never went away.
  const [closed, setClosed] = useState(dismissed)

  if (closed) return null

  return (
    <aside className="beta-notice" role="note">
      <div className="beta-notice-inner">
        <p>
          <strong>Beta.</strong> Not meant for public use: unaudited and still changing. Exercise
          caution and use it at your own risk.
        </p>
        <button
          type="button"
          className="beta-notice-close"
          // "Dismiss" rather than "Close": there is no dialog here, and the label is what a screen
          // reader announces in place of the glyph.
          aria-label="Dismiss the beta notice"
          onClick={() => {
            remember()
            setClosed(true)
          }}
        >
          ×
        </button>
      </div>
    </aside>
  )
}
