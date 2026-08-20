import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address } from 'viem'

import { configuredKeeperUrl, configuredKeeperUrls } from './runtimeConfig'

/**
 * Talking to a keeper.
 *
 * A keeper watches a drop's balance and activates it unattended, which is the only way a drop works
 * without somebody sitting on the page. Handing it the recipe is the whole registration: the keeper
 * recompiles `setupData` itself and refuses anything that does not derive the address it was given, so
 * the client cannot register a recipe for an address it does not own the preimage of.
 *
 * Optional by design. With no keeper configured the app behaves exactly as it did before — local
 * persistence only — because a keeper is an operational choice and the page has to be useful without
 * one.
 */

/**
 * The keeper for a chain, or null when none is configured. See `./runtimeConfig.ts`.
 *
 * `chainId` is optional so that the many "is there a keeper at all" checks stay unchanged, but pass it
 * wherever the chain is known — and it always is, since a recipe carries one. It matters most for a
 * drop funded across a bridge, which lives on the destination chain rather than the one the wallet is
 * connected to.
 *
 * A deployment with a single keeper still works with no map: the single URL is the fallback for every
 * chain, and a keeper asked about a chain it does not watch answers `wrong-chain` rather than
 * accepting it. That keeps this a configuration convenience rather than a correctness boundary.
 */
export function keeperUrl(chainId?: number): string | null {
  const urls = configuredKeeperUrls()
  const forChain = chainId === undefined ? undefined : urls[chainId]
  // With no single keeper configured, any entry is better than none for the "have we got one" checks.
  const raw = forChain ?? configuredKeeperUrl() ?? Object.values(urls)[0]

  if (raw === undefined) return null
  return raw.replace(/\/+$/, '')
}

/**
 * What the keeper reports about a drop.
 *
 * A subset of its wire shape — the fields this page can act on. `watching` is the one that matters:
 * a retired record still exists (the keeper keeps recipes rather than deleting them) but nothing is
 * polling it any more.
 */
export interface KeeperDrop {
  address: Address
  chainId: number
  owner: Address
  label: string
  status: string
  watching: boolean
  everFunded: boolean
  registeredAt: number
  retiredReason?: string
  blockedReason?: string
  activations: unknown[]
}

/** Errors the keeper returns deliberately, mapped to something a person can act on. */
const MESSAGES: Record<string, string> = {
  'invalid-recipe': 'the keeper could not compile that recipe',
  'address-mismatch': 'the recipe does not derive the address given',
  conflict: 'the keeper already holds this address with a different recipe',
  'wrong-chain': 'this keeper watches a different chain',
  'wrong-generation': 'this keeper was built for a different contract generation',
  'at-capacity': 'the keeper is full and is not taking new drops',
  // Unregister only. Worth its own sentence because it is temporary and self-clearing: the keeper has
  // already paid for a transaction and will not abandon it unreconciled.
  activating: 'the keeper is activating this drop right now — try again in a few seconds',
  'not-found': 'the keeper has no record of this drop',
}

/** The body as JSON, or undefined. An error response is not guaranteed to carry one. */
async function parse(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * Turn a keeper refusal into something worth showing a user: the sentence for a known error code,
 * the server's own message otherwise.
 */
function fail(response: Response, body: unknown): never {
  const error = (body as { error?: string } | undefined)?.error
  const message = (body as { message?: string } | undefined)?.message
  throw new Error(
    (error && MESSAGES[error]) ?? message ?? `keeper responded ${response.status}`,
  )
}

/**
 * Hand a recipe to the keeper.
 *
 * Idempotent at the server, which is why this does not try to detect an existing registration first:
 * a repeat is a 200 rather than an error, so a retry after a timeout is safe.
 */
export async function registerWithKeeper(params: {
  recipe: DropRecipeJson
  address: Address
}): Promise<KeeperDrop> {
  // The recipe's chain, not the wallet's: a bridged drop is registered with the keeper watching the
  // chain it will land on, which is the whole reason `keeperUrl` takes one.
  const base = keeperUrl(params.recipe.chainId)
  if (!base) throw new Error('no keeper is configured for chain ' + params.recipe.chainId)

  const response = await fetch(`${base}/v1/drops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipe: params.recipe, address: params.address }),
  })

  const body = await parse(response)
  if (!response.ok) fail(response, body)
  return (body as { drop: KeeperDrop }).drop
}

/**
 * Ask the keeper to stop watching.
 *
 * The recipe is required, so only someone holding it can do this — the same bar the drop itself sets,
 * and the reason no subscription secret is needed. Reversible: handing the same recipe back to
 * `POST /v1/drops` resumes the record rather than reporting it as held-but-idle.
 */
export async function unregisterFromKeeper(recipe: DropRecipeJson): Promise<void> {
  const base = keeperUrl(recipe.chainId)
  if (!base) throw new Error('no keeper is configured for chain ' + recipe.chainId)

  const response = await fetch(`${base}/v1/drops/unregister`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipe }),
  })
  if (!response.ok) fail(response, await parse(response))
}

/**
 * What the keeper currently knows about an address, or null if it knows nothing.
 *
 * This is the reason the local flag is not trusted on its own. The keeper's `--state` defaults to
 * memory only, so a restart can lose every registration while this browser still believes it sent
 * them — and a flag that says "handled" when nothing is watching is worse than no flag. Null here
 * means "ask again", not "never registered": a keeper that is merely unreachable throws instead.
 */
export async function readKeeperDrop(address: Address, chainId?: number): Promise<KeeperDrop | null> {
  const base = keeperUrl(chainId)
  if (!base) return null

  const response = await fetch(`${base}/v1/drops/${address}`)
  if (response.status === 404) return null

  const body = await parse(response)
  if (!response.ok) fail(response, body)
  return (body as { drop: KeeperDrop }).drop
}

/**
 * What the keeper holds for one owner.
 *
 * `chainId` is the keeper's, not the caller's: one keeper serves one chain while this browser's list
 * spans all of them, so the answer has to say which chain it is answering for — especially the empty
 * answer, which carries no drops to read it from.
 */
export interface KeeperDropList {
  chainId: number
  owner: Address
  /** How many the keeper holds for this owner, which is not always `drops.length`. */
  total: number
  truncated: boolean
  drops: KeeperDrop[]
}

/**
 * Every drop the keeper has registered under `owner`, or null when no keeper is configured.
 *
 * Null and an empty `drops` are deliberately different: null means there was nobody to ask, `[]` means
 * we asked and there is nothing. The page shows different sentences for those, so this must not flatten
 * them — which is also why a 404 throws rather than returning null. A 404 here is a *router* miss: a
 * keeper older than this page has no such route, and reporting that as "you own nothing" is a lie in
 * the one direction that costs money.
 *
 * **A row is not proof of ownership.** `owner` is a field of a recipe anyone may register, so the
 * keeper is reporting "someone registered a recipe naming this address", not "you made this". Callers
 * must never turn a row into an invitation to fund. See `docs/DESIGN.md`.
 */
export async function listKeeperDrops(owner: Address, chainId?: number): Promise<KeeperDropList | null> {
  const base = keeperUrl(chainId)
  if (!base) return null

  const response = await fetch(`${base}/v1/drops?${new URLSearchParams({ owner }).toString()}`)
  // Before `fail`, which would reach for MESSAGES['not-found'] — "the keeper has no record of this
  // drop" — and say something actively wrong about a route that is simply absent.
  if (response.status === 404) {
    throw new Error('this keeper cannot list drops by owner — it is older than this page')
  }

  const body = await parse(response)
  if (!response.ok) fail(response, body)
  return body as KeeperDropList
}
