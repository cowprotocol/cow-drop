import { compileRecipe, type DropDeployment, type DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address, Hex } from 'viem'

import { feeFor, isProblem, matchDocuments } from './appData.js'
import { deriveHints, HINTS_VERSION, tradesOf } from './hints.js'
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
    // Idempotent on purpose. A client whose POST timed out will retry, and it can only honestly be
    // told that retrying is safe if it is.
    if (existing.setupData === compiled.setupData) return { ok: true, created: false, drop: existing }
    return { ok: false, error: 'conflict', message: `${derived} is registered with a different recipe` }
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
 * retention removes it later.
 */
export async function unregisterDrop(input: {
  recipe: DropRecipeJson
  store: DropStore
  deployment: DropDeployment
  now: number
}): Promise<{ ok: true } | { ok: false; error: 'not-found' | 'invalid-recipe' }> {
  let compiled
  try {
    compiled = compileRecipe(input.recipe)
  } catch {
    return { ok: false, error: 'invalid-recipe' }
  }

  const address = compiled.address.toLowerCase() as Address
  const updated = await input.store.update(input.deployment.chainId, address, (current) =>
    current.setupData === compiled.setupData
      ? { ...current, status: 'retired', retiredReason: 'unregistered', updatedAt: input.now }
      : undefined,
  )

  return updated ? { ok: true } : { ok: false, error: 'not-found' }
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
