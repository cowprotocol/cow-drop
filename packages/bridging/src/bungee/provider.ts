import type { Address, Hex } from 'viem'

import type {
  BridgeProvider,
  BridgeProviderInfo,
  BridgeQuote,
  BridgeQuoteRequest,
  BridgeToken,
} from '../types.js'
import { BungeeApi, type BungeeApiOptions } from './api.js'
import { DESTINATION_EXECUTING_BRIDGES, type BridgeName, type BungeeTokenWire } from './wire.js'

/**
 * Bungee, quoting a route that delivers into a drop and activates it on arrival.
 *
 * The only cow-drop-specific thing it does is pass the caller's `DestinationTarget` through to
 * Bungee's `destinationPayload` / `destinationGasLimit`, and set `receiverAddress` to the drop's
 * bridge receiver rather than to the user. Everything else is a plain manual-route bridge quote.
 *
 * Note the receiver, not the drop, is what Bungee is told to pay: the receiver is what runs the
 * payload, and it forwards to the drop in the same transaction. Naming the drop directly would also
 * work — that is the keeper path — but then nothing would call `activate`.
 */
export class BungeeDropProvider implements BridgeProvider {
  readonly info: BridgeProviderInfo = {
    key: 'bungee',
    name: 'Bungee',
    website: 'https://www.bungee.exchange',
  }

  private readonly api: BungeeApi
  /** An explicit restriction from the caller, which wins over the per-mode default below. */
  private readonly includeBridges: readonly BridgeName[] | undefined

  constructor(options: BungeeApiOptions = {}) {
    this.api = new BungeeApi(options)
    this.includeBridges = options.includeBridges
  }

  /**
   * Which bridges a delivery may route through.
   *
   * Atomic delivery must be limited to bridges that actually run a destination payload: one that
   * ignores it quotes identically and then strands the tokens at the receiver. Direct delivery asks
   * for nothing but a transfer, so every bridge qualifies and restricting would only lose routes.
   */
  private bridgesFor(executesPayload: boolean): readonly BridgeName[] | undefined {
    if (this.includeBridges) return this.includeBridges
    return executesPayload ? DESTINATION_EXECUTING_BRIDGES : undefined
  }

  async getDeliverableTokens(params: {
    sellChainId: number
    sellToken?: Address
    buyChainId: number
    /**
     * Whether the answer is for a delivery that will run a payload. Must match the mode the quote will
     * use, or this reports a pair as unreachable that the quote would happily route — direct delivery
     * reaches far more pairs, because it asks the bridge for nothing but a transfer.
     */
    executesPayload?: boolean
  }): Promise<BridgeToken[]> {
    const tokens = await this.api.getDeliverableTokens({
      fromChainId: params.sellChainId,
      fromTokenAddress: params.sellToken,
      toChainId: params.buyChainId,
      includeBridges: this.bridgesFor(params.executesPayload ?? false),
    })
    return tokens.map(toBridgeToken)
  }

  async getQuote(request: BridgeQuoteRequest): Promise<BridgeQuote> {
    const { destination } = request

    // An empty payload means direct delivery: the bridge is asked for a plain transfer to the drop, so
    // there is nothing to execute, no destination gas to prepay, and — the part that matters — no
    // reason to restrict the route. The allowlist exists solely to protect destination execution, and
    // applying it here would refuse pairs that work perfectly well. See `directDelivery` in the SDK.
    const executesPayload = destination.payload !== '0x'

    const { route, input } = await this.api.getQuote({
      userAddress: request.sender,
      originChainId: String(request.sellChainId),
      destinationChainId: String(request.buyChainId),
      inputToken: request.sellToken,
      inputAmount: request.sellAmount.toString(),
      // In atomic mode this is the receiver, which forwards to the drop and activates inside the fill.
      // In direct mode it is the drop itself, and nothing runs on arrival.
      receiverAddress: destination.receiver,
      outputToken: request.buyToken,
      enableManual: true,
      disableSwapping: true,
      disableAuto: true,
      includeBridges: this.bridgesFor(executesPayload)?.join(','),
      destinationPayload: executesPayload ? destination.payload : undefined,
      destinationGasLimit: executesPayload ? String(destination.gasLimit) : undefined,
    })

    const built = await this.api.getBuildTx(route.quoteId)

    return {
      provider: this.info.key,
      route: { name: route.routeDetails.name, estimatedSeconds: route.estimatedTime },
      input: { token: toBridgeToken(input), amount: request.sellAmount },
      output: {
        token: toBridgeToken(route.output.token),
        amount: BigInt(route.output.amount),
        minAmount: BigInt(route.output.minAmountOut),
      },
      approval: built.approvalData
        ? {
            spender: built.approvalData.spenderAddress as Address,
            token: built.approvalData.tokenAddress as Address,
            amount: BigInt(built.approvalData.amount),
          }
        : null,
      transaction: {
        to: built.txData.to as Address,
        data: built.txData.data as Hex,
        value: BigInt(built.txData.value),
        chainId: built.txData.chainId,
      },
      expiresAt: route.quoteExpiry,
      destination,
    }
  }

  explorerUrl(sourceTxHash: Hex): string {
    return `https://socketscan.io/tx/${sourceTxHash}`
  }
}

function toBridgeToken(token: BungeeTokenWire): BridgeToken {
  return {
    chainId: token.chainId,
    address: token.address as Address,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    logoUrl: token.logoURI,
  }
}
