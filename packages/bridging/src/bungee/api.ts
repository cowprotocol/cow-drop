import { BridgeError } from '../errors.js'
import type { DestinationExecution } from './capability.js'
import {
  BUNGEE_API_PATH,
  BUNGEE_BASE_URL,
  BUNGEE_MANUAL_API_PATH,
  type BungeeBuildTxResponseWire,
  type BungeeQuoteRequestWire,
  type BungeeQuoteResponseWire,
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
   * Narrow the bridges Bungee may route through.
   *
   * **No longer a safety mechanism.** It used to be the only one, and that was the defect: a request
   * parameter cannot protect anything, because nothing ever confronts it with the response. Safety is
   * now the capability registry plus a verdict that makes an unsafe transaction unobtainable, and this
   * is what it always should have been — a preference about reach and latency.
   */
  includeBridges?: readonly BridgeName[]
  fetch?: typeof globalThis.fetch
  /** Injected so expiry checks are deterministic in tests. Defaults to the wall clock. */
  now?: () => number
  /**
   * Override the destination-execution registry.
   *
   * The only way to exercise the code that runs when atomic delivery *is* available, since nothing is
   * observed yet. Application code must never set it: an `observed` entry with no evidence behind it
   * is precisely the belief this whole layer exists to delete.
   */
  capabilityOverrides?: Readonly<Record<string, DestinationExecution>>
}

export class BungeeApi {
  private readonly baseUrl: string
  private readonly manualBaseUrl: string
  private readonly includeBridges: readonly BridgeName[] | undefined
  private readonly doFetch: typeof globalThis.fetch

  constructor(options: BungeeApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? `${BUNGEE_BASE_URL}${BUNGEE_API_PATH}`
    this.manualBaseUrl = options.manualBaseUrl ?? `${BUNGEE_BASE_URL}${BUNGEE_MANUAL_API_PATH}`
    this.includeBridges = options.includeBridges

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
    /** Omit to ask what *any* bridge can deliver, which is the right question for a plain transfer. */
    includeBridges?: readonly BridgeName[]
  }): Promise<BungeeTokenWire[]> {
    const response = await this.get<BungeeTokenListResponseWire>(this.manualBaseUrl, '/dest-tokens', {
      toChainId: String(params.toChainId),
      fromChainId: params.fromChainId === undefined ? undefined : String(params.fromChainId),
      fromTokenAddress: params.fromTokenAddress,
      includeBridges: (params.includeBridges ?? this.includeBridges)?.join(','),
    })

    if (!response.success) throw new BridgeError('quote-failed', 'Bungee could not list destination tokens', response)
    return response.result
  }

  /**
   * A quote, with every manual route it offered.
   *
   * This used to reduce the routes to the single largest output and throw the rest away, here in the
   * API layer where the provider could never see them. That was two bugs in one line. It meant the
   * provider structurally *could not* compare a route against a policy, because by the time it was
   * asked there was only one route left and no alternative to prefer. And it hid the routes a user
   * most needs to see: the disabled ones, which are the only explanation for why a delivery mode is
   * unavailable. A list where every row says why it cannot be used is a designed refusal; an empty
   * screen is an apparent outage.
   *
   * Selection is the caller's job now. `no-routes` still belongs here, because "Bungee offered
   * nothing" is a fact about the response rather than a policy decision.
   */
  async getQuote(request: BungeeQuoteRequestWire): Promise<BungeeQuoteResponseWire['result']> {
    const response = await this.get<BungeeQuoteResponseWire>(this.baseUrl, '/quote', {
      ...request,
      includeBridges: request.includeBridges ?? this.includeBridges?.join(','),
    })

    if (!response.success) throw new BridgeError('quote-failed', 'Bungee rejected the quote request', response)

    if ((response.result.manualRoutes ?? []).length === 0) {
      throw new BridgeError('no-routes', 'Bungee has no route for this pair and amount', response.result)
    }

    return response.result
  }

  /**
   * The source-chain transaction for a quoted route.
   *
   * Note what this does *not* do: it never re-quotes. A silent re-quote would build a route the user
   * saw no verdict for, which is the exact class of substitution the verification layer exists to
   * catch. An expired quoteId is a `build-failed` for the caller to turn into a rebuild.
   */
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
