import { getDropChain } from '@cowprotocol/cow-drop-sdk'
import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address } from 'viem'
import { useState } from 'react'

import { DropRow } from '../components/DropRow.js'
import { useDropList } from '../components/DropList.js'
import type { MergedDrop } from '../lib/dropList.js'
import { keeperUrl } from '../lib/keeper.js'

/**
 * Every drop associated with the connected account, from both sides that know anything about one.
 *
 * The two sources answer different questions and neither is complete. This browser holds the recipes,
 * which is the only thing that can activate or rescue a drop — but it only knows what *it* saved. The
 * keeper knows what was registered from anywhere, but hands out no recipes. So the tab shows both and
 * says which is which, rather than merging them into a list that implies more than it can do.
 */
export function DropsTab({
  account,
  revision,
  currentAddress,
  onLoad,
}: {
  account: Address | null
  /** Bumped by the shell whenever a drop is written, so this re-reads `localStorage`. */
  revision: number
  currentAddress: Address | null
  /** Loads the recipe *and* moves to the Recipes tab — a load that left you here looks like nothing. */
  onLoad: (recipe: DropRecipeJson) => void
}) {
  const { groups, remote, remoteFailed, loading, total, reload, forget } = useDropList(account, revision)
  /** Key of the drop whose Forget was clicked, waiting to be confirmed. */
  const [pendingForget, setPendingForget] = useState<string | null>(null)
  const hasKeeper = keeperUrl() !== null
  const keeperChain = remote ? (getDropChain(remote.chainId)?.name ?? `chain ${remote.chainId}`) : null

  /*
   * With no wallet connected there is no account to compare an owner against, so nothing is "somebody
   * else's" — every saved recipe is simply one this browser holds. Grouping them under "other accounts"
   * and collapsing it would hide the whole list behind a heading that is not even true yet.
   */
  const primary = account ? groups.mine : groups.otherOwners
  const others = account ? groups.otherOwners : []

  const rows = (drops: MergedDrop[]) => (
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
  )

  return (
    <>
      <section>
        <h2>Your drops</h2>
        <p className="hint">
          Recipes are kept in this browser only, and a recipe is the only way to activate or recover its
          drop — so keep the downloaded <code>.drop.json</code> somewhere durable. Clearing site data
          loses these.
        </p>

        <div className="saved-actions">
          <button onClick={reload} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {total === 0 ? <p className="hint">{emptyMessage({ hasKeeper, account, keeperChain, remoteFailed })}</p> : null}

        {/* The endpoint requires an owner, so with no wallet there is nothing to ask it. */}
        {hasKeeper && !account && total > 0 ? (
          <p className="hint">Connect a wallet to also see drops this keeper holds for your account.</p>
        ) : null}

        {primary.length > 0 ? rows(primary) : null}

        {/* Not an empty list: a keeper that did not answer must never read as "you have nothing". */}
        {remoteFailed ? (
          <p className="hint warn-box">
            The keeper did not answer, so this list is only what is in this browser.
          </p>
        ) : null}

        {remote?.truncated ? (
          <p className="hint">
            Showing the {remote.drops.length} newest of {remote.total} the keeper holds for this account.
          </p>
        ) : null}
      </section>

      {groups.keeperOnly.length > 0 ? (
        <section>
          <h2>The keeper for {keeperChain} also has</h2>
          <p className="hint">
            This keeper holds a recipe naming your account as owner, and this browser does not have it.
            You can see these and follow them on a block explorer, but you cannot load, activate or
            rescue them from here: all three need the recipe bytes, and the keeper does not hand those
            out. Import the <code>.drop.json</code>, or open this page in the browser you made it in.
          </p>
          <p className="hint warn-box">
            <strong>A row here is not proof that you made it.</strong> Anyone may register a recipe
            naming any owner, so this means <em>someone registered this and said you own it</em>. Never
            send funds to an address from this list — fund only an address your own browser derived from
            a recipe you chose.
          </p>
          {rows(groups.keeperOnly)}
        </section>
      ) : null}

      {others.length > 0 ? (
        <section>
          <details>
            <summary>Other accounts in this browser ({others.length})</summary>
            <p className="hint">
              Recipes saved here whose owner is not the connected account. Shown rather than hidden: with
              several accounts you would otherwise watch a drop you funded vanish the moment you switched
              wallets, which is the exact failure this page exists to prevent. The recipe is here, so
              these still load.
            </p>
            {rows(others)}
          </details>
        </section>
      ) : null}

      {hasKeeper && keeperChain ? (
        <p className="hint">
          This keeper watches <strong>{keeperChain}</strong> only. Drops on other chains appear here from
          this browser's own records, and their keeper status is unknown.
        </p>
      ) : null}
    </>
  )
}

/** Three distinct nothings, because they call for three different next steps. */
function emptyMessage(context: {
  hasKeeper: boolean
  account: Address | null
  keeperChain: string | null
  remoteFailed: boolean
}): string {
  if (context.remoteFailed) return 'The keeper did not answer, and this browser has nothing saved.'
  if (!context.hasKeeper) {
    return 'Nothing saved in this browser, and no keeper is configured — so there is nowhere else to ask.'
  }
  if (!context.account) {
    return 'Nothing saved in this browser. Connect a wallet to also see what the keeper holds for your account.'
  }
  return `Nothing in this browser, and the keeper${
    context.keeperChain ? ` for ${context.keeperChain}` : ''
  } has no drop naming this account.`
}
