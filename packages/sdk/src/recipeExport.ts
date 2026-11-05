import type { Address, Hex } from 'viem'

/**
 * The message an owner signs to get their own recipes back from a keeper.
 *
 * ## Why a keeper may hand these out at all
 *
 * A drop address is a hash commitment to `setupData`, and every path that touches the drop needs
 * those exact bytes back. Lose them before activating and the money is gone for everyone, the owner
 * included — see `apps/web/src/lib/storage.ts`. The keeper holds the only server-side copy, and until
 * now it would never part with it, which made a cleared browser a permanent loss of funds.
 *
 * Handing the bytes to a *proven* owner is safe in a way that handing them to anyone is not, and the
 * reason is worth stating precisely because it is not the obvious one:
 *
 * - **Activation is already permissionless.** `buildActivateTx` builds a transaction anyone may send,
 *   and paying a keeper to send it is the entire product. The bytes were never a theft capability.
 * - **Rescue ends in a cow-shed only the owner controls**, so the bytes alone move nothing.
 *
 * What they do carry is *intent* — a stop-loss strike, a TWAP's part size and schedule, a limit price,
 * all worth front-running — and, as `packages/keeper/ARCHITECTURE.md` puts it, the authority to burn a
 * one-shot recipe at a moment of someone else's choosing. Neither is theft, and neither is a reason to
 * withhold the bytes from the one account already entitled to both: the owner can read their own
 * intent, and can already activate their own drop. So the gate is proof of control over the named
 * owner, and the thing it protects is everyone *else* being unable to ask.
 *
 * ## What a signature does not prove
 *
 * Control of the owner address, and nothing else. **Anyone may register a recipe naming any owner**,
 * so a recipe that comes back from an export is still untrusted input: it may name you as owner while
 * paying its surplus to a `receiver` that is not you. Decode it with `describeRecipe` and show it
 * before anyone funds anything. Retrieval is not endorsement.
 *
 * ## Why it lives in the SDK
 *
 * The signer and the verifier have to agree byte for byte. Two copies of an EIP-712 definition are
 * two copies that can drift — and a domain that disagrees by one field is exactly the failure that
 * left orders stuck at `presignaturePending`, keyed by a UID nothing would ever sign.
 */

export const RECIPE_EXPORT_DOMAIN_NAME = 'cow-drop keeper'
export const RECIPE_EXPORT_DOMAIN_VERSION = '1'

/**
 * The longest validity a signature may claim, whatever `expiresAt` says.
 *
 * A signature is a bearer token for the window it names: anyone who intercepts it can replay it until
 * it expires. Minutes are enough to click a button, and bound the damage of one that leaks.
 */
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
   * The keeper's payer address, as `/v1/health` reports it.
   *
   * Binds the signature to one keeper. Without it, a keeper you talk to could replay your signature
   * at a *different* keeper and read recipes you never registered with it — the one party guaranteed
   * to hold your signature is the one you handed it to. Costs a request the page already makes.
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

/**
 * The EIP-712 payload to sign and to verify.
 *
 * No `verifyingContract` in the domain: a keeper is not a contract, and the binding that matters is
 * to its payer, which is a message field. `chainId` is in the domain only — one source of truth, so a
 * signature for one chain cannot be presented to a keeper serving another.
 */
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
