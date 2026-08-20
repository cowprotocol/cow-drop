import type { Address, Hex } from 'viem'

import { byteLength, summarise, type CheckOutcome, type Verification } from '../checks.js'
import { BridgeError } from '../errors.js'
import type {
  BridgeProvider,
  BridgeProviderInfo,
  BridgeQuote,
  BridgeQuoteRequest,
  BridgeRoute,
  BridgeRoutes,
  BridgeToken,
} from '../types.js'
import { BungeeApi, type BungeeApiOptions } from './api.js'
import { deliveryCapability, type DeliveryCapability, type DestinationExecution } from './capability.js'
import { responseChecks, routeChecks, transactionChecks } from './verify.js'
import type { BridgeName, BungeeQuoteResponseWire, BungeeRouteWire, BungeeTokenWire } from './wire.js'

/**
 * Bungee, quoting a route that delivers into a drop.
 *
 * The only cow-drop-specific thing it does is pass the caller's `DestinationTarget` through to
 * Bungee's `destinationPayload` / `destinationGasLimit` and set `receiverAddress` from it. Everything
 * else is a plain manual-route bridge quote — and then a lot of checking.
 *
 * ## Why the checking is the interesting part
 *
 * This class used to build a request with care and accept whatever came back, and that stranded a real
 * delivery: the route it chose could not run our destination payload, and the transaction it built did
 * not contain the payload at all. Neither fact was hidden — both were sitting in the response nobody
 * looked at.
 *
 * So the flow is now two steps on purpose. `getRoutes` returns every route with a verdict, and
 * `buildQuote` will not even *ask* for a transaction for a route whose verdict blocks — so calldata
 * for a refused route never exists in this process. What comes back from `/build-tx` is then checked
 * against the request again, and the result is reachable only through `sendableTransaction()`.
 */
export class BungeeDropProvider implements BridgeProvider {
  readonly info: BridgeProviderInfo = {
    key: 'bungee',
    name: 'Bungee',
    website: 'https://www.bungee.exchange',
  }

  private readonly api: BungeeApi
  private readonly includeBridges: readonly BridgeName[] | undefined
  private readonly now: () => number
  private readonly capabilityOverrides: Readonly<Record<string, DestinationExecution>> | undefined

  constructor(options: BungeeApiOptions = {}) {
    this.api = new BungeeApi(options)
    this.includeBridges = options.includeBridges
    this.now = options.now ?? Date.now
    this.capabilityOverrides = options.capabilityOverrides
  }

  deliveryCapability(): DeliveryCapability {
    return deliveryCapability(this.capabilityOverrides)
  }

  /** Unix seconds, which is what Bungee's expiries are in. */
  private nowSeconds(): number {
    return Math.floor(this.now() / 1000)
  }

  /**
   * Which bridges to ask for.
   *
   * When something has been watched running a payload, narrowing to that set saves a round trip
   * through routes we would refuse anyway. When nothing has, we ask **unfiltered** — deliberately.
   * Filtering on an empty set would produce an empty screen, and an empty screen is indistinguishable
   * from a broken app. Asking for everything and disabling each route *with its reason* is the same
   * refusal, legibly.
   */
  private bridgesFor(executesPayload: boolean): readonly BridgeName[] | undefined {
    if (this.includeBridges) return this.includeBridges
    if (!executesPayload) return undefined

    const observed = this.deliveryCapability().observed
    return observed.length > 0 ? observed : undefined
  }

  async getDeliverableTokens(params: {
    sellChainId: number
    sellToken?: Address
    buyChainId: number
    executesPayload?: boolean
  }): Promise<BridgeToken[]> {
    const executesPayload = params.executesPayload ?? false

    // Nothing can deliver an executed payload while nothing has been observed executing one, and
    // saying so costs no HTTP call. The caller has `deliveryCapability()` for the wording.
    if (executesPayload && !this.deliveryCapability().atomicAvailable) return []

    const tokens = await this.api.getDeliverableTokens({
      fromChainId: params.sellChainId,
      fromTokenAddress: params.sellToken,
      toChainId: params.buyChainId,
      includeBridges: this.bridgesFor(executesPayload),
    })
    return tokens.map(toBridgeToken)
  }

  async getRoutes(request: BridgeQuoteRequest): Promise<BridgeRoutes> {
    // An empty payload means direct delivery: the bridge is asked for a plain transfer to the drop, so
    // there is nothing to execute and no destination gas to prepay. This distinction is load-bearing
    // everywhere downstream — asking a bridge for execution we do not need would restrict the route
    // set for no reason. See `directDelivery` in the SDK.
    const executesPayload = request.destination.payload !== '0x'
    const { destination } = request

    const result = await this.api.getQuote({
      userAddress: request.sender,
      originChainId: String(request.sellChainId),
      destinationChainId: String(request.buyChainId),
      inputToken: request.sellToken,
      inputAmount: request.sellAmount.toString(),
      receiverAddress: destination.receiver,
      outputToken: request.buyToken,
      enableManual: true,
      disableSwapping: true,
      disableAuto: true,
      includeBridges: this.bridgesFor(executesPayload)?.join(','),
      destinationPayload: executesPayload ? destination.payload : undefined,
      destinationGasLimit: executesPayload ? String(destination.gasLimit) : undefined,
    })

    const now = this.nowSeconds()
    const shared = responseChecks(request, result)

    const routes = (result.manualRoutes ?? []).map((route) =>
      this.toBridgeRoute(request, route, shared, now),
    )

    return {
      provider: this.info.key,
      request,
      // Allowed first, then most delivered. A user scanning this wants the usable ones together, and
      // among those the one that arrives largest.
      routes: [...routes].sort(
        (a, b) =>
          Number(b.allowed) - Number(a.allowed) || (b.output.amount > a.output.amount ? 1 : -1),
      ),
      checks: shared,
      capability: this.deliveryCapability(),
      raw: result,
      quotedAt: now,
    }
  }

  private toBridgeRoute(
    request: BridgeQuoteRequest,
    route: BungeeRouteWire,
    shared: readonly CheckOutcome[],
    now: number,
  ): BridgeRoute {
    // Response-wide failures are copied onto every route rather than held beside them. A route is
    // what the UI keeps once the user picks one, so it has to be gate-able entirely on its own.
    const eligibility = summarise([
      ...shared,
      ...routeChecks(request, route, { now, capabilityOverrides: this.capabilityOverrides }),
    ])

    return {
      id: route.quoteId,
      name: route.routeDetails.name,
      // Zero is not an estimate. `Math.round(0 / 60)` reads as "about 0 min", which is a claim.
      estimatedSeconds: route.estimatedTime > 0 ? route.estimatedTime : null,
      output: {
        token: toBridgeToken(route.output.token),
        amount: BigInt(route.output.amount),
        minAmount: BigInt(route.output.minAmountOut),
      },
      expiresAt: route.quoteExpiry,
      eligibility,
      allowed: eligibility.sendable,
      disabledReason: eligibility.sendable ? undefined : eligibility.blocking[0]?.detail,
      raw: route,
    }
  }

  async buildQuote(routes: BridgeRoutes, routeId: string): Promise<BridgeQuote> {
    const route = routes.routes.find((candidate) => candidate.id === routeId)
    if (!route) {
      throw new BridgeError('route-not-found', 'that route is not in this set — re-quote and pick again', {
        routeId,
        available: routes.routes.map((candidate) => candidate.id),
      })
    }

    // Refused before any HTTP call, which is the point of the two-step split: a transaction for a
    // route we will not use is never built, so its calldata never exists to be read by mistake.
    if (!route.allowed) {
      throw new BridgeError('unsafe-quote', route.disabledReason ?? 'this route did not pass verification', {
        ...route.eligibility,
      })
    }

    // Checked locally first so the common case is one clear error rather than an opaque build failure.
    if (route.expiresAt <= this.nowSeconds()) {
      throw new BridgeError('route-expired', 'this route’s quote expired before it could be built', {
        routeId,
        expiresAt: route.expiresAt,
      })
    }

    const request = routes.request
    const built = await this.api.getBuildTx(routeId)
    const wireRoute = route.raw as BungeeRouteWire

    const verification = summarise(
      transactionChecks(request, wireRoute, built, { now: this.nowSeconds() }),
    )

    const data = built.txData.data as Hex

    return {
      provider: this.info.key,
      route,
      input: {
        token: toBridgeToken((routes.raw as BungeeQuoteResponseWire['result']).input.token),
        amount: request.sellAmount,
      },
      output: route.output,
      approval: built.approvalData
        ? {
            spender: built.approvalData.spenderAddress as Address,
            token: built.approvalData.tokenAddress as Address,
            amount: BigInt(built.approvalData.amount),
          }
        : null,
      transactionSummary: {
        to: built.txData.to as Address,
        chainId: built.txData.chainId,
        value: BigInt(built.txData.value),
        dataBytes: byteLength(data),
        selector: data.slice(0, 10) as Hex,
        data,
      },
      verification,
      expiresAt: route.expiresAt,
      destination: request.destination,
      raw: { quote: routes.raw, build: built },
    }
  }

  /**
   * Routes, then the best allowed one, built.
   *
   * A convenience for scripts and for the README's example. Not the path a UI should take: it picks a
   * route on the user's behalf, and the whole point of the split is that a person gets to see what was
   * refused and why before anything is built.
   */
  async getQuote(request: BridgeQuoteRequest): Promise<BridgeQuote> {
    const routes = await this.getRoutes(request)
    const best = routes.routes.find((route) => route.allowed)

    if (!best) {
      throw new BridgeError(
        'no-eligible-routes',
        'every route Bungee offered for this delivery is disabled',
        {
          capability: routes.capability,
          reasons: routes.routes.map((route) => ({ name: route.name, reason: route.disabledReason })),
        },
      )
    }

    return this.buildQuote(routes, best.id)
  }

  explorerUrl(sourceTxHash: Hex): string {
    return `https://socketscan.io/tx/${sourceTxHash}`
  }
}

/** The verdicts on a set of routes, for a caller asking "is this our bug?". */
export function routeVerifications(routes: BridgeRoutes): Verification[] {
  return routes.routes.map((route) => route.eligibility)
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
