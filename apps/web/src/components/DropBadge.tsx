import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address } from 'viem'

import { routeHash } from '../lib/route.js'
import { ChainTag } from './ChainTag.js'
import { QrZoom } from './QrZoom.js'

/**
 * The drop currently on the bench, in the header.
 *
 * The address used to exist only inside step 3, which meant that the moment you scrolled past it —
 * to set a guard, to read the committed steps, to watch the status — the one thing anybody else
 * needs was off screen. This keeps it in reach: the name, the chain, a QR to hold up, and the way
 * to send it to someone.
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
  /** Sharing hands the address to someone else, which is a moment the recipe has to survive. */
  onRemember: () => void
}) {
  const short = `${address.slice(0, 10)}…${address.slice(-8)}`

  return (
    <div className="drop-badge">
      <QrZoom value={address} label={recipe.label} />

      <div className="drop-badge-text">
        <strong>{recipe.label}</strong>
        <code title={address}>{short}</code>
        <ChainTag chainId={recipe.chainId} address={address} />
      </div>

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
  )
}
