import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address } from 'viem'
import { useState } from 'react'

import { useDropList } from './DropList.js'
import { DropRow } from './DropRow.js'

/**
 * The drop list, folded into the builder.
 *
 * The same rows the Drops tab shows, from the same `useDropList` — deliberately not a second
 * implementation. The list is also its own tab, and it is *still* here because the moment you need it
 * is the moment you have already funded something and cannot remember what you funded it with; a tab
 * away is fine, out of sight on the page where the funding happens is not.
 *
 * What differs from the tab is only the framing: folded behind a summary, and without the keeper-only
 * and other-accounts groups, which are a list to study rather than something to glance at mid-build.
 */
export function SavedDrops({
  account,
  revision,
  currentAddress,
  onLoad,
  onSeeAll,
}: {
  account: Address | null
  /** Bumped by the page whenever a drop is written, so this list re-reads `localStorage`. */
  revision: number
  currentAddress: string | null
  onLoad: (recipe: DropRecipeJson) => void
  /** Moves to the Drops tab, where the keeper's own rows live. */
  onSeeAll: () => void
}) {
  const { groups, forget } = useDropList(account, revision)
  /** Key of the drop whose Forget was clicked, waiting to be confirmed. */
  const [pendingForget, setPendingForget] = useState<string | null>(null)

  // Everything this browser holds a recipe for, whoever owns it. The builder is not the place to sort
  // by account: a recipe you saved is one you may be about to fund, connected wallet or not.
  const drops = [...groups.mine, ...groups.otherOwners].sort((a, b) => b.at - a.at)
  if (drops.length === 0) return null

  return (
    <details className="saved" open={currentAddress === null}>
      <summary>Saved drops ({drops.length})</summary>

      <p className="hint">
        Kept in this browser only, and a recipe is the only way to activate or recover its drop — so keep
        the downloaded <code>.drop.json</code> somewhere durable. Clearing site data loses these.{' '}
        <button className="link" onClick={onSeeAll}>
          See all drops
        </button>{' '}
        for what the keeper holds too.
      </p>

      <ul className="saved-list">
        {drops.map((drop) => (
          <DropRow
            key={drop.key}
            drop={drop}
            currentAddress={currentAddress}
            pendingForget={pendingForget === drop.key}
            onLoad={onLoad}
            onForget={(target) => {
              forget(target)
              setPendingForget(null)
            }}
            onForgetRequest={setPendingForget}
            onForgetCancel={() => setPendingForget(null)}
          />
        ))}
      </ul>
    </details>
  )
}
