import type { Address, Hex } from 'viem'

/**
 * The message an owner signs to get their own recipes back from a keeper.
 *
 * Safe to serve to a proven owner: activation is already permissionless, and rescue ends in a
 * cow-shed only the owner controls. What the bytes carry is intent worth front-running and the
 * authority to burn a one-shot recipe — both concerns about everyone *else*.
 *
 * A signature proves control of the address, not authorship of the recipe. Anyone may register a
 * recipe naming any owner, so what comes back is still untrusted input.
 *
 * Here rather than in both packages: two copies of an EIP-712 definition are two copies that drift.
 */

export const RECIPE_EXPORT_DOMAIN_NAME = 'cow-drop keeper'
export const RECIPE_EXPORT_DOMAIN_VERSION = '1'

/** A signature is a bearer token until it expires. Minutes are enough to click a button. */
export const RECIPE_EXPORT_MAX_WINDOW_SECONDS = 600

/** `scope` when the owner is asking for every drop the keeper holds for them. */
export const RECIPE_EXPORT_SCOPE_ALL = 'all'

export const RECIPE_EXPORT_TYPES = {
  RecipeExport: [
    { name: 'owner', type: 'address' },
    { name: 'keeper', type: 'address' },
    { name: 'scope', type: 'string' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

export interface RecipeExportRequest {
  /** The account whose recipes are being asked for. Must be the signer. */
  owner: Address
  /**
   * The keeper's payer, from `/v1/health`. Binds the signature to one keeper, so the party you hand
   * it to cannot replay it at another.
   */
  keeper: Address
  /** `all`, or one lowercased drop address. */
  scope: string
  /** Unix seconds. */
  issuedAt: number
  /** Unix seconds. Refused beyond `RECIPE_EXPORT_MAX_WINDOW_SECONDS` after `issuedAt`. */
  expiresAt: number
  /** 32 random bytes, so one signature cannot be replayed within its own window. */
  nonce: Hex
}

/** No `verifyingContract`: a keeper is not a contract, and the payer is the binding that matters. */
export function recipeExportTypedData(request: RecipeExportRequest, chainId: number) {
  return {
    domain: {
      name: RECIPE_EXPORT_DOMAIN_NAME,
      version: RECIPE_EXPORT_DOMAIN_VERSION,
      chainId: BigInt(chainId),
    },
    types: RECIPE_EXPORT_TYPES,
    primaryType: 'RecipeExport' as const,
    message: {
      owner: request.owner,
      keeper: request.keeper,
      scope: request.scope,
      issuedAt: BigInt(request.issuedAt),
      expiresAt: BigInt(request.expiresAt),
      nonce: request.nonce,
    },
  } as const
}

/** `all` for every drop, or one address lowercased — the form the verifier compares against. */
export function recipeExportScope(drop?: Address): string {
  return drop === undefined ? RECIPE_EXPORT_SCOPE_ALL : drop.toLowerCase()
}
