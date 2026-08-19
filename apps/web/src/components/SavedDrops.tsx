import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import { getDropChain } from '@cowprotocol/cow-drop-sdk'
import { useEffect, useState } from 'react'

import { keeperUrl, readKeeperDrop } from '../lib/keeper.js'
import { forgetDrop, listDrops, type SavedDrop } from '../lib/storage.js'

/**
 * What the keeper says about each saved drop, once asked.
 *
 * `'watching'` / `'held'` come from the keeper. `'missing'` is the one worth having: this browser
 * recorded sending the drop and the keeper does not have it — which happens for real, because the
 * keeper's `--state` defaults to memory only and a restart loses every registration. `'unreachable'`
 * keeps that distinct from a keeper that is simply down, since the two call for opposite reactions.
 */
type KeeperState = 'watching' | 'held' | 'missing' | 'unreachable'

function keeperLabel(state: KeeperState): string {
  if (state === 'watching') return 'keeper watching'
  if (state === 'held') return 'keeper holds, not watching'
  if (state === 'missing') return 'sent, keeper has no record'
  return 'sent, keeper unreachable'
}

/**
 * Recipes saved in this browser.
 *
 * The list exists because a drop address without its recipe is a dead end — see `storage.ts`. It is
 * shown near the top rather than buried, since the moment you need it is the moment you have already
 * funded something and cannot remember what you funded it with.
 */
export function SavedDrops({
  revision,
  currentAddress,
  onLoad,
}: {
  /** Bumped by the page whenever a drop is written, so this list re-reads `localStorage`. */
  revision: number
  currentAddress: string | null
  onLoad: (recipe: DropRecipeJson) => void
}) {
  const [drops, setDrops] = useState<SavedDrop[]>(() => listDrops())
  const [keeperStates, setKeeperStates] = useState<Record<string, KeeperState>>({})
  /** Key of the drop whose Forget was clicked, waiting to be confirmed. */
  const [pendingForget, setPendingForget] = useState<string | null>(null)

  useEffect(() => {
    setDrops(listDrops())
    // A drop written or reloaded under us is no longer the row the user aimed at.
    setPendingForget(null)
  }, [revision])

  // Confirm the local flags against the keeper rather than displaying them as fact. Only drops this
  // browser believes it sent are checked: asking about the rest would be a request per address for an
  // answer nobody claimed.
  useEffect(() => {
    if (keeperUrl() === null) return
    let live = true

    void Promise.all(
      drops
        .filter((drop) => drop.keeper)
        .map(async (drop) => {
          const key = dropKey(drop)
          try {
            const remote = await readKeeperDrop(drop.address)
            if (!remote) return [key, 'missing'] as const
            return [key, remote.watching ? 'watching' : 'held'] as const
          } catch {
            return [key, 'unreachable'] as const
          }
        }),
    ).then((entries) => {
      if (live) setKeeperStates(Object.fromEntries(entries))
    })

    return () => {
      live = false
    }
  }, [drops])

  if (drops.length === 0) return null

  const remove = (drop: SavedDrop) => {
    forgetDrop(drop.address, drop.chainId)
    setPendingForget(null)
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
          <li key={dropKey(drop)}>
            <div className="saved-main">
              <strong>{drop.label}</strong>
              <code>{drop.address}</code>
              <span className="saved-meta">
                {getDropChain(drop.chainId)?.name ?? `chain ${drop.chainId}`} ·{' '}
                <time dateTime={new Date(drop.savedAt).toISOString()}>{savedAtLabel(drop.savedAt)}</time>
                {drop.address.toLowerCase() === currentAddress?.toLowerCase() ? ' · showing now' : ''}
              </span>
              {drop.keeper ? (
                <span className={`keeper-tag ${keeperStates[dropKey(drop)] === 'missing' ? 'warn' : ''}`}>
                  {keeperLabel(keeperStates[dropKey(drop)] ?? 'unreachable')}
                </span>
              ) : (
                <span className="keeper-tag muted">local only</span>
              )}
            </div>
            <div className="saved-actions">
              <button onClick={() => onLoad(drop.recipe)}>Load</button>
              <button
                onClick={() => setPendingForget(dropKey(drop))}
                disabled={pendingForget === dropKey(drop)}
                aria-expanded={pendingForget === dropKey(drop)}
              >
                Forget
              </button>
            </div>

            {pendingForget === dropKey(drop) ? (
              <div className="saved-confirm warn-box" role="alertdialog" aria-label={`Forget ${drop.label}?`}>
                <p>
                  <strong>This can cost you the drop.</strong> Forgetting only deletes the recipe from this
                  browser — nothing on-chain changes and any funds stay where they are. But the recipe is what
                  activates the drop and the only record of its address here, so unless you kept the
                  downloaded <code>.drop.json</code>, whatever the drop holds now or receives later is out of
                  reach for good.
                </p>
                {drop.keeper ? (
                  <p>
                    The keeper also keeps this drop, and telling it to stop needs the recipe you are about to
                    delete.
                  </p>
                ) : null}
                <div className="saved-actions">
                  {/* Cancel first and focused: the safe choice is where a second click already is. */}
                  <button autoFocus onClick={() => setPendingForget(null)}>
                    Cancel
                  </button>
                  <button className="danger" onClick={() => remove(drop)}>
                    Forget anyway
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Chain plus lowercased address: the same drop on two chains is two records. */
function dropKey(drop: SavedDrop): string {
  return `${drop.chainId}:${drop.address.toLowerCase()}`
}

/**
 * Date and time, to the minute.
 *
 * The minute matters more than it looks: these addresses differ by a parameter you may not remember
 * changing, and several get created in one sitting. A date alone cannot tell two of them apart.
 */
function savedAtLabel(savedAt: number): string {
  return new Date(savedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}
