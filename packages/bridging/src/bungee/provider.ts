import type { Address, Hex } from 'viem'

import type {
  BridgeProvider,
  BridgeProviderInfo,
  BridgeQuote,
  BridgeQuoteRequest,
  BridgeToken,
} from '../types.js'
import { BungeeApi, type BungeeApiOptions } from './api.js'
import type { BungeeTokenWire } from './wire.js'

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

  constructor(options: BungeeApiOptions = {}) {
    this.api = new BungeeApi(options)
  }

  async getDeliverableTokens(params: {
    sellChainId: number
    sellToken?: Address
    buyChainId: number
  }): Promise<BridgeToken[]> {
    const tokens = await this.api.getDeliverableTokens({
      fromChainId: params.sellChainId,
      fromTokenAddress: params.sellToken,
      toChainId: params.buyChainId,
    })
    return tokens.map(toBridgeToken)
  }

  async getQuote(request: BridgeQuoteRequest): Promise<BridgeQuote> {
    const { destination } = request

    const { route, input } = await this.api.getQuote({
      userAddress: request.sender,
      originChainId: String(request.sellChainId),
      destinationChainId: String(request.buyChainId),
      inputToken: request.sellToken,
      inputAmount: request.sellAmount.toString(),
      // The receiver runs the payload; it forwards to the drop and activates inside this same fill.
      receiverAddress: destination.receiver,
      outputToken: request.buyToken,
      enableManual: true,
      disableSwapping: true,
      disableAuto: true,
      destinationPayload: destination.payload,
      destinationGasLimit: String(destination.gasLimit),
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
