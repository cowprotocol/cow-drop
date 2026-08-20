import { getDropChain } from '@cowprotocol/cow-drop-sdk'
import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'

import { isResumable, keeperLabel, keeperTooltip, type MergedDrop } from '../lib/dropList.js'

/**
 * One drop in a list.
 *
 * Split out of the old saved-drops panel so the builder and the Drops tab render the *same* rows. The
 * Forget confirmation below is the most safety-critical copy in the app; it is deliberately identical
 * in both places, which is only guaranteed by there being one copy of it.
 */
export function DropRow({
  drop,
  currentAddress,
  pendingForget,
  onLoad,
  onForget,
  onForgetRequest,
  onForgetCancel,
}: {
  drop: MergedDrop
  currentAddress: string | null
  /** Whether this row's Forget was clicked and is waiting to be confirmed. */
  pendingForget: boolean
  onLoad: (recipe: DropRecipeJson) => void
  onForget: (drop: MergedDrop) => void
  onForgetRequest: (key: string) => void
  onForgetCancel: () => void
}) {
  /*
   * No recipe, so no controls. Loading, activating and rescuing all need the exact `setupData` bytes,
   * and only their hash is on-chain — so the absence of a button here is not a UI gap, it is the truth
   * about what this browser can do with this row.
   */
  const readOnly = drop.saved === undefined

  return (
    <li>
      <div className="saved-main">
        <strong>{drop.label}</strong>
        <code>{drop.address}</code>
        <span className="saved-meta">
          {getDropChain(drop.chainId)?.name ?? `chain ${drop.chainId}`} ·{' '}
          <time dateTime={new Date(drop.at).toISOString()}>{atLabel(drop.at)}</time>
          {drop.address.toLowerCase() === currentAddress?.toLowerCase() ? ' · showing now' : ''}
        </span>
        {/*
         * `title` rather than a custom popover: the tag is a label, not a control, and the sentence
         * behind it is a nicety — a hand-rolled tooltip here would have to solve focus, dismissal and
         * touch for something nobody has to read. `aria-label` carries the same sentence, since the tag
         * text alone is the abbreviation.
         */}
        <span
          className={`keeper-tag ${tagClass(drop)}`}
          title={keeperTooltip(drop.keeperState, drop.keeper?.retiredReason)}
          aria-label={keeperTooltip(drop.keeperState, drop.keeper?.retiredReason)}
        >
          {keeperLabel(drop.keeperState, drop.keeper?.retiredReason)}
        </span>
        {/* Whose it is, so it is obvious why a row is in the other-accounts group. */}
        {readOnly && drop.owner ? <span className="saved-meta">owner {drop.owner}</span> : null}
      </div>

      {readOnly ? null : (
        <div className="saved-actions">
          <button onClick={() => onLoad(drop.saved!.recipe)}>Load</button>
          <button onClick={() => onForgetRequest(drop.key)} disabled={pendingForget} aria-expanded={pendingForget}>
            Forget
          </button>
        </div>
      )}

      {pendingForget ? (
        <div className="saved-confirm warn-box" role="alertdialog" aria-label={`Forget ${drop.label}?`}>
          <p>
            <strong>This can cost you the drop.</strong> Forgetting only deletes the recipe from this
            browser — nothing on-chain changes and any funds stay where they are. But the recipe is what
            activates the drop and the only record of its address here, so unless you kept the
            downloaded <code>.drop.json</code>, whatever the drop holds now or receives later is out of
            reach for good.
          </p>
          {drop.saved?.keeper ? (
            <p>
              The keeper also keeps this drop, and telling it to stop needs the recipe you are about to
              delete.
            </p>
          ) : null}
          <div className="saved-actions">
            {/* Cancel first and focused: the safe choice is where a second click already is. */}
            <button autoFocus onClick={onForgetCancel}>
              Cancel
            </button>
            <button className="danger" onClick={() => onForget(drop)}>
              Forget anyway
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function tagClass(drop: MergedDrop): string {
  if (drop.keeperState === 'missing') return 'warn'
  // Muted for the states that are "nothing to do here": never sent, out of this keeper's scope, or a
  // row this browser cannot act on at all.
  if (drop.keeperState === 'none' || drop.keeperState === 'other-chain' || drop.keeperState === 'keeper-only') {
    return 'muted'
  }
  if (drop.keeperState === 'unchecked') return 'muted'
  // Retired for a terminal reason is the same "nothing to do here": no amount of re-registering brings
  // it back. Retired because *you* stopped it keeps full weight, because that one is a door still open.
  if (drop.keeperState === 'held' && !isResumable(drop.keeper?.retiredReason)) return 'muted'
  return ''
}

/**
 * Date and time, to the minute.
 *
 * The minute matters more than it looks: these addresses differ by a parameter you may not remember
 * changing, and several get created in one sitting. A date alone cannot tell two of them apart.
 */
function atLabel(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}
