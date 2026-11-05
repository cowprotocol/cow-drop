import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address, Hex } from 'viem'

import { getDropChain, recipeExportScope, recipeExportTypedData } from '@cowprotocol/cow-drop-sdk'

import { DEFAULT_CHAIN_ID } from './chain.js'
import { configuredKeeperBaseUrl, configuredKeeperUrl, configuredKeeperUrls } from './runtimeConfig'
import { COW_DROP_APP_DATA_DOCUMENT } from '@cowprotocol/cow-drop-sdk'

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
 * In order: a per-chain override (`VITE_KEEPER_URLS`), then the multi-chain keeper's base URL plus the
 * chain's network name (`VITE_KEEPER_BASE_URL` + `/xdai`), then the single keeper (`VITE_KEEPER_URL`).
 * With no chain given, the default chain stands in — what the About tab shows.
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
  const chain = chainId ?? DEFAULT_CHAIN_ID
  const forChain = urls[chain]

  const baseUrl = configuredKeeperBaseUrl()
  const network = getDropChain(chain)?.network
  const fromBase = baseUrl && network ? `${baseUrl.replace(/\/+$/, '')}/${network}` : undefined

  // With no single keeper configured, any entry is better than none for the "have we got one" checks.
  const raw = forChain ?? fromBase ?? configuredKeeperUrl() ?? Object.values(urls)[0]

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
    // The order book rejects an appData hash it has never seen, and the keeper is what uploads it.
    body: JSON.stringify({
      recipe: params.recipe,
      address: params.address,
      appData: [COW_DROP_APP_DATA_DOCUMENT],
    }),
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

/**
 * One recipe recovered from a keeper, with the documents needed to reimport it whole.
 *
 * `appDataDocuments` matter as much as the recipe: the chain carries only their hash, nothing can
 * recover them from the recipe, and the order book rejects an appData hash it has never seen.
 */
export interface ExportedKeeperDrop {
  address: Address
  chainId: number
  label: string
  recipe: DropRecipeJson
  appDataDocuments?: string[]
}

/**
 * Ask a keeper for the recipes it holds for you, proving who you are with a signature.
 *
 * ## Why this is not a hole in the model
 *
 * Everywhere else this file insists the keeper hands out no recipes, and the Drops tab says so. The
 * reasoning for the exception is in the SDK's `recipeExport.ts`: the bytes were never a theft
 * capability — activation is permissionless and paying a keeper to do it is the product — so what is
 * being protected is the *intent* in the recipe, and proof of control over the named owner is the
 * right gate for that.
 *
 * ## What comes back is still untrusted
 *
 * A signature proves you control the address, not that you wrote the recipe that names it. Anyone may
 * register a recipe naming any owner, and it may pay its surplus to a `receiver` that is not you. The
 * caller must decode and show it before anyone funds anything — see `DropsTab`.
 *
 * Two round trips, deliberately: the keeper's payer is read first and signed into the message, so the
 * signature is bound to this keeper and cannot be replayed at another one by the very party holding it.
 */
export async function exportKeeperRecipes(params: {
  owner: Address
  chainId: number
  sign: (typedData: ReturnType<typeof recipeExportTypedData>) => Promise<Hex>
}): Promise<ExportedKeeperDrop[]> {
  const base = keeperUrl(params.chainId)
  if (!base) throw new Error('no keeper is configured for this chain')

  const health = await fetch(`${base}/v1/health`)
  // 503 carries a full body — a payer below its floor still answers, and still names itself.
  const reported = (await parse(health)) as { payer?: Address }
  if (!reported.payer) throw new Error('this keeper did not report a payer, so a signature cannot be bound to it')

  const issuedAt = Math.floor(Date.now() / 1000)
  const request = {
    owner: params.owner,
    keeper: reported.payer,
    scope: recipeExportScope(),
    issuedAt,
    // Two minutes: long enough to approve in a wallet, short enough that a leaked signature is stale
    // before it is useful. The keeper refuses anything longer than its own maximum regardless.
    expiresAt: issuedAt + 120,
    nonce: randomNonce(),
  }

  const signature = await params.sign(recipeExportTypedData(request, params.chainId))

  const response = await fetch(`${base}/v1/drops/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request, signature }),
  })
  if (response.status === 404 || response.status === 501) {
    throw new Error('this keeper cannot export recipes — it is older than this page')
  }

  const body = await parse(response)
  if (!response.ok) fail(response, body)
  return (body as { drops: ExportedKeeperDrop[] }).drops
}

/** 32 bytes from the platform CSPRNG, so one signature cannot be replayed inside its own window. */
function randomNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
