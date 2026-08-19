import type { DestinationTarget } from '@cowprotocol/cow-drop-sdk'
import type { Address, Hex } from 'viem'

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
  }): Promise<BridgeToken[]>

  /** A route, priced, with the source-chain transaction that starts it. */
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
}

export interface EvmCall {
  to: Address
  data: Hex
  value: bigint
  chainId: number
}

export interface BridgeQuote {
  provider: string
  route: {
    name: string
    /** Bungee's own estimate for the bridge leg, in seconds. */
    estimatedSeconds: number
  }
  input: { token: BridgeToken; amount: bigint }
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
  /** The ERC20 approval the source transaction needs first, or null for a native-token bridge. */
  approval: { spender: Address; token: Address; amount: bigint } | null
  transaction: EvmCall
  /** Unix seconds. Bungee's routes expire; re-quote past this. */
  expiresAt: number
  destination: DestinationTarget
}
