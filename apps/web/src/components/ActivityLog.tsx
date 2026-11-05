import { useEffect, useState } from 'react'

import { clearActivity, listActivity, onActivityChanged } from '../lib/activity.js'
import { chainLabel } from '../lib/chain.js'

/** The keeper's activity for this browser's drops, newest first, from local storage. */
export function ActivityLog() {
  const [entries, setEntries] = useState(listActivity)

  useEffect(() => onActivityChanged(() => setEntries(listActivity())), [])

  return (
    <section>
      <h2>Activity</h2>
      {entries.length === 0 ? (
        <p className="hint">
          Nothing yet. Activations and orders for drops handed to the keeper show up here, and as a
          notification while the page is open.
        </p>
      ) : (
        <>
          <ul className="activity">
            {entries.map((entry) => (
              <li key={entry.id} className={`activity-${entry.tone}`}>
                <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString()}</time>
                <span>
                  {entry.title}
                  {entry.detail && <span className="hint"> — {entry.detail}</span>}
                  <span className="hint"> · {chainLabel(entry.chainId)}</span>
                </span>
                {entry.links.map((link) => (
                  <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
                    {link.label} ↗
                  </a>
                ))}
              </li>
            ))}
          </ul>
          <div className="actions">
            <button onClick={clearActivity}>Clear history</button>
          </div>
        </>
      )}
    </section>
  )
}
