import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import { getDropChain } from '@cowprotocol/cow-drop-sdk'
import { useState } from 'react'

import { forgetDrop, listDrops, type SavedDrop } from '../lib/storage.js'

/**
 * Recipes saved in this browser.
 *
 * The list exists because a drop address without its recipe is a dead end — see `storage.ts`. It is
 * shown near the top rather than buried, since the moment you need it is the moment you have already
 * funded something and cannot remember what you funded it with.
 */
export function SavedDrops({
  currentAddress,
  onLoad,
}: {
  currentAddress: string | null
  onLoad: (recipe: DropRecipeJson) => void
}) {
  const [drops, setDrops] = useState<SavedDrop[]>(() => listDrops())

  if (drops.length === 0) return null

  const remove = (drop: SavedDrop) => {
    forgetDrop(drop.address, drop.chainId)
    setDrops(listDrops())
  }

  return (
    <details className="saved" open={drops.length > 0 && currentAddress === null}>
      <summary>Saved drops ({drops.length})</summary>

      <p className="hint">
        Kept in this browser only, and a recipe is the only way to activate or recover its drop — so keep
        the downloaded <code>.drop.json</code> somewhere durable. Clearing site data loses these.
      </p>

      <ul className="saved-list">
        {drops.map((drop) => (
          <li key={`${drop.chainId}:${drop.address}`}>
            <div className="saved-main">
              <strong>{drop.label}</strong>
              <code>{drop.address}</code>
              <span className="saved-meta">
                {getDropChain(drop.chainId)?.name ?? `chain ${drop.chainId}`} ·{' '}
                {new Date(drop.savedAt).toLocaleDateString()}
                {drop.address.toLowerCase() === currentAddress?.toLowerCase() ? ' · showing now' : ''}
              </span>
            </div>
            <div className="saved-actions">
              <button onClick={() => onLoad(drop.recipe)}>Load</button>
              <button onClick={() => remove(drop)}>Forget</button>
            </div>
          </li>
        ))}
      </ul>
    </details>
  )
}
