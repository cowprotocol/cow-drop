import type { Address } from 'viem'

import type { KeeperDrop, KeeperDropList } from './keeper.js'
import type { SavedDrop } from './storage.js'

/**
 * Merging what this browser saved with what a keeper holds.
 *
 * Pure, so the awkward part — which of three populations a row belongs to, and what may honestly be
 * claimed about it — can be reasoned about without a browser. The component only renders the result.
 *
 * The populations differ in the one way that matters: **whether this browser has the recipe.** Without
 * it a drop cannot be activated or rescued by anyone, owner included, because only its hash is
 * on-chain. So a keeper row and a saved row look similar and are not remotely the same thing, and the
 * merge keeps them apart rather than blending them into one list.
 */

/** Where a row came from. `both` is a saved recipe the keeper also holds. */
export type DropOrigin = 'local' | 'keeper' | 'both'

/**
 * How the keeper's answer bears on one row.
 *
 * The first five are the states the saved list has always shown. `other-chain` and `keeper-only` are
 * new, and both replace a claim that used to be made wrongly or not at all.
 */
export type KeeperState =
  /** Never sent to a keeper. */
  | 'none'
  | 'watching'
  | 'held'
  /** Sent, on this keeper's chain, and absent from its answer. The one that needs acting on. */
  | 'missing'
  | 'unreachable'
  /** Sent, but to a keeper for a different chain than the one configured now. */
  | 'other-chain'
  /** The keeper has it and this browser does not, so nothing here can act on it. */
  | 'keeper-only'
  /** Sent, but nothing could be confirmed — the listing was filtered by an owner this row is not. */
  | 'unchecked'

export interface MergedDrop {
  /** `chainId:address`, lowercased — the same address exists on every chain, so the chain is identity. */
  key: string
  address: Address
  chainId: number
  label: string
  origin: DropOrigin
  /** Present only when this browser holds the recipe. Without it there is nothing to act with. */
  saved?: SavedDrop
  keeper?: KeeperDrop
  /** From the local recipe when there is one, otherwise from the keeper's record. Lowercased. */
  owner: Address | null
  keeperState: KeeperState
  at: number
}

export interface MergeInput {
  local: SavedDrop[]
  /** Null when there is no keeper, or no account to ask about. */
  remote: KeeperDropList | null
  /** True when the listing request failed, so "sent but absent" cannot honestly be claimed. */
  remoteFailed: boolean
  account: Address | null
  /** The keeper's chain. Null means chain gating is unavailable, so `missing` is never claimed. */
  keeperChainId: number | null
}

export interface MergedGroups {
  /** This account, recipe in this browser. Full affordances. */
  mine: MergedDrop[]
  /** This account, no recipe here. Read-only, and not to be trusted — see `keeper-only`. */
  keeperOnly: MergedDrop[]
  /** In this browser but owned by another account. Full affordances; shown, never hidden. */
  otherOwners: MergedDrop[]
}

/** Chain plus lowercased address. Both sides need lowercasing: we store checksummed, the keeper does not. */
export function dropKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`
}

function lower(address: string): Address {
  return address.toLowerCase() as Address
}

export function mergeDrops(input: MergeInput): MergedGroups {
  const { local, remote, remoteFailed, account, keeperChainId } = input
  const owner = account ? lower(account) : null

  const localByKey = new Map(local.map((drop) => [dropKey(drop.chainId, drop.address), drop]))
  const remoteByKey = new Map(
    (remote?.drops ?? []).map((drop) => [dropKey(remote!.chainId, drop.address), drop]),
  )

  const merged: MergedDrop[] = []
  for (const key of new Set([...localByKey.keys(), ...remoteByKey.keys()])) {
    const saved = localByKey.get(key)
    const keeper = remoteByKey.get(key)
    const origin: DropOrigin = saved && keeper ? 'both' : saved ? 'local' : 'keeper'
    const rowOwner = saved ? lower(saved.recipe.owner) : keeper ? lower(keeper.owner) : null
    const chainId = saved?.chainId ?? keeper!.chainId

    merged.push({
      key,
      address: saved?.address ?? keeper!.address,
      chainId,
      label: saved?.label ?? keeper!.label,
      origin,
      saved,
      keeper,
      owner: rowOwner,
      keeperState: stateOf({ saved, keeper, origin, chainId, rowOwner, owner, keeperChainId, remoteFailed }),
      /*
       * Local `savedAt` — the *first* save — rather than `updatedAt`, so a row does not jump because an
       * unrelated copy-address re-saved its recipe. Note this mixes two clocks: local times are this
       * browser's and `registeredAt` is the server's, so ordering across the two populations is
       * approximate by construction. Every row shows its own timestamp, so nobody has to trust it.
       */
      at: saved?.savedAt ?? keeper!.registeredAt,
    })
  }

  const byNewest = (a: MergedDrop, b: MergedDrop) => b.at - a.at
  return {
    mine: merged.filter((d) => d.saved && d.owner === owner && owner !== null).sort(byNewest),
    keeperOnly: merged.filter((d) => d.origin === 'keeper').sort(byNewest),
    // Everything local we did not claim above: another account's, or every row when nothing is
    // connected. Shown rather than hidden — see the component.
    otherOwners: merged.filter((d) => d.saved && !(d.owner === owner && owner !== null)).sort(byNewest),
  }
}

function stateOf(row: {
  saved?: SavedDrop
  keeper?: KeeperDrop
  origin: DropOrigin
  chainId: number
  rowOwner: Address | null
  owner: Address | null
  keeperChainId: number | null
  remoteFailed: boolean
}): KeeperState {
  if (row.origin === 'keeper') return 'keeper-only'
  if (!row.saved?.keeper) return 'none'
  if (row.keeper) return row.keeper.watching ? 'watching' : 'held'

  /*
   * Sent, and not in the answer. Before calling that `missing` — the loudest tag here — rule out the
   * two ways it can be absent for an innocent reason.
   *
   * The keeper's store is chain-scoped, so a drop registered on one chain and checked against a keeper
   * for another was previously reported as `missing`: the scariest tag in the app, shown wrongly.
   */
  if (row.keeperChainId !== null && row.chainId !== row.keeperChainId) return 'other-chain'
  if (row.remoteFailed) return 'unreachable'
  /*
   * The listing was filtered by one owner, so it says nothing about a row belonging to another. Reading
   * that silence as `missing` would invent the alarm out of nothing.
   */
  if (row.owner === null || row.rowOwner !== row.owner) return 'unchecked'
  if (row.keeperChainId === null) return 'unchecked'
  return 'missing'
}

/**
 * Why a retired drop stopped, and whether that is reversible.
 *
 * Only `unregistered` revives: handing the same recipe back to `/v1/drops/register` resumes the watch.
 * Every other reason is a fact about the drop rather than a choice about the keeper — `once-consumed`
 * cannot fire twice, `expired` is past its committed window, `terminal-revert` would revert again — so
 * re-registering those returns the retired record untouched. Kept in step with `registerDrop` in
 * `packages/keeper/src/registry.ts`, which is where that rule actually lives.
 *
 * Typed loosely against the wire (`retiredReason?: string`) on purpose: a keeper newer than this page
 * may send a reason it has never heard of, and the honest answer to that is the unqualified label
 * rather than a wrong one.
 */
const RESUMABLE_REASON = 'unregistered'

export function isResumable(retiredReason: string | undefined): boolean {
  return retiredReason === RESUMABLE_REASON
}

/**
 * The retired labels, split by reason.
 *
 * `paused` versus `done` is doing the work here — it is the resumable/terminal distinction in the first
 * word, which is the part that survives being read at a glance in a small uppercase pill. The reason
 * itself follows, and the tooltip says what to do about it.
 */
const HELD_LABELS: Record<string, string> = {
  unregistered: 'keeper paused — you stopped it',
  'once-consumed': 'keeper done — already activated',
  expired: 'keeper done — window passed',
  'never-funded': 'keeper done — never funded',
  'terminal-revert': 'keeper done — activation reverted',
}

/** What each state says, in the second person, because the reader is the person it is about. */
export function keeperLabel(state: KeeperState, retiredReason?: string): string {
  if (state === 'watching') return 'keeper watching'
  // Unqualified when the keeper sent no reason, or one this page does not know: the two claims the tag
  // has always made — the keeper has it, nothing is polling it — are true whatever the reason turns
  // out to be, so falling back to them says less rather than something wrong.
  if (state === 'held') return HELD_LABELS[retiredReason ?? ''] ?? 'keeper holds, not watching'
  if (state === 'missing') return 'sent, keeper has no record'
  if (state === 'unreachable') return 'sent, keeper unreachable'
  if (state === 'other-chain') return 'keeper is on another chain'
  if (state === 'keeper-only') return 'keeper only — no recipe here'
  if (state === 'unchecked') return 'sent, not checked'
  return 'local only'
}

/**
 * The sentence behind each tag.
 *
 * The tag has to fit in a pill, and what the reader needs is two things that do not: what the keeper is
 * or is not doing, and what — if anything — to do next. Every state gets one, including the reassuring
 * ones, because a tooltip that appears on only the alarming tags turns hovering into a way of finding
 * out you are in trouble.
 */
const TOOLTIPS: Record<KeeperState, string> = {
  none:
    'Never sent to a keeper, so nothing is watching this drop. It activates when someone sends the ' +
    'activation themselves — which anyone holding the recipe can do.',
  watching:
    'The keeper is polling this drop and will activate it once its balances make the recipe simulate.',
  held:
    'The keeper still holds this drop and its recipe, but is no longer polling it, so it will not be ' +
    'activated for you.',
  missing:
    'This browser sent this drop to a keeper and that keeper has no record of it — most often a keeper ' +
    'restarted with in-memory state. Nothing is watching it: register it again, or activate it yourself.',
  unreachable:
    'The keeper could not be reached, so nothing about this row could be confirmed. It may well still ' +
    'be watched.',
  'other-chain':
    'This drop is on a different chain than the keeper configured now, so that keeper knows nothing ' +
    'about it either way. A keeper for this drop’s chain would have to be asked.',
  'keeper-only':
    'A keeper has this drop and this browser does not hold its recipe. Only the hash of the recipe is ' +
    'on-chain, so nothing here can load, activate or rescue it.',
  unchecked:
    'Sent to a keeper, but the listing was filtered by a different owner, so nothing about this row ' +
    'could be confirmed.',
}

/** The `held` tooltips, which are the ones that say what — if anything — brings the watch back. */
const HELD_TOOLTIPS: Record<string, string> = {
  unregistered:
    'The keeper still holds this drop and its recipe, but stopped polling because you unregistered it. ' +
    'Registering the same recipe again resumes the watch.',
  'once-consumed':
    'A one-shot drop that has already been activated, so there is nothing left for the keeper to wait ' +
    'for. The record and the recipe are kept.',
  expired:
    'Its committed window has passed, so an activation can no longer succeed. Re-registering will not ' +
    'resume it.',
  'never-funded':
    'Nothing ever arrived at this drop, so the keeper stopped polling it. Re-registering will not ' +
    'resume it.',
  'terminal-revert':
    'An activation reverted in a way that would revert again, so the keeper stopped. Re-registering ' +
    'will not resume it — the recipe itself has to change.',
}

export function keeperTooltip(state: KeeperState, retiredReason?: string): string {
  // Same fallback as the label: an unknown reason gets the unqualified sentence rather than a guess.
  if (state === 'held') return HELD_TOOLTIPS[retiredReason ?? ''] ?? TOOLTIPS.held
  return TOOLTIPS[state]
}
