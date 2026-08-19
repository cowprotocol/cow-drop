import { BridgeError } from '../errors.js'
import {
  BUNGEE_API_PATH,
  BUNGEE_BASE_URL,
  BUNGEE_MANUAL_API_PATH,
  DESTINATION_EXECUTING_BRIDGES,
  type BungeeBuildTxResponseWire,
  type BungeeQuoteRequestWire,
  type BungeeQuoteResponseWire,
  type BungeeRouteWire,
  type BungeeTokenListResponseWire,
  type BungeeTokenWire,
  type BridgeName,
} from './wire.js'

/**
 * The Bungee HTTP API, and nothing else.
 *
 * Split from the provider so the provider has no I/O in it and this has no drop knowledge in it.
 * `fetch` is injected rather than reached for, which is what lets the tests run with no network —
 * the rule every other package here follows.
 */
export interface BungeeApiOptions {
  baseUrl?: string
  manualBaseUrl?: string
  /**
   * Restrict the bridges Bungee may route through.
   *
   * Defaults to `DESTINATION_EXECUTING_BRIDGES`, and read that comment before widening it: a bridge
   * that ignores the destination payload quotes exactly like one that honours it, and delivering
   * through one strands the tokens at the receiver with no drop funded and no order placed.
   */
  includeBridges?: readonly BridgeName[]
  fetch?: typeof globalThis.fetch
}

export class BungeeApi {
  private readonly baseUrl: string
  private readonly manualBaseUrl: string
  private readonly includeBridges: readonly BridgeName[]
  private readonly doFetch: typeof globalThis.fetch

  constructor(options: BungeeApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? `${BUNGEE_BASE_URL}${BUNGEE_API_PATH}`
    this.manualBaseUrl = options.manualBaseUrl ?? `${BUNGEE_BASE_URL}${BUNGEE_MANUAL_API_PATH}`
    this.includeBridges = options.includeBridges ?? DESTINATION_EXECUTING_BRIDGES

    const injected = options.fetch ?? globalThis.fetch
    if (!injected) throw new Error('no fetch available: pass one in BungeeApiOptions')
    // Bound, because an unbound `globalThis.fetch` throws "Illegal invocation" in a browser.
    this.doFetch = injected.bind(globalThis)
  }

  /** The tokens a bridge can deliver on `toChainId` — the drop's candidate sell tokens. */
  async getDeliverableTokens(params: {
    fromChainId?: number
    fromTokenAddress?: string
    toChainId: number
  }): Promise<BungeeTokenWire[]> {
    const response = await this.get<BungeeTokenListResponseWire>(this.manualBaseUrl, '/dest-tokens', {
      toChainId: String(params.toChainId),
      fromChainId: params.fromChainId === undefined ? undefined : String(params.fromChainId),
      fromTokenAddress: params.fromTokenAddress,
      includeBridges: this.includeBridges.join(','),
    })

    if (!response.success) throw new BridgeError('quote-failed', 'Bungee could not list destination tokens', response)
    return response.result
  }

  /**
   * A quote, reduced to its best manual route.
   *
   * "Best" is largest output. Bungee returns the routes unordered and the difference between them is
   * fees and time; a bridge that is feeding a limit order wants the most tokens to arrive, and the
   * order's own `validTo` is what bounds the time.
   */
  async getQuote(request: BungeeQuoteRequestWire): Promise<{ route: BungeeRouteWire; input: BungeeTokenWire }> {
    const response = await this.get<BungeeQuoteResponseWire>(this.baseUrl, '/quote', {
      ...request,
      includeBridges: request.includeBridges ?? this.includeBridges.join(','),
    })

    if (!response.success) throw new BridgeError('quote-failed', 'Bungee rejected the quote request', response)

    const routes = response.result.manualRoutes ?? []
    const best = routes.reduce<BungeeRouteWire | undefined>(
      (winner, route) => (winner && BigInt(winner.output.amount) >= BigInt(route.output.amount) ? winner : route),
      undefined,
    )

    if (!best) {
      throw new BridgeError('no-routes', 'Bungee has no route for this pair and amount', response.result)
    }

    return { route: best, input: response.result.input.token }
  }

  /** The source-chain transaction for a quoted route. */
  async getBuildTx(quoteId: string): Promise<BungeeBuildTxResponseWire['result']> {
    const response = await this.get<BungeeBuildTxResponseWire>(this.baseUrl, '/build-tx', { quoteId })

    if (!response.success) {
      throw new BridgeError('build-failed', 'Bungee could not build the transaction — the quote may have expired', {
        quoteId,
        response,
      })
    }
    return response.result
  }

  /**
   * `undefined` values are dropped rather than sent as the string "undefined" — the difference
   * between omitting an optional filter and asking Bungee to match one named "undefined".
   *
   * Booleans are accepted because the quote request carries literal `true`s, and stringifying them
   * at the boundary keeps that shape readable at the call site.
   */
  private async get<T>(
    base: string,
    path: string,
    params: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, String(value))
    }

    const url = `${base}${path}?${search.toString()}`

    let response: Response
    try {
      response = await this.doFetch(url, { headers: { accept: 'application/json' } })
    } catch (cause) {
      throw new BridgeError('unreachable', `could not reach Bungee at ${base}${path}`, cause)
    }

    if (!response.ok) {
      throw new BridgeError('unreachable', `Bungee answered ${response.status} for ${path}`, await safeText(response))
    }

    try {
      return (await response.json()) as T
    } catch (cause) {
      throw new BridgeError('unreachable', `Bungee returned a non-JSON body for ${path}`, cause)
    }
  }
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return await response.text()
  } catch {
    return undefined
  }
}
