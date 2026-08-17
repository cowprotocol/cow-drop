import { useEffect, useMemo, useRef, useState } from 'react'
import type { Address } from 'viem'

import type { TokenInfo } from '../lib/tokenList.js'
import { findToken } from '../lib/tokenList.js'
import { TokenLogo } from './TokenLogo.js'

/**
 * Token selector with logos.
 *
 * A native `<select>` cannot show images, which is the whole point here — so this is a button plus a
 * filterable popover. Kept keyboard-usable: Escape closes, the filter is focused on open, and the
 * trigger is a real button.
 */
export function TokenPicker({
  label,
  tokens,
  value,
  chainId,
  onChange,
}: {
  label: string
  tokens: TokenInfo[]
  value: Address
  chainId: number
  onChange: (address: Address) => void
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  const selected = findToken(tokens, value)

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return tokens
    return tokens.filter(
      (token) =>
        token.symbol.toLowerCase().includes(needle) ||
        token.name?.toLowerCase().includes(needle) ||
        token.address.toLowerCase().includes(needle),
    )
  }, [tokens, filter])

  // Close on an outside click or Escape, so the popover behaves like one.
  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    filterRef.current?.focus()

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const choose = (address: Address) => {
    onChange(address)
    setOpen(false)
    setFilter('')
  }

  return (
    <div className="token-picker" ref={containerRef}>
      <span className="token-picker-label">{label}</span>

      <button
        type="button"
        className="token-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {selected ? (
          <>
            <TokenLogo token={selected} chainId={chainId} />
            <span>{selected.symbol}</span>
          </>
        ) : (
          <span className="muted">Select a token</span>
        )}
        <span className="token-picker-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="token-picker-popover">
          <input
            ref={filterRef}
            placeholder="Symbol, name or address"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <ul role="listbox">
            {matches.map((token) => (
              <li key={token.address}>
                <button
                  type="button"
                  role="option"
                  aria-selected={token.address.toLowerCase() === value.toLowerCase()}
                  className={token.address.toLowerCase() === value.toLowerCase() ? 'selected' : ''}
                  onClick={() => choose(token.address)}
                >
                  <TokenLogo token={token} chainId={chainId} />
                  <span className="token-picker-symbol">{token.symbol}</span>
                  {token.name && <span className="token-picker-name">{token.name}</span>}
                </button>
              </li>
            ))}
            {matches.length === 0 && <li className="token-picker-empty">No token matches “{filter}”</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
