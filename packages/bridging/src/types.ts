import type { CompiledRecipe, DestinationTarget } from '@cowprotocol/cow-drop-sdk'
import type { Address, Hex } from 'viem'

import type { DeliveryCapability } from './bungee/capability.js'
import type { CheckOutcome, Verification } from './checks.js'
import { BridgeError } from './errors.js'

/**
 * A bridge, reduced to what bridging *into a drop* needs.
 *
 * Deliberately shaped like `BridgeThenSwapProvider` in `cowprotocol/cow-sdk#845`, with one thing
 * taken out: that interface asks a provider for `getOrderFlowAddress(owner, chainId)` and
 * `encodeDestinationOrderData(params)`, which hard-codes the destination to `OrderFlow`. Here the
 * destination arrives as a `DestinationTarget` the caller already built, so the same provider serves
 * any destination that can be described as "deliver to this address with this payload".
 *
 * That is the seam worth upstreaming. Everything else — the quote call, `destinationPayload`,
 * `destinationGasLimit`, route selection — is identical for both.
 */
export interface BridgeProvider {
  readonly info: BridgeProviderInfo

  /**
   * What this provider can be trusted to run at the destination. Local, no I/O.
   *
   * A UI needs this to explain a route list where every row is disabled — the difference between a
   * designed refusal and an apparent outage.
   */
  deliveryCapability(): DeliveryCapability

  /**
   * The tokens this bridge can deliver on `buyChainId`, i.e. the candidates for the drop's **sell**
   * token.
   *
   * Worth being careful about which token this is. A bridge-and-swap has two legs and each has its
   * own "output": the bridge delivers some token to the drop, and the drop's recipe then sells that
   * for what the user actually wanted. These are the first leg's outputs — an intermediate, not the
   * destination.
   */
  getDeliverableTokens(params: {
    sellChainId: number
    sellToken?: Address
    buyChainId: number
    /**
     * Whether the answer is for a delivery that will run a payload.
     *
     * Declared here now. It was implemented and undeclared, which is how this interface came to
     * describe a function that did not exist: a caller typed against `BridgeProvider` could not pass
     * it, so the default silently applied and the answer was for the wrong mode.
     */
    executesPayload?: boolean
  }): Promise<BridgeToken[]>

  /**
   * Every route the provider offers, each with an allowed/disabled verdict. One call, nothing built.
   *
   * Nothing is discarded — a route we will not use is exactly what a user needs in order to
   * understand why.
   */
  getRoutes(request: BridgeQuoteRequest): Promise<BridgeRoutes>

  /** One selected route, built and deeply verified. Refuses a route whose verdict blocks. */
  buildQuote(routes: BridgeRoutes, routeId: string): Promise<BridgeQuote>

  /** `getRoutes` then `buildQuote` on the best allowed route. A convenience, not the primary path. */
  getQuote(request: BridgeQuoteRequest): Promise<BridgeQuote>

  /** Where a person watches the bridge leg, given the source transaction. */
  explorerUrl(sourceTxHash: Hex): string
}

export interface BridgeProviderInfo {
  /** Stable identifier, for config and persistence. */
  key: string
  name: string
  website: string
}

export interface BridgeToken {
  chainId: number
  address: Address
  symbol: string
  name: string
  decimals: number
  logoUrl?: string
}

export interface BridgeQuoteRequest {
  /** The account sending the source-chain transaction and paying for the bridge. */
  sender: Address

  sellChainId: number
  sellToken: Address
  sellAmount: bigint

  /** The chain the drop lives on, and the token the bridge is to deliver into it. */
  buyChainId: number
  buyToken: Address

  /**
   * Where the bridge delivers and what it delivers with — from `bungeeDelivery()` in the drop SDK.
   *
   * Note what this does *not* contain: an amount. The drop address commits to a recipe, not a
   * number, so a quote can be refreshed as often as the UI likes without the destination moving.
   */
  destination: DestinationTarget

  /**
   * The compiled recipe this delivery is meant to fund, for the library to check the target against.
   *
   * An assertion, never an input — the same shape as `RegisterInput.address` in the keeper. Supplying
   * it turns on the one check that catches a payload naming somebody else's drop while every visible
   * field still agrees. Optional only because a script may not have it; when absent, the
   * `delivery-target` check reports `not-applicable` so a caller skipping the strongest available
   * check is visible rather than silent.
   *
   * Typed as the SDK's `CompiledRecipe` rather than something structural, because re-deriving a drop
   * address needs the whole deployment — the factory, the executor, the shed implementation and the
   * proxy creation code. A narrower shape here would only push the missing fields into a cast.
   */
  expectedRecipe?: CompiledRecipe
}

export interface EvmCall {
  to: Address
  data: Hex
  value: bigint
  chainId: number
}

export interface BridgeRoute {
  /** The provider's opaque, stable id — Bungee's `quoteId`. What `buildQuote` takes. */
  id: string
  /** As the provider spells it, unnormalised. The registry normalises; this is what to display. */
  name: string
  /** The provider's own estimate for the bridge leg. Null when it did not say — never zero. */
  estimatedSeconds: number | null
  output: {
    token: BridgeToken
    amount: bigint
    /**
     * The least the bridge undertakes to deliver.
     *
     * Useful to *show*, and a trap to compile into the recipe: a recipe's `minAmount` is part of the
     * drop address, so sourcing it from a live quote would move the address on every refresh — and
     * the payload names that address's preimage. Size the guard from the amount being bridged and a
     * tolerance the user picks instead.
     */
    minAmount: bigint
  }
  /** Unix seconds. */
  expiresAt: number
  /**
   * Eligibility from the quote response alone, with no transaction built.
   *
   * Includes the response-wide checks, duplicated onto every route on purpose: a route has to be
   * displayable and gate-able on its own, because it is all the UI holds once the user picks one.
   */
  eligibility: Verification
  /** `eligibility.sendable`. Named separately because it is what a list row branches on. */
  allowed: boolean
  /** Why not, in one sentence. Undefined when allowed. */
  disabledReason?: string
  /** The route object verbatim, so a UI can show exactly what arrived. */
  raw: unknown
}

export interface BridgeRoutes {
  provider: string
  /** The request these were quoted for. Carried so `buildQuote` cannot be handed a mismatched one. */
  request: BridgeQuoteRequest
  /** Every route offered — allowed first, then by output descending. Nothing discarded. */
  routes: readonly BridgeRoute[]
  /** The response as a whole, checked against the request. Propagated onto every route. */
  checks: readonly CheckOutcome[]
  /** What this provider is trusted to run at the destination. */
  capability: DeliveryCapability
  /** The quote response verbatim. */
  raw: unknown
  /** When this was quoted, from the injected clock, so a stale set is visibly stale. */
  quotedAt: number
}

export interface BridgeQuote {
  provider: string
  /** The route this was built for — the same object the caller selected, verdict and all. */
  route: BridgeRoute
  input: { token: BridgeToken; amount: bigint }
  output: { token: BridgeToken; amount: bigint; minAmount: bigint }
  /** The ERC20 approval the source transaction needs first, or null for a native-token bridge. */
  approval: { spender: Address; token: Address; amount: bigint } | null
  /**
   * What the transaction *is*, for display — and deliberately not enough to send with.
   *
   * There is no `transaction` field on this type. `sendableTransaction()` is the only way to obtain
   * one, and it consults the verdict first. The incident's calldata reached a wallet through a field
   * read; it cannot reach one through a function that refuses. A greyed-out button in a React
   * component is not a safety property — it is a hope about every future caller.
   */
  transactionSummary: {
    to: Address
    chainId: number
    value: bigint
    dataBytes: number
    /** The selector, for eyeballing against a block explorer. */
    selector: Hex
    /** The whole calldata, to display and to copy. Not routable to a wallet without the check. */
    data: Hex
  }
  /** The built transaction, checked against the request. */
  verification: Verification
  /** Unix seconds. Routes expire; re-build past this. */
  expiresAt: number
  destination: DestinationTarget
  /** Both responses verbatim, for a raw view. Parsed wire JSON, so it survives `JSON.stringify`. */
  raw: { quote: unknown; build: unknown }
}

/**
 * The transaction to sign, or a throw.
 *
 * The only way to get sendable calldata out of a quote, and the reason `BridgeQuote` has no
 * `transaction` field. Read the throw as the design: a caller cannot forget to check, cannot check
 * the wrong thing, and cannot be a new code path that never learned to check at all.
 *
 * @throws BridgeError('unsafe-quote'), with the failing `Verification` as `details`.
 */
export function sendableTransaction(quote: BridgeQuote): EvmCall {
  if (!quote.verification.sendable) {
    throw new BridgeError(
      'unsafe-quote',
      'this transaction did not pass verification, so it will not be handed to a wallet',
      quote.verification,
    )
  }

  const { to, chainId, value, data } = quote.transactionSummary
  return { to, chainId, value, data }
}
