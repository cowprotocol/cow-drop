import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'

/**
 * The app's one dropdown.
 *
 * A native `<select>` cannot show a logo next to an option, and it cannot show a second line of
 * explanation under one — and both are what the pickers here are for. A chain is recognised by its
 * mark long before its name is read, and a recipe kind is a choice nobody can make from four nouns.
 *
 * So: a trigger button plus a popover listbox, with the keyboard model written out rather than
 * inherited. Three pickers share it (token, network, recipe), which is the point — before this they
 * were a popover, a bare `<select>` and a row of buttons, and looked like three different apps.
 */
export interface SelectOption<T extends string | number> {
  value: T
  label: string
  /** The second line, for a choice that needs one. Kept to a clause. */
  description?: string
  /** A logo or mark, shown in the trigger and in the row. */
  icon?: ReactNode
  /** Extra text the filter matches on, beyond the label and description. */
  keywords?: string
  /** A short state note shown on the right of the row — "not deployed", and the like. */
  note?: string
}

export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
  searchable = false,
  customOption,
  filterPlaceholder = 'Search',
  placeholder = 'Select',
  emptyText = 'Nothing matches',
  triggerLabel,
  className,
}: {
  /** The field label above the trigger. Omit for a bare dropdown. */
  label?: ReactNode
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  searchable?: boolean
  /**
   * Turn what was typed into a selectable row, for a value the list does not contain.
   *
   * The dropdown stops being a list of what exists and becomes "pick one of these, or name your own"
   * — a drop you saved, or any address you paste. Returning `null` means the text is not a usable
   * value yet, so nothing is offered and the empty state stands.
   */
  customOption?: (query: string) => SelectOption<T> | null
  filterPlaceholder?: string
  placeholder?: string
  emptyText?: string
  /**
   * Fixed text for the trigger, instead of whatever is selected.
   *
   * For a dropdown that is an *action* rather than a field — "Change", not the current value. The
   * selection still drives the tick and the opening highlight; only the button's own label differs.
   */
  triggerLabel?: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  /** Which row the keyboard is on. Not the selection — that only changes on Enter or a click. */
  const [active, setActive] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const baseId = useId()

  const selected = options.find((option) => option.value === value)

  /* Read by the open effect below, which must not re-run when either of these changes. */
  const optionsRef = useRef(options)
  optionsRef.current = options
  const valueRef = useRef(value)
  valueRef.current = value

  const matches = useMemo(() => {
    const typed = filter.trim()
    const needle = typed.toLowerCase()
    if (!needle) return options
    const found = options.filter((option) =>
      [option.label, option.description, option.keywords]
        .filter(Boolean)
        .some((text) => text!.toLowerCase().includes(needle)),
    )
    // Appended rather than prepended: what you already have comes first, and the offer to use the
    // typed value sits at the end where it reads as the fallback it is.
    const custom = customOption?.(typed)
    return custom && !found.some((option) => option.value === custom.value) ? [...found, custom] : found
  }, [options, filter, customOption])

  /*
   * Open on the current selection, so Enter without arrowing is a no-op rather than a surprise.
   *
   * Deliberately keyed on `open` alone. Re-running as `matches` or `value` change would drag the
   * highlight back to the selection on every keystroke of the filter.
   *
   * Closing clears the filter, which is also what makes the index above sound: `active` indexes into
   * `matches`, and only an empty filter guarantees that `matches` is still the full `options`.
   */
  useEffect(() => {
    if (!open) {
      setFilter('')
      return
    }
    const index = optionsRef.current.findIndex((option) => option.value === valueRef.current)
    setActive(index === -1 ? 0 : index)
  }, [open])

  // A filtered list can be shorter than the highlight that was on it.
  useEffect(() => {
    setActive((current) => (current >= matches.length ? Math.max(0, matches.length - 1) : current))
  }, [matches.length])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)

    // Focus goes to the filter when there is one, else to the list itself, so the arrow keys below
    // reach a handler either way.
    if (searchable) filterRef.current?.focus()
    else listRef.current?.focus()

    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, searchable])

  // Keep the highlighted row on screen while arrowing through a long list.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const choose = (next: T) => {
    onChange(next)
    // The filter is cleared by the effect above, on close — however the popover was dismissed.
    setOpen(false)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((current) => Math.min(current + 1, matches.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((current) => Math.max(current - 1, 0))
        break
      case 'Home':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
        event.preventDefault()
        setActive(matches.length - 1)
        break
      case 'Enter': {
        const option = matches[active]
        if (option) {
          event.preventDefault()
          choose(option.value)
        }
        break
      }
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        break
      case 'Tab':
        setOpen(false)
        break
      default:
        break
    }
  }

  return (
    <div className={['select', className].filter(Boolean).join(' ')} ref={containerRef}>
      {label !== undefined && (
        <span className="select-label" id={`${baseId}-label`}>
          {label}
        </span>
      )}

      <button
        type="button"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        // The label is a span, not a `<label>` — it has to be able to hold a tooltip button, and a
        // button inside a label is a control that steals the label's own click.
        aria-labelledby={label !== undefined ? `${baseId}-label ${baseId}-trigger` : undefined}
        id={`${baseId}-trigger`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          // Arrowing from the closed trigger opens it, the way a native select does.
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {triggerLabel !== undefined ? (
          <span className="select-trigger-text">{triggerLabel}</span>
        ) : (
          <>
            {selected?.icon}
            {selected ? (
              <span className="select-trigger-text">
                <span className="select-trigger-label">{selected.label}</span>
                {selected.note && <span className="select-note"> {selected.note}</span>}
              </span>
            ) : (
              <span className="muted">{placeholder}</span>
            )}
          </>
        )}
        <span className="select-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="select-popover">
          {searchable && (
            <input
              ref={filterRef}
              className="select-filter"
              placeholder={filterPlaceholder}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-expanded
              aria-controls={`${baseId}-list`}
              aria-activedescendant={matches[active] ? `${baseId}-${active}` : undefined}
              aria-autocomplete="list"
            />
          )}

          <div
            id={`${baseId}-list`}
            className="select-list"
            role="listbox"
            ref={listRef}
            tabIndex={searchable ? -1 : 0}
            onKeyDown={searchable ? undefined : onKeyDown}
            aria-activedescendant={matches[active] ? `${baseId}-${active}` : undefined}
          >
            {matches.map((option, index) => (
              <div
                key={option.value}
                id={`${baseId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                data-active={index === active}
                className={[
                  'select-option',
                  option.value === value ? 'is-selected' : '',
                  index === active ? 'is-active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                // Pointer rather than click, so the highlight follows the mouse without a selection.
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option.value)}
              >
                {option.icon}
                <span className="select-option-text">
                  <span className="select-option-label">{option.label}</span>
                  {option.description && (
                    <span className="select-option-description">{option.description}</span>
                  )}
                </span>
                {option.note && <span className="select-note">{option.note}</span>}
                {option.value === value && (
                  <span className="select-tick" aria-hidden="true">
                    ✓
                  </span>
                )}
              </div>
            ))}

            {matches.length === 0 && <p className="select-empty">{emptyText}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
