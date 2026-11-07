import { dropName, type ActivityEntry } from '../lib/activity.js'

/** How long a toast stays up, unless it is an error, which stays until dismissed. */
export const TOAST_MS = 8_000

/** Keeper activity as it happens, bottom right. The same entries are kept in the Drops tab's history. */
export function Toasts({ toasts, onDismiss }: { toasts: ActivityEntry[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
          <div className="toast-body">
            {/* The drop first: with several in flight, "Order posted" alone says nothing. */}
            <span className="toast-drop">{dropName(toast)}</span>
            <strong>{toast.title}</strong>
            {toast.detail && <span className="hint">{toast.detail}</span>}
            {toast.links.length > 0 && (
              <span className="toast-links">
                {toast.links.map((link) => (
                  <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
                    {link.label} ↗
                  </a>
                ))}
              </span>
            )}
          </div>
          <button className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
