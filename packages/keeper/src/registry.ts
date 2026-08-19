import { compileRecipe, type DropDeployment, type DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address, Hex } from 'viem'

import { feeFor, isProblem, matchDocuments } from './appData.js'
import { deriveHints, HINTS_VERSION, selfDriving, tradesOf } from './hints.js'
import { DropConflict, type DropStore } from './store.js'
import type { RegisteredDrop } from './types.js'

/** Why a registration was refused, in the shape the HTTP layer maps to a status code. */
export type RegistrationError =
  | { error: 'invalid-recipe'; message: string }
  | { error: 'address-mismatch'; supplied: Address; derived: Address }
  | { error: 'wrong-chain'; supplied: number; expected: number }
  | { error: 'wrong-generation'; supplied: number; expected: number }
  | { error: 'conflict'; message: string }
  | { error: 'at-capacity'; maxDrops: number }
  /** A document was supplied that hashes to nothing the recipe committed to. */
  | { error: 'app-data-mismatch'; supplied: Hex; committed: Hex[] }
  /** `paying` mode, and the recipe promises this keeper nothing it can count on. */
  | { error: 'no-fee'; recipient: Address; detail: string }

export type RegistrationResult =
  | { ok: true; created: boolean; drop: RegisteredDrop }
  | ({ ok: false } & RegistrationError)

export interface RegisterInput {
  recipe: DropRecipeJson
  /**
   * The address the client derived.
   *
   * An assertion to be checked, never an input — see below. Optional only so a curl by hand can skip
   * it; the UI always sends it.
   */
  address?: Address
  /**
   * The full appData documents behind the recipe's committed hashes.
   *
   * The chain carries only the hash, so nothing can recover these from the recipe. Needed for two
   * jobs at once: reading the partner fee, and giving the watch tower something to upload, since
   * the order book rejects an appData hash it has never seen.
   */
  appDataDocuments?: string[]
  store: DropStore
  deployment: DropDeployment
  maxDrops: number
  now: number
  /** `paying` mode: a drop must promise this address a volume fee, or it is refused. */
  requireFeeFor?: Address
  minFeeBps?: number
}

/**
 * Take a drop into the keeper's care.
 *
 * ## The address check is the point
 *
 * The client sends the address it computed; the server compiles the recipe and compares. A mismatch
 * means the two sides derive different addresses from the same bytes — an SDK version skew, a
 * generation disagreement — and it matters more here than almost anywhere, because the failure is
 * silent: without the check the keeper would diligently watch an address nobody funded, while the user
 * watches the one they did.
 *
 * Note what is *not* worth doing: calling `deriveDropAddress` again on the same `setupData` and
 * deployment. `compileRecipe` already did exactly that, so a second call compares the SDK to itself.
 * The comparisons with content are the client's address against ours, and the recipe's chain and
 * generation against this keeper's — the last two being the only genuinely independent checks here.
 *
 * ## Registration is not authorisation
 *
 * Anyone may register anyone's drop and it grants nothing: activation is permissionless already, the
 * guards are committed into the address, and only the owner can sweep. What it does cost is capacity —
 * a recipe stored forever and an entry in every tick's poll set — which is why `maxDrops` is here and
 * why there is no unauthenticated way to *un*register.
 *
 * ## Registering twice
 *
 * A repeat is a success, not a conflict, so a client whose POST timed out can retry. Where the record
 * was retired by `unregisterDrop`, the repeat *resumes* it — see the revive branch below.
 */
export async function registerDrop(input: RegisterInput): Promise<RegistrationResult> {
  const { recipe, store, deployment, maxDrops, now } = input

  let compiled
  try {
    compiled = compileRecipe(recipe)
  } catch (cause) {
    // `compileRecipe`'s messages are written for people — "allowFailure with once is burnable by
    // anyone", and so on. Passing them through is better than anything this layer could invent.
    return { ok: false, error: 'invalid-recipe', message: cause instanceof Error ? cause.message : String(cause) }
  }

  if (compiled.deployment.chainId !== deployment.chainId) {
    return { ok: false, error: 'wrong-chain', supplied: compiled.deployment.chainId, expected: deployment.chainId }
  }

  if (compiled.deployment.generation !== deployment.generation) {
    // Not pedantry: the step contracts' addresses are CREATE2 inputs, so another generation is
    // another address, and this keeper would be watching a drop that does not exist for it.
    return {
      ok: false,
      error: 'wrong-generation',
      supplied: compiled.deployment.generation,
      expected: deployment.generation,
    }
  }

  const derived = compiled.address.toLowerCase() as Address
  if (input.address && input.address.toLowerCase() !== derived) {
    return { ok: false, error: 'address-mismatch', supplied: input.address, derived: compiled.address }
  }

  const existing = await store.get(deployment.chainId, derived)
  if (existing) {
    if (existing.setupData !== compiled.setupData) {
      return { ok: false, error: 'conflict', message: `${derived} is registered with a different recipe` }
    }

    // A drop the recipe holder stopped is resumed rather than reported as held-but-idle. Without this
    // the pair is asymmetric — unregistering works, registering again returns the retired record
    // untouched — so "stop watching" in the UI would be a one-way door that answers 200.
    //
    // Only `unregistered` revives. Every other reason is a fact about the drop rather than a choice
    // about the keeper: `once-consumed` cannot fire twice, `expired` is past its committed window,
    // `terminal-revert` would revert again. Watching those is polling for something that cannot
    // happen, so they keep the old behaviour of being returned as they are.
    if (existing.status !== 'retired' || existing.retiredReason !== 'unregistered') {
      // Idempotent on purpose. A client whose POST timed out will retry, and it can only honestly be
      // told that retrying is safe if it is.
      return { ok: true, created: false, drop: existing }
    }

    /**
     * Resume the state the stop interrupted, which is **not** always `watching`.
     *
     * A confirmed activation leaves a reusable drop in `activated`, and the tick only ever considers
     * `watching` — so `activated` is parked, deliberately. Resuming a drop that had already activated
     * as `watching` would hand it back to the simulator, and for anything still holding a balance the
     * simulation passes: the keeper would activate a second time.
     *
     * That is not a theoretical cost. A TWAP drop holds its sell balance for the whole schedule, and
     * `twapFromBalance` reads that balance at activation and passes `t0 = 0`, which makes
     * `createWithContext` seed the start time from the current block. So a second activation either
     * registers a *second* TWAP over the remaining balance, or — if the parts happen to hash
     * identically — re-seeds the cabinet and restarts the schedule over parts that already traded.
     * Neither is recoverable by unregistering again.
     *
     * Derived from the history rather than remembered in a field, because that is the same rule
     * `reconcile` applies, and a second field recording what the first one used to be is a thing that
     * goes stale.
     */
    const activated = existing.activations.some((activation) => activation.status === 'confirmed')

    // A `once` recipe that has confirmed is spent, whatever the stored reason says. Reachable only
    // from a state file another version wrote, since `unregisterDrop` will not retire a drop twice —
    // but resurrecting a burnt drop is expensive enough to be worth the two lines.
    if (activated && existing.recipe.once === true) return { ok: true, created: false, drop: existing }

    const resumed: RegisteredDrop = {
      ...existing,
      // Parked only if the activation left a conditional order behind. A drop that signed a discrete
      // order resumes armed, gated by the deadline of the order it signed rather than by its status.
      status: activated && selfDriving(existing.recipe) ? 'activated' : 'watching',
      committedDigest: activated && !selfDriving(existing.recipe) ? existing.lastSimulation?.balancesDigest : undefined,
      retiredReason: undefined,
      updatedAt: now,
      // `backoff` and `activations` carry over. The backoff is the record of activations that actually
      // failed, and clearing it here would make unregister-then-register a way to ask the keeper to
      // retry a reverting drop as fast as it likes.
    }

    if (await store.update(deployment.chainId, derived, () => resumed)) {
      return { ok: true, created: false, drop: resumed }
    }
    // Only reachable if the record vanished between the read and the write — a retention sweep. Falling
    // through registers it fresh, which is the right answer for a record that no longer exists.
  }

  if ((await store.count(deployment.chainId)) >= maxDrops) {
    return { ok: false, error: 'at-capacity', maxDrops }
  }

  const trades = tradesOf(recipe)
  const { matched, unmatched } = matchDocuments(
    trades.map((trade) => trade.appData),
    input.appDataDocuments ?? [],
  )

  const stray = unmatched[0]
  if (stray) {
    return {
      ok: false,
      error: 'app-data-mismatch',
      supplied: stray.hash,
      committed: trades.map((trade) => trade.appData),
    }
  }

  const fee = input.requireFeeFor
    ? findFee(trades, matched, input.requireFeeFor, input.minFeeBps ?? 0)
    : undefined

  if (input.requireFeeFor && !fee) {
    return {
      ok: false,
      error: 'no-fee',
      recipient: input.requireFeeFor,
      detail:
        trades.length === 0
          ? 'the recipe places no order, so it can carry no partner fee'
          : `no appData document carries a volumeBps partner fee of at least ${input.minFeeBps ?? 0} bps for ${input.requireFeeFor}`,
    }
  }

  const drop: RegisteredDrop = {
    address: derived,
    chainId: deployment.chainId,
    // The *resolved* generation, not `recipe.generation` — the JSON field is optional and defaults to
    // 1 inside the SDK, so recording the resolved value is what stops a later read resolving it
    // differently.
    generation: compiled.deployment.generation,
    owner: recipe.owner.toLowerCase() as Address,
    label: recipe.label,
    recipe,
    setupData: compiled.setupData,
    status: 'watching',
    hints: deriveHints(recipe),
    hintsVersion: HINTS_VERSION,
    registeredAt: now,
    updatedAt: now,
    everFunded: false,
    fee,
    appDataDocuments: Object.keys(matched).length > 0 ? matched : undefined,
    activations: [],
    backoff: { failures: 0, nextAttemptAt: 0 },
  }

  try {
    await store.put(drop)
  } catch (cause) {
    if (cause instanceof DropConflict) {
      return { ok: false, error: 'conflict', message: cause.message }
    }
    throw cause
  }

  return { ok: true, created: true, drop }
}

/**
 * Stop watching a drop.
 *
 * Takes the recipe rather than just the address, and checks it compiles to the same `setupData`.
 * Registration can be open because it grants nothing, but unregistering someone else's drop costs
 * them their gas subsidy for free — so this asks for the one thing only somebody holding the recipe
 * has. It is not authentication, and it is not meant to be; it is the same bar the drop itself sets.
 *
 * The record is retired rather than deleted: it holds the only server-side copy of `setupData`, and
 * retention removes it later. `registerDrop` can bring it back — see the revive branch there — so
 * this is a pause the recipe holder can undo, not a one-way door.
 *
 * ## Refused while an activation is in flight
 *
 * `store.active()` excludes retired drops, and reconciling a `pending` activation only happens for
 * active ones. So retiring a drop mid-flight abandons a transaction the keeper has already paid for:
 * the reserved spend is never trued up against the receipt, and the activation never reaches the
 * drop's history. Since the money is already committed, the honest answer is to refuse and let the
 * caller retry in a moment — a second or two later the tick has reconciled and this succeeds.
 */
export async function unregisterDrop(input: {
  recipe: DropRecipeJson
  store: DropStore
  deployment: DropDeployment
  now: number
}): Promise<
  { ok: true; drop: RegisteredDrop } | { ok: false; error: 'not-found' | 'invalid-recipe' | 'activating'; ref?: Hex }
> {
  let compiled
  try {
    compiled = compileRecipe(input.recipe)
  } catch {
    return { ok: false, error: 'invalid-recipe' }
  }

  const address = compiled.address.toLowerCase() as Address

  /**
   * Written by the mutator, because `update` only answers whether the record was there.
   *
   * `retired` is also what the caller needs back: the HTTP layer emits the same `retired` event the
   * keeper emits when it retires a drop itself, and recompiling the recipe a second time to find the
   * address it just wrote to would be the sort of duplication that goes stale.
   */
  let retired: RegisteredDrop | undefined
  let inFlight: Hex | undefined

  await input.store.update(input.deployment.chainId, address, (current) => {
    if (current.setupData !== compiled.setupData) return undefined
    if (current.pending) {
      inFlight = current.pending.ref
      return undefined
    }
    // Already retired: report success and change nothing. Overwriting the reason would rewrite a fact
    // about the drop — `once-consumed`, `expired`, `terminal-revert` — into a choice about the keeper,
    // and since only `unregistered` revives, that would turn this endpoint into a way to resurrect a
    // drop the keeper had permanently given up on.
    if (current.status === 'retired') {
      retired = current
      return undefined
    }
    retired = { ...current, status: 'retired', retiredReason: 'unregistered', updatedAt: input.now }
    return retired
  })

  if (inFlight) return { ok: false, error: 'activating', ref: inFlight }
  // `retired` rather than `updated`: an already-retired drop is a success that wrote nothing, so
  // `update` reports no change while `retired` still names the record the caller asked about.
  return retired ? { ok: true, drop: retired } : { ok: false, error: 'not-found' }
}

/**
 * The first trade whose appData promises `recipient` a volume fee.
 *
 * Only `volumeBps` counts — a surplus-based fee is real income whose *guaranteed* value is zero, and
 * subsidising against income that may never arrive is what `paying` mode exists to stop.
 */
function findFee(
  trades: readonly { sellToken: Address; appData: Hex }[],
  documents: Record<Hex, string>,
  recipient: Address,
  minFeeBps: number,
): RegisteredDrop['fee'] {
  for (const trade of trades) {
    const document = documents[trade.appData]
    if (!document) continue

    const found = feeFor(document, trade.appData, recipient)
    if (isProblem(found) || found.volumeBps < minFeeBps) continue

    return {
      volumeBps: found.volumeBps,
      recipient: found.recipient,
      appData: trade.appData,
      sellToken: trade.sellToken,
    }
  }
  return undefined
}
