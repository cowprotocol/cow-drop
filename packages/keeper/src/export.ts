import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address, Hex } from 'viem'

import {
  RECIPE_EXPORT_MAX_WINDOW_SECONDS,
  RECIPE_EXPORT_SCOPE_ALL,
  recipeExportTypedData,
  type RecipeExportRequest,
} from '@cowprotocol/cow-drop-sdk'

import type { DropStore } from './store.js'

/**
 * The verifier for `POST /v1/drops/export`. Why it is safe to serve at all: the SDK's
 * `recipeExport.ts`.
 *
 * Pure but for the injected `verify` and `now`, so the checks test without a chain.
 */

export interface ExportedDrop {
  address: Address
  chainId: number
  label: string
  /** Exactly what was registered. The client recompiles `setupData` and checks the address itself. */
  recipe: DropRecipeJson
  /** Without these a reimport is incomplete — the chain carries only the hash. */
  appDataDocuments?: string[]
}

export type ExportError =
  | 'invalid-request'
  | 'expired'
  | 'window-too-long'
  | 'wrong-keeper'
  | 'bad-signature'
  | 'replayed'
  | 'not-found'

export type ExportResult =
  | { ok: true; drops: ExportedDrop[] }
  | { ok: false; error: ExportError; message: string }

/** Verifies a typed-data signature for `owner`. EOA or ERC-1271 — the caller decides how. */
export type SignatureVerifier = (input: {
  owner: Address
  typedData: ReturnType<typeof recipeExportTypedData>
  signature: Hex
}) => Promise<boolean>

/**
 * One-use nonces, in memory: entries are worthless after the window, and persisting them would put a
 * write on the read path of the endpoint an owner reaches for when something has already gone wrong.
 */
export interface NonceLog {
  /** True when this nonce had not been seen. False means it is a replay. */
  claim: (nonce: Hex, expiresAt: number, now: number) => boolean
}

export function createNonceLog(): NonceLog {
  const seen = new Map<Hex, number>()

  return {
    claim(nonce, expiresAt, now) {
      // Prune first, so the map is bounded by the window rather than by uptime.
      for (const [key, expiry] of seen) if (expiry <= now) seen.delete(key)
      if (seen.has(nonce)) return false
      seen.set(nonce, expiresAt)
      return true
    },
  }
}

export interface ExportInput {
  request: RecipeExportRequest
  signature: Hex
  store: DropStore
  chainId: number
  /** This keeper's payer, which the signature must name. */
  keeper: Address
  verify: SignatureVerifier
  nonces: NonceLog
  /** Unix seconds. */
  now: number
}

/** Cheap local checks run before the signature, which may be an `eth_call` into a contract wallet. */
export async function exportRecipes(input: ExportInput): Promise<ExportResult> {
  const { request, signature, store, chainId, keeper, verify, nonces, now } = input

  if (!isAddress(request.owner) || !isAddress(request.keeper)) {
    return { ok: false, error: 'invalid-request', message: '`owner` and `keeper` must be addresses' }
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(request.nonce)) {
    return { ok: false, error: 'invalid-request', message: '`nonce` must be 32 bytes' }
  }
  if (!Number.isFinite(request.issuedAt) || !Number.isFinite(request.expiresAt)) {
    return { ok: false, error: 'invalid-request', message: '`issuedAt` and `expiresAt` must be unix seconds' }
  }

  // A signature meant for another keeper is a replay, not a forgery — say so plainly.
  if (request.keeper.toLowerCase() !== keeper.toLowerCase()) {
    return { ok: false, error: 'wrong-keeper', message: 'this signature names a different keeper' }
  }

  if (request.expiresAt <= now) {
    return { ok: false, error: 'expired', message: 'this signature has expired — sign a fresh one' }
  }
  // Backdating the window would otherwise mint a long-lived token past the cap below.
  if (request.issuedAt > now + 60) {
    return { ok: false, error: 'invalid-request', message: '`issuedAt` is in the future' }
  }
  if (request.expiresAt - request.issuedAt > RECIPE_EXPORT_MAX_WINDOW_SECONDS) {
    return {
      ok: false,
      error: 'window-too-long',
      message: `a signature may not be valid for more than ${RECIPE_EXPORT_MAX_WINDOW_SECONDS}s`,
    }
  }

  const scope = request.scope
  if (scope !== RECIPE_EXPORT_SCOPE_ALL && !isAddress(scope)) {
    return { ok: false, error: 'invalid-request', message: '`scope` must be `all` or a drop address' }
  }

  const verified = await verify({ owner: request.owner, typedData: recipeExportTypedData(request, chainId), signature })
  if (!verified) {
    return { ok: false, error: 'bad-signature', message: 'the signature does not come from `owner`' }
  }

  // After the signature, so a spent nonce cannot be used to probe which signatures were genuine.
  if (!nonces.claim(request.nonce, request.expiresAt, now)) {
    return { ok: false, error: 'replayed', message: 'this signature has already been used' }
  }

  const owner = request.owner.toLowerCase() as Address
  const all = await store.all(chainId)
  const mine = all.filter((drop) => drop.owner.toLowerCase() === owner)
  const wanted = scope === RECIPE_EXPORT_SCOPE_ALL ? mine : mine.filter((drop) => drop.address.toLowerCase() === scope)

  if (wanted.length === 0) {
    return {
      ok: false,
      error: 'not-found',
      message:
        scope === RECIPE_EXPORT_SCOPE_ALL
          ? 'this keeper holds no drops for that owner'
          : 'this keeper holds no such drop for that owner',
    }
  }

  return {
    ok: true,
    drops: wanted.map((drop) => ({
      address: drop.address,
      chainId: drop.chainId,
      label: drop.label,
      recipe: drop.recipe,
      ...(drop.appDataDocuments ? { appDataDocuments: Object.values(drop.appDataDocuments) } : {}),
    })),
  }
}

function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}
