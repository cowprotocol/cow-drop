import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'

/**
 * A QR code of `value`, or null while it is being drawn.
 *
 * Rendered at `width` rather than scaled up by CSS: a QR enlarged from a small bitmap is a QR with
 * soft module edges, and soft edges are what makes a borderline scan fail.
 */
function useQr(value: string, width: number): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void QRCode.toDataURL(value, { margin: 1, width }).then((next) => {
      if (!cancelled) setUrl(next)
    })
    return () => {
      cancelled = true
    }
  }, [value, width])

  return url
}

/**
 * A small QR that opens a big one.
 *
 * The small one is a cue, not a target — nothing scans a 44px code across a desk. Clicking it is
 * what this is for: the enlarged version is sized off the viewport, so holding a laptop up to
 * somebody's phone works, which is the way an address actually gets from one person to another.
 *
 * The white plate and its quiet zone are not decoration. A QR drawn straight onto this page's dark
 * background is unreadable to most scanners.
 */
export function QrZoom({ value, label, size = 44 }: { value: string; label: string; size?: number }) {
  const [open, setOpen] = useState(false)
  // Big enough to stay crisp at any sensible zoom; the CSS caps the displayed size.
  const small = useQr(value, 160)
  const large = useQr(value, 720)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button
        type="button"
        className="qr-chip"
        style={{ width: size, height: size }}
        onClick={() => setOpen(true)}
        aria-label={`Show the QR code for ${label} full size`}
        title="Click to enlarge"
      >
        {small && <img src={small} alt="" width={size} height={size} />}
      </button>

      {open && (
        <div
          className="qr-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`QR code for ${label}`}
          // The backdrop closes it; the panel below stops the click so a miss inside does not.
          onClick={() => setOpen(false)}
        >
          <div className="qr-panel" onClick={(event) => event.stopPropagation()}>
            <p className="qr-panel-label">{label}</p>
            {large && <img className="qr-panel-code" src={large} alt={`QR code for ${label}`} />}
            <code className="address">{value}</code>
            <button ref={closeRef} onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  )
}
