import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address } from 'viem'

/**
 * Talking to a keeper.
 *
 * A keeper watches a drop's balance and activates it unattended, which is the only way a drop works
 * without somebody sitting on the page. Handing it the recipe is the whole registration: the keeper
 * recompiles `setupData` itself and refuses anything that does not derive the address it was given, so
 * the client cannot register a recipe for an address it does not own the preimage of.
 *
 * Optional by design. With no `VITE_KEEPER_URL` the app behaves exactly as it did before — local
 * persistence only — because a keeper is an operational choice and the page has to be useful without
 * one.
 */

/** The keeper this page talks to, or null when none is configured. */
export function keeperUrl(): string | null {
  const raw = import.meta.env.VITE_KEEPER_URL
  if (typeof raw !== 'string' || raw.trim() === '') return null
  return raw.trim().replace(/\/+$/, '')
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
  const base = keeperUrl()
  if (!base) throw new Error('no keeper is configured (VITE_KEEPER_URL)')

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
  const base = keeperUrl()
  if (!base) throw new Error('no keeper is configured (VITE_KEEPER_URL)')

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
export async function readKeeperDrop(address: Address): Promise<KeeperDrop | null> {
  const base = keeperUrl()
  if (!base) return null

  const response = await fetch(`${base}/v1/drops/${address}`)
  if (response.status === 404) return null

  const body = await parse(response)
  if (!response.ok) fail(response, body)
  return (body as { drop: KeeperDrop }).drop
}
