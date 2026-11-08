import { getDropChain } from '@cowprotocol/cow-drop-sdk'
import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address } from 'viem'
import { useMemo, useState } from 'react'

import { DropRow } from '../components/DropRow.js'
import {
  ALL,
  ChainFilterSelect,
  OwnerFilterSelect,
  ownerMatches,
  type ChainFilter,
  type OwnerFilter,
} from '../components/ListFilters.js'
import { Section } from '../components/Section.js'
import { Tooltip } from '../components/Tooltip.js'
import { useDropList } from '../components/DropList.js'
import { isUserRejection, signTypedDataWith } from '../lib/chain.js'
import type { MergedDrop } from '../lib/dropList.js'
import { exportKeeperRecipes, keeperUrl } from '../lib/keeper.js'
import { saveDrop } from '../lib/storage.js'

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
  /** The recipe recovery below: in flight, how many came back, and why it did not. */
  const [recovering, setRecovering] = useState(false)
  const [recovered, setRecovered] = useState<number | null>(null)
  const [recoverError, setRecoverError] = useState<string | null>(null)
  const hasKeeper = keeperUrl() !== null
  const keeperChain = remote ? (getDropChain(remote.chainId)?.name ?? `chain ${remote.chainId}`) : null

  /*
   * With no wallet connected there is no account to compare an owner against, so nothing is "somebody
   * else's" — every saved recipe is simply one this browser holds. Grouping them under "other accounts"
   * and collapsing it would hide the whole list behind a heading that is not even true yet.
   */
  const primary = account ? groups.mine : groups.otherOwners
  const others = account ? groups.otherOwners : []

  /*
   * The same two filters the activity feed has, over the same kind of list.
   *
   * Applied to the primary group only. "Other accounts" is already an owner filter — it is the rows
   * whose owner is not the connected one — and filtering a filter would be two controls disagreeing
   * about the same question.
   */
  const [chain, setChain] = useState<ChainFilter>(ALL)
  const [owner, setOwner] = useState<OwnerFilter>(ALL)

  const shown = useMemo(
    () =>
      primary.filter(
        (drop) => (chain === ALL || drop.chainId === chain) && ownerMatches(owner, drop.owner),
      ),
    [primary, chain, owner],
  )

  /** One signature for all the rows: a prompt per drop teaches people to click through prompts. */
  const recover = async () => {
    if (!account || !remote) return

    setRecovering(true)
    setRecovered(null)
    setRecoverError(null)
    try {
      const drops = await exportKeeperRecipes({
        owner: account,
        chainId: remote.chainId,
        sign: (typedData) => signTypedDataWith(remote.chainId, account, typedData),
      })
      // `saveDrop` re-derives the address, so a recipe that does not hash to it never lands.
      for (const drop of drops) saveDrop({ address: drop.address, recipe: drop.recipe })
      setRecovered(drops.length)
      reload()
    } catch (cause) {
      setRecoverError(
        isUserRejection(cause)
          ? 'Signature rejected — nothing was fetched.'
          : cause instanceof Error
            ? cause.message
            : String(cause),
      )
    } finally {
      setRecovering(false)
    }
  }

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
      {/*
        Open, unlike the panels below it. This is what the tab is for — the rest are answers to
        questions you arrived with, and they stay folded so this one is not pushed off the screen by
        them. The counts in their headings are what makes that safe: a closed panel still says
        whether there is anything inside it.
      */}
      <Section title={<>Your drops <Count n={primary.length} /></>}>
        <p className="hint">
          Kept in this browser only. Download the <code>.drop.json</code> for anything you care about.
          <Tooltip title="Why it matters">
            A recipe is the only way to activate or recover its drop. Clearing site data loses these,
            and nobody can reconstruct them for you.
          </Tooltip>
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

        {primary.length > 0 && (
          <div className="list-filters">
            <ChainFilterSelect
              chainIds={primary.map((drop) => drop.chainId)}
              value={chain}
              onChange={setChain}
              noun="drop"
              total={primary.length}
            />
            <OwnerFilterSelect
              owners={primary.map((drop) => drop.owner)}
              value={owner}
              onChange={setOwner}
              noun="drop"
              total={primary.length}
              account={account}
            />
          </div>
        )}

        {shown.length > 0 ? rows(shown) : null}

        {primary.length > 0 && shown.length === 0 ? (
          <p className="hint">No drop matches this filter.</p>
        ) : null}

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
      </Section>

      {groups.keeperOnly.length > 0 ? (
        <Section
          title={
            <>
              The keeper for {keeperChain} also has <Count n={groups.keeperOnly.length} />
            </>
          }
          open={false}
        >
          <p className="hint">
            This keeper holds recipes naming your account, and this browser does not have them. Prove
            the account is yours to get them back, import the <code>.drop.json</code>, or open this page
            in the browser you made them in.
            <Tooltip title="Why you cannot act on them yet">
              Loading, activating and rescuing all need the recipe bytes, and only the keeper has them.
            </Tooltip>
          </p>

          <div className="saved-actions">
            <button type="button" onClick={() => void recover()} disabled={recovering || !account}>
              {recovering ? 'Waiting for your signature…' : 'Recover these recipes'}
            </button>
          </div>

          {recovered !== null ? (
            <p className="hint">
              Recovered {recovered} {recovered === 1 ? 'recipe' : 'recipes'} into this browser, under{' '}
              <strong>Your drops</strong> above. <strong>Read one before funding it.</strong>
              <Tooltip title="Read it first">
                A signature proves you control this account, not that you wrote the recipe naming it. It
                may pay its surplus to someone else.
              </Tooltip>
            </p>
          ) : null}
          {recoverError ? <p className="hint warn-box">{recoverError}</p> : null}
          <p className="hint warn-box">
            <strong>A row here is not proof that you made it.</strong> Anyone may register a recipe
            naming any owner. Never fund an address from this list — fund only one your own browser
            derived from a recipe you chose.
          </p>
          {rows(groups.keeperOnly)}
        </Section>
      ) : null}

      {others.length > 0 ? (
        <Section title={<>Other accounts in this browser <Count n={others.length} /></>} open={false}>
          <p className="hint">
            Saved here, but owned by another account. They still load.
            <Tooltip title="Why these are shown">
              Hidden, a drop you funded would vanish the moment you switched wallets — the exact
              failure this page exists to prevent.
            </Tooltip>
          </p>
          {rows(others)}
        </Section>
      ) : null}

      {hasKeeper && keeperChain ? (
        <p className="hint">
          This keeper watches <strong>{keeperChain}</strong> only. Drops on other chains come from this
          browser's own records, with keeper status unknown.
        </p>
      ) : null}
    </>
  )
}

/**
 * How many rows a panel holds, shown in its heading.
 *
 * Load-bearing now that the panels start closed: a heading with nothing after it gives no reason to
 * open it, and no reason not to either.
 */
function Count({ n }: { n: number }) {
  return <span className="section-count">({n})</span>
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
