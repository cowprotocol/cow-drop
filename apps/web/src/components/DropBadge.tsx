import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import { useState } from 'react'
import type { Address } from 'viem'

import { chainLabel, explorerAddressUrl } from '../lib/chain.js'
import { routeHash } from '../lib/route.js'
import { ChainLogo } from './ChainLogo.js'
import { QrZoom } from './QrZoom.js'

/**
 * The drop currently on the bench, in the header.
 *
 * The address used to exist only inside step 3, which meant that the moment you scrolled past it —
 * to set a guard, to read the committed steps, to watch the status — the one thing anybody else
 * needs was off screen. This keeps it in reach: the name, the chain, a QR to hold up, and the two
 * ways an address leaves this page.
 *
 * Shown in full, never truncated. An address is the thing money is sent to, and a reader comparing
 * what is on their screen against what is in their wallet cannot do it against an ellipsis — which
 * is exactly the check that catches an address swapped in flight.
 *
 * Deliberately not a second copy of step 3. There is no "keep the recipe" warning here and no
 * download: those belong at the moment the address is first produced, and repeating them would
 * teach people to skip them. This is a reminder of what is loaded, not a place to act on it.
 */
export function DropBadge({
  recipe,
  address,
  onRemember,
}: {
  recipe: DropRecipeJson
  address: Address
  /** Copying or sharing hands the address to someone else — a moment the recipe has to survive. */
  onRemember: () => void
}) {
  const [copied, setCopied] = useState(false)
  const explorer = explorerAddressUrl(recipe.chainId, address)

  const copy = async () => {
    /*
     * Remembered first, and not conditionally.
     *
     * `writeText` rejects for reasons that have nothing to do with the drop — an unfocused document
     * is enough — and the recipe surviving matters more than the copy landing. Behind the old order
     * a refused clipboard meant the recipe was never saved, which is the one failure this app cannot
     * afford: an address someone then funds, with no recipe to activate or recover it.
     */
    onRemember()
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Nothing useful to say: the address is on screen in full, and selectable.
    }
  }

  return (
    <div className="drop-badge">
      <QrZoom value={address} label={recipe.label} />

      <div className="drop-badge-text">
        <strong>{recipe.label}</strong>

        {/*
          The chain's mark sits on the address line rather than above it: which chain an address is
          on is part of reading the address, not a separate fact about the drop. Sending to the right
          address on the wrong chain is the mistake this is here to prevent.
        */}
        <span className="drop-badge-address">
          <ChainLogo chainId={recipe.chainId} size={16} />
          {explorer ? (
            <a href={explorer} target="_blank" rel="noreferrer" title={`View on ${chainLabel(recipe.chainId)}`}>
              <code>{address}</code>
            </a>
          ) : (
            <code>{address}</code>
          )}
        </span>
      </div>

      <div className="drop-badge-actions">
        <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
        <a
          className="button"
          href={routeHash({ tab: 'share', recipe })}
          target="_blank"
          rel="noreferrer"
          onClick={onRemember}
        >
          Share ↗
        </a>
      </div>
    </div>
  )
}
