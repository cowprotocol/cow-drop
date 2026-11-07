import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** Clearance between the bubble and the viewport edge, and between the bubble and its trigger. */
const GUTTER = 10

/**
 * The long version of a short label.
 *
 * The app used to explain itself in paragraphs under every field, which made each panel a wall and
 * buried the ones that mattered. The explanations are still worth having — this is money moving on a
 * commitment nobody can revoke — so they moved in here: the label stays a label, and the detail is one
 * click away for whoever wants it.
 *
 * Click, not hover. Hover tooltips do not exist on a phone, and a good share of this is read on one.
 * Hover still opens it on a pointer device as a convenience, but nothing is hover-only.
 */
export function Tooltip({ title, children }: { title?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  /**
   * Viewport coordinates for the bubble, which is `position: fixed`.
   *
   * Absolute positioning inside the trigger cannot work here. A tooltip follows a field label, so it
   * sits at the start of a line — and a bubble centred on it hangs off the left edge of a phone,
   * which is exactly what it did. Nothing in the CSS can know how much room is on either side, so
   * the clamp is measured once the bubble has a size.
   */
  const [box, setBox] = useState<{ left: number; top: number } | null>(null)

  const containerRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const id = useId()

  const place = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect()
    const bubble = bubbleRef.current?.getBoundingClientRect()
    if (!trigger || !bubble) return

    const centred = trigger.left + trigger.width / 2 - bubble.width / 2
    const maxLeft = window.innerWidth - bubble.width - GUTTER
    // `Math.min` first, then `Math.max`: on a viewport narrower than the bubble the clamp has to
    // settle on the left gutter rather than a negative maximum.
    const left = Math.max(GUTTER, Math.min(centred, maxLeft))

    // Above by preference; below when there is not room, which happens at the top of the page.
    const above = trigger.top - bubble.height - GUTTER
    const top = above >= GUTTER ? above : trigger.bottom + GUTTER

    setBox({ left, top })
  }, [])

  // Before paint, so the bubble is never shown at the unclamped position first.
  useLayoutEffect(() => {
    if (open) place()
    else setBox(null)
  }, [open, place])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    // Scrolling moves the trigger out from under a fixed bubble. Closing beats chasing it.
    const onScroll = () => setOpen(false)

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  return (
    <span
      className="tooltip"
      ref={containerRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={triggerRef}
        type="button"
        className="tooltip-trigger"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={title ? `About ${title}` : 'More detail'}
        onClick={(event) => {
          // These sit inside `<label>` elements. A label's activation behaviour runs as the click's
          // default action and forwards to the labelled control — so without this, opening a tooltip
          // focuses the input beside it, and on a checkbox it toggles it.
          event.preventDefault()
          setOpen((current) => !current)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>

      {open && (
        <span
          className="tooltip-bubble"
          id={id}
          role="tooltip"
          ref={bubbleRef}
          // Hidden rather than unmounted for the first paint: it has to have a size to be placed.
          style={box ? { left: box.left, top: box.top } : { visibility: 'hidden' }}
        >
          {title && <strong>{title}</strong>}
          {children}
        </span>
      )}
    </span>
  )
}
