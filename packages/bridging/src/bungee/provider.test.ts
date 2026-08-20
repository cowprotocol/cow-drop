import { bungeeDelivery, compileRecipe, directDelivery, swapOnArrival } from '@cowprotocol/cow-drop-sdk'
import { describe, expect, it } from 'vitest'
import { keccak256, type Address, type Hex } from 'viem'

import { sendableTransaction, type BridgeQuoteRequest } from '../types.js'
import { BridgeError } from '../errors.js'
import type { DestinationExecution } from './capability.js'
import { BungeeDropProvider } from './provider.js'

const SENDER: Address = '0x1111111111111111111111111111111111111111'
const USDC_BASE: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_GNOSIS: Address = '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0'
const COW: Address = '0x177127622c4A00F3d409B75571e12cB3c8973d3c'
const SPENDER: Address = '0x3a23F943181408EAC424116Af7b7790c94Cb97a5'
const BASE = 8453
const GNOSIS = 100

/** 600 seconds before the fixtures' `quoteExpiry`, injected so nothing here depends on the wall clock. */
const NOW_MS = 1_800_000_000_000
const NOW_SECONDS = 1_800_000_000

/**
 * Pretend `Across` has been watched running a payload.
 *
 * The only way to reach the code that runs when atomic delivery is available, because nothing is
 * observed for real. Never do this outside a test — see `capability.ts`.
 */
const ACROSS_OBSERVED: Readonly<Record<string, DestinationExecution>> = {
  across: {
    status: 'observed',
    evidence: {
      chainId: GNOSIS,
      txHash: `0x${'ab'.repeat(32)}`,
      url: 'https://example.invalid/tx',
      observedOn: '2026-01-01',
    },
  },
}

/** The drop the bridge is aimed at: sell whatever USDC arrives on Gnosis for COW. */
function compiled() {
  return compileRecipe(
    swapOnArrival({
      chainId: GNOSIS,
      owner: SENDER,
      sellToken: USDC_GNOSIS,
      buyToken: COW,
      limitPrice: { price: '2.5', sellDecimals: 6, buyDecimals: 18 },
    }),
  )
}

/** Atomic: the bridge pays the receiver and runs the recipe on arrival. */
function destination() {
  return bungeeDelivery(compiled())
}

/** Direct: the bridge pays the drop and nothing runs on arrival. */
function directDestination() {
  return directDelivery(compiled())
}

function token(address: Address, symbol: string, decimals: number, chainId: number) {
  return { chainId, address, name: symbol, symbol, decimals, logoURI: `https://logos/${symbol}.png` }
}

function route(quoteId: string, amount: string, name = 'Across') {
  return {
    quoteId,
    quoteExpiry: 1_800_000_600,
    output: { token: token(USDC_GNOSIS, 'USDC', 6, GNOSIS), amount, minAmountOut: '990000000' },
    approvalData: {
      spenderAddress: SPENDER,
      amount: '1000000000',
      tokenAddress: USDC_BASE,
      userAddress: SENDER,
    },
    estimatedTime: 120,
    routeDetails: { name },
  }
}

/**
 * A fetch that never leaves the process, and records what it was asked.
 *
 * `calls` matters as much as the canned bodies — several of the assertions below are that a request
 * was **not** made at all, which is the only way to show that a refused route never reaches `/build-tx`.
 */
function fakeFetch(bodies: Record<string, unknown>, options: { status?: number } = {}) {
  const calls: URL[] = []

  const doFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input))
    calls.push(url)

    const match = Object.keys(bodies).find((path) => url.pathname.endsWith(path))
    if (options.status !== undefined) {
      return new Response('upstream is unwell', { status: options.status })
    }
    if (!match) throw new Error(`unexpected request in a hermetic test: ${url.pathname}`)

    return new Response(JSON.stringify(bodies[match]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  return { doFetch: doFetch as unknown as typeof globalThis.fetch, calls }
}

function quoteBody(routes: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    statusCode: 200,
    result: {
      originChainId: BASE,
      destinationChainId: GNOSIS,
      userAddress: SENDER,
      receiverAddress: destination().receiver,
      input: { token: token(USDC_BASE, 'USDC', 6, BASE), amount: '1000000000' },
      manualRoutes: routes,
      ...overrides,
    },
  }
}

/**
 * A build response, as a factory rather than a constant.
 *
 * The whole point of the verification layer is what the built calldata does or does not contain, so a
 * test has to be able to plant those bytes. A shared `const` could not express the case that lost the
 * money.
 */
function buildBody(
  overrides: {
    data?: Hex
    to?: Address
    chainId?: number
    value?: string
    approval?: { spenderAddress?: Address; amount?: string; tokenAddress?: Address; userAddress?: Address } | null
  } = {},
) {
  const approval =
    overrides.approval === null
      ? null
      : {
          spenderAddress: SPENDER,
          amount: '1000000000',
          tokenAddress: USDC_BASE,
          userAddress: SENDER,
          ...overrides.approval,
        }

  return {
    success: true,
    statusCode: 200,
    result: {
      approvalData: approval,
      txData: {
        data: overrides.data ?? packedCalldata({ payload: destination().payload }),
        to: overrides.to ?? SPENDER,
        chainId: overrides.chainId ?? BASE,
        value: overrides.value ?? '0',
      },
      userOp: null,
    },
  }
}

/**
 * Calldata shaped the way Bungee's really is: a selector, then packed arguments.
 *
 * Modelled on a real source transaction — route id, receiver, token, amount — where the values are
 * packed rather than ABI-encoded. Omitting `payload` is the shape that strands a delivery; supplying
 * it is what a working one looks like.
 */
function packedCalldata(parts: { receiver?: Address; token?: Address; amount?: bigint; payload?: Hex } = {}): Hex {
  const receiver = (parts.receiver ?? destination().receiver).slice(2)
  const tokenAddress = (parts.token ?? USDC_BASE).slice(2)
  const amount = (parts.amount ?? 1_000_000_000n).toString(16).padStart(64, '0')
  const payload = parts.payload ? parts.payload.slice(2) : ''

  return `0x000001bc${receiver}${tokenAddress}${amount}${payload}`
}

/**
 * A real Bungee source transaction's byte layout, transcribed with the amount replaced.
 *
 * Worth having as a frozen fixture rather than only the generated one above, because two properties of
 * it are not obvious and both matter: the recipient's 20 bytes appear **verbatim** in packed calldata,
 * and they **straddle a 32-byte boundary** — so a word-aligned search would miss them, and a
 * nibble-aligned one could match something that is not there. The recipient here is our own deployed
 * receiver, which lands at byte 52.
 *
 * The payload is absent, which is the shape that strands a delivery: the payload is accepted in the
 * quote and the built transaction has no field to put it in.
 */
const PACKED_WITHOUT_PAYLOAD: Hex = ('0x000001bc' +
  '3bf5c22800000000000000000000000000000000000000000000000000000000' +
  '00002713000000000000000000000000bf4b4b7ab60a2435177753ae32e26196' +
  '27dc7e3c000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead908' +
  '3c756cc200000000000000000000000000000000000000000000000000000000' +
  '00000064000000000000000000000000000000000000000000000000000f4240' +
  '00000000') as Hex
const PACKED_RECEIVER: Address = '0xbF4B4b7Ab60A2435177753ae32E2619627DC7e3C'

function request(overrides: Partial<BridgeQuoteRequest> = {}): BridgeQuoteRequest {
  return {
    sender: SENDER,
    sellChainId: BASE,
    sellToken: USDC_BASE,
    sellAmount: 1_000_000_000n,
    buyChainId: GNOSIS,
    buyToken: USDC_GNOSIS,
    destination: destination(),
    expectedRecipe: compiled(),
    ...overrides,
  }
}

function provider(
  doFetch: typeof globalThis.fetch,
  options: { capabilityOverrides?: Readonly<Record<string, DestinationExecution>>; includeBridges?: string[] } = {},
) {
  return new BungeeDropProvider({ fetch: doFetch, now: () => NOW_MS, ...options })
}

// =============================================================================================
// The incident
// =============================================================================================

describe('the two ways a delivery was stranded', () => {
  /**
   * Cause one: `gnosis-native-bridge` was on an allowlist that nobody had checked, and it cannot run
   * our payload by ABI. The assertion that matters most is the last one — no `/build-tx` call. The
   * gate is structural, so calldata for a route we refuse is never even requested, let alone read.
   */
  it('refuses a gnosis-native-bridge route for atomic delivery, without building anything', async () => {
    const { doFetch, calls } = fakeFetch({
      '/quote': quoteBody([route('q1', '999000000', 'gnosis-native-bridge')]),
      '/build-tx': buildBody(),
    })

    const routes = await provider(doFetch).getRoutes(request())

    expect(routes.routes).toHaveLength(1)
    expect(routes.routes[0]?.allowed).toBe(false)
    expect(routes.routes[0]?.disabledReason).toMatch(/onTokenBridged/)
    expect(routes.routes[0]?.eligibility.blocking[0]?.check).toBe('destination-execution')

    await expect(provider(doFetch).buildQuote(routes, 'q1')).rejects.toMatchObject({ code: 'unsafe-quote' })
    expect(calls.some((url) => url.pathname.endsWith('/build-tx'))).toBe(false)
  })

  /**
   * Cause two: the payload never left Ethereum. Bungee echoed `destinationPayload` back in the quote
   * and then built a transaction with no field for it — and nothing in the old code compared the two.
   * Here the capability check is forced to pass so that this is the *only* thing left to catch it.
   */
  it('refuses a transaction whose calldata does not carry the payload', async () => {
    const { doFetch } = fakeFetch({
      '/quote': quoteBody([route('q1', '999000000')]),
      '/build-tx': buildBody({ data: packedCalldata() }),
    })

    const bungee = provider(doFetch, { capabilityOverrides: ACROSS_OBSERVED })
    const routes = await bungee.getRoutes(request())
    expect(routes.routes[0]?.allowed).toBe(true)

    const quote = await bungee.buildQuote(routes, 'q1')

    expect(quote.verification.sendable).toBe(false)
    expect(quote.verification.blocking.map((failure) => failure.check)).toContain('payload-in-calldata')
    expect(() => sendableTransaction(quote)).toThrow(/did not pass verification/)
  })

  /** Against a real byte layout, so the checks are pinned to an encoding rather than to a model of one. */
  it('finds a straddling receiver and still misses an absent payload', async () => {
    const { doFetch } = fakeFetch({
      '/quote': quoteBody([route('q1', '999000000')], { receiverAddress: PACKED_RECEIVER }),
      '/build-tx': buildBody({ data: PACKED_WITHOUT_PAYLOAD }),
    })

    const bungee = provider(doFetch, { capabilityOverrides: ACROSS_OBSERVED })
    const target = { ...destination(), receiver: PACKED_RECEIVER }
    const routes = await bungee.getRoutes(request({ destination: target, expectedRecipe: undefined }))
    const quote = await bungee.buildQuote(routes, 'q1')

    const receiverCheck = quote.verification.checks.find((check) => check.check === 'receiver-in-calldata')
    expect(receiverCheck?.state).toBe('pass')
    // Byte 52, straddling a 32-byte boundary — which is why the search has to be byte-aligned rather
    // than word-aligned, and why it must not match on a nibble.
    expect(receiverCheck?.state === 'pass' ? receiverCheck.where : null).toBe(52)

    expect(quote.verification.blocking.map((failure) => failure.check)).toContain('payload-in-calldata')
    expect(quote.verification.sendable).toBe(false)
  })
})

// =============================================================================================
// getRoutes
// =============================================================================================

describe('BungeeDropProvider.getRoutes', () => {
  it('asks Bungee to pay the receiver and to run the drop payload', async () => {
    const { doFetch, calls } = fakeFetch({ '/quote': quoteBody([route('q1', '999000000')]) })
    const target = destination()

    await provider(doFetch).getRoutes(request())

    const quote = calls.find((url) => url.pathname.endsWith('/quote'))
    expect(quote?.searchParams.get('receiverAddress')).toBe(target.receiver)
    expect(quote?.searchParams.get('destinationPayload')).toBe(target.payload)
    expect(quote?.searchParams.get('destinationGasLimit')).toBe(String(target.gasLimit))
    expect(quote?.searchParams.get('enableManual')).toBe('true')
    expect(quote?.searchParams.get('disableSwapping')).toBe('true')
    expect(quote?.searchParams.get('disableAuto')).toBe('true')
  })

  /**
   * This replaces a test that asserted `includeBridges` equalled the old allowlist. That test was
   * asserting a *belief* — it checked that we asked for three bridge names, which is not a safety
   * property, and two of those names had never been observed while the third could not work at all.
   *
   * Safety now lives on the response. Asking unfiltered is deliberate: it is what lets every route
   * come back with its own reason, instead of an empty list that reads like an outage.
   */
  it('asks unfiltered in atomic mode while nothing has been observed', async () => {
    const { doFetch, calls } = fakeFetch({ '/quote': quoteBody([route('q1', '999000000')]) })

    await provider(doFetch).getRoutes(request())

    const quote = calls.find((url) => url.pathname.endsWith('/quote'))
    expect(quote?.searchParams.has('includeBridges')).toBe(false)
    expect(quote?.searchParams.get('destinationPayload')).toBe(destination().payload)
  })

  it('narrows to the observed set once there is one', async () => {
    const { doFetch, calls } = fakeFetch({ '/quote': quoteBody([route('q1', '999000000')]) })

    const routes = await provider(doFetch, { capabilityOverrides: ACROSS_OBSERVED }).getRoutes(request())

    expect(calls[0]?.searchParams.get('includeBridges')).toBe('across')
    expect(routes.routes[0]?.allowed).toBe(true)
  })

  /**
   * Direct delivery asks the bridge for a plain transfer, so the capability question does not arise —
   * and must not be applied. Doing so would refuse pairs that work perfectly well; Base to Gnosis is
   * exactly such a pair, and getting this wrong is the bug `ab81c4a` and `cef5d67` were about.
   */
  it('asks for no payload and no bridge filter in direct mode', async () => {
    const { doFetch, calls } = fakeFetch({ '/quote': quoteBody([route('q1', '999000000')]) })

    await provider(doFetch).getRoutes(request({ destination: directDestination() }))

    const quote = calls.find((url) => url.pathname.endsWith('/quote'))
    expect(quote?.searchParams.has('includeBridges')).toBe(false)
    expect(quote?.searchParams.has('destinationPayload')).toBe(false)
    expect(quote?.searchParams.has('destinationGasLimit')).toBe(false)
    expect(quote?.searchParams.get('receiverAddress')).toBe(directDestination().predictedAddress)
  })

  /** Symbiosis delivers a plain transfer, which is exactly what direct mode asked it for. */
  it('allows a bridge that cannot run payloads when nothing needs running', async () => {
    const { doFetch } = fakeFetch({
      '/quote': quoteBody([route('q1', '999000000', 'symbiosis')], {
        receiverAddress: directDestination().receiver,
      }),
    })

    const routes = await provider(doFetch).getRoutes(request({ destination: directDestination() }))

    expect(routes.routes[0]?.allowed).toBe(true)
    expect(
      routes.routes[0]?.eligibility.checks.find((check) => check.check === 'destination-execution')?.state,
    ).toBe('not-applicable')
  })

  it('returns every route, allowed first and then by output, keeping their ids', async () => {
    const routes = [
      route('broken', '999999999', 'gnosis-native-bridge'),
      route('cheap', '900000000'),
      route('best', '990000000'),
    ]
    const { doFetch } = fakeFetch({ '/quote': quoteBody(routes) })

    const listed = await provider(doFetch, { capabilityOverrides: ACROSS_OBSERVED }).getRoutes(request())

    expect(listed.routes.map((route) => route.id)).toEqual(['best', 'cheap', 'broken'])
    expect(listed.routes.map((route) => route.allowed)).toEqual([true, true, false])
  })

  it('reports having no route rather than returning an empty set', async () => {
    const { doFetch } = fakeFetch({ '/quote': quoteBody([]) })

    await expect(provider(doFetch).getRoutes(request())).rejects.toMatchObject({ code: 'no-routes' })
  })

  it('does not present an upstream outage as a missing route', async () => {
    const { doFetch } = fakeFetch({}, { status: 503 })

    await expect(provider(doFetch).getRoutes(request())).rejects.toMatchObject({ code: 'unreachable' })
  })

  it('reads an absent time estimate as unknown rather than as zero', async () => {
    const { doFetch } = fakeFetch({
      '/quote': quoteBody([{ ...route('q1', '999000000'), estimatedTime: 0 }]),
    })

    const routes = await provider(doFetch).getRoutes(request())
    expect(routes.routes[0]?.estimatedSeconds).toBeNull()
  })

  describe('the response as a whole', () => {
    const CASES: { name: string; overrides: Record<string, unknown>; check: string }[] = [
      { name: 'pays somebody else', overrides: { receiverAddress: COW }, check: 'receiver-echo' },
      { name: 'is for another account', overrides: { userAddress: COW }, check: 'user-echo' },
      { name: 'delivers on another chain', overrides: { destinationChainId: 1 }, check: 'output-chain' },
      {
        name: 'is for another amount',
        overrides: { input: { token: token(USDC_BASE, 'USDC', 6, BASE), amount: '1' } },
        check: 'input-amount',
      },
      {
        name: 'is for another token',
        overrides: { input: { token: token(COW, 'COW', 18, BASE), amount: '1000000000' } },
        check: 'input-token',
      },
    ]

    /**
     * A response that disagrees with the request is not an answer to it, so it disables *every* route
     * rather than one. Nothing else in such a response can be trusted either — including the calldata
     * we would otherwise have gone on to sign.
     */
    for (const { name, overrides, check } of CASES) {
      it(`disables every route when the response ${name}`, async () => {
        const { doFetch } = fakeFetch({
          '/quote': quoteBody([route('a', '999000000'), route('b', '900000000')], overrides),
        })

        const routes = await provider(doFetch, { capabilityOverrides: ACROSS_OBSERVED }).getRoutes(request())

        expect(routes.routes.map((route) => route.allowed)).toEqual([false, false])
        for (const route of routes.routes) {
          expect(route.eligibility.blocking.map((failure) => failure.check)).toContain(check)
        }
      })
    }
  })

  it('disables a route that would deliver a token the recipe cannot sell', async () => {
    const wrongOutput = { ...route('q1', '999000000') }
    wrongOutput.output = { ...wrongOutput.output, token: token(COW, 'COW', 18, GNOSIS) }
    const { doFetch } = fakeFetch({ '/quote': quoteBody([wrongOutput]) })

    const routes = await provider(doFetch, { capabilityOverrides: ACROSS_OBSERVED }).getRoutes(request())

    expect(routes.routes[0]?.allowed).toBe(false)
    expect(routes.routes[0]?.eligibility.blocking.map((failure) => failure.check)).toContain('output-token')
  })

  /** Advisory, so a fast local clock cannot take every route away. See the reasoning in `verify.ts`. */
  it('keeps an expired route selectable and merely says so', async () => {
    const stale = { ...route('q1', '999000000'), quoteExpiry: NOW_SECONDS - 30 }
    const { doFetch } = fakeFetch({ '/quote': quoteBody([stale]) })

    const routes = await provider(doFetch, { capabilityOverrides: ACROSS_OBSERVED }).getRoutes(request())

    expect(routes.routes[0]?.allowed).toBe(true)
    expect(routes.routes[0]?.eligibility.advisories.map((failure) => failure.check)).toContain('route-expiry')
  })
})

// =============================================================================================
// buildQuote
// =============================================================================================

describe('BungeeDropProvider.buildQuote', () => {
  async function listed(bodies: Record<string, unknown>, req = request()) {
    const { doFetch, calls } = fakeFetch(bodies)
    const bungee = provider(doFetch, { capabilityOverrides: ACROSS_OBSERVED })
    return { bungee, calls, routes: await bungee.getRoutes(req) }
  }

  it('passes everything and reports where each value sits in the bytes', async () => {
    const { bungee, routes } = await listed({
      '/quote': quoteBody([route('q1', '999000000')]),
      '/build-tx': buildBody(),
    })

    const quote = await bungee.buildQuote(routes, 'q1')

    expect(quote.verification.sendable).toBe(true)
    expect(quote.verification.blocking).toEqual([])
    expect(sendableTransaction(quote)).toEqual({
      to: SPENDER,
      data: buildBody().result.txData.data,
      value: 0n,
      chainId: BASE,
    })

    const receiver = quote.verification.checks.find((check) => check.check === 'receiver-in-calldata')
    expect(receiver?.state === 'pass' ? receiver.where : null).toBe(4)
    const payload = quote.verification.checks.find((check) => check.check === 'payload-in-calldata')
    expect(payload?.state === 'pass' ? payload.where : null).toBe(76)
  })

  it('accepts a payload committed to by hash', async () => {
    const hashed = `0x000001bc${destination().receiver.slice(2)}${keccak256(destination().payload).slice(2)}` as Hex
    const { bungee, routes } = await listed({
      '/quote': quoteBody([route('q1', '999000000')]),
      '/build-tx': buildBody({ data: hashed }),
    })

    const quote = await bungee.buildQuote(routes, 'q1')
    const payload = quote.verification.checks.find((check) => check.check === 'payload-in-calldata')

    expect(payload?.state).toBe('pass')
    expect(payload?.detail).toMatch(/as its hash/)
    expect(quote.verification.sendable).toBe(true)
  })

  it('refuses calldata that does not name the receiver', async () => {
    const { bungee, routes } = await listed({
      '/quote': quoteBody([route('q1', '999000000')]),
      '/build-tx': buildBody({ data: `0x000001bc${COW.slice(2)}${destination().payload.slice(2)}` as Hex }),
    })

    const quote = await bungee.buildQuote(routes, 'q1')

    expect(quote.verification.blocking.map((failure) => failure.check)).toContain('receiver-in-calldata')
    expect(() => sendableTransaction(quote)).toThrow()
  })

  it('refuses a transaction built for another chain', async () => {
    const { bungee, routes } = await listed({
      '/quote': quoteBody([route('q1', '999000000')]),
      '/build-tx': buildBody({ chainId: 1 }),
    })

    const quote = await bungee.buildQuote(routes, 'q1')
    expect(quote.verification.blocking.map((failure) => failure.check)).toContain('tx-chain')
  })

  it('refuses a transaction built for a different bridge than the one selected', async () => {
    const { bungee, routes } = await listed({
      '/quote': quoteBody([route('q1', '999000000')]),
      '/build-tx': buildBody({ approval: { spenderAddress: COW } }),
    })

    const quote = await bungee.buildQuote(routes, 'q1')
    expect(quote.verification.blocking.map((failure) => failure.check)).toContain('route-identity')
  })

  it('refuses an approval for the wrong token or the wrong account', async () => {
    for (const [override, check] of [
      [{ tokenAddress: COW }, 'approval-token'],
      [{ userAddress: COW }, 'approval-user'],
    ] as const) {
      const { bungee, routes } = await listed({
        '/quote': quoteBody([route('q1', '999000000')]),
        '/build-tx': buildBody({ approval: override }),
      })

      const quote = await bungee.buildQuote(routes, 'q1')
      expect(quote.verification.blocking.map((failure) => failure.check)).toContain(check)
    }
  })

  /** Advisory in both directions: an `approve` is a separate transaction the wallet displays itself. */
  it('mentions an unlimited approval without refusing it', async () => {
    const { bungee, routes } = await listed({
      '/quote': quoteBody([route('q1', '999000000')]),
      '/build-tx': buildBody({ approval: { amount: (2n ** 256n - 1n).toString() } }),
    })

    const quote = await bungee.buildQuote(routes, 'q1')

    expect(quote.verification.advisories.map((failure) => failure.check)).toContain('approval-amount')
    expect(quote.verification.sendable).toBe(true)
  })

  /** An amount can legitimately be encoded several ways, so a miss is worth saying and not worth refusing. */
  it('does not refuse a transaction merely because the amount is encoded oddly', async () => {
    const { bungee, routes } = await listed({
      '/quote': quoteBody([route('q1', '999000000')]),
      '/build-tx': buildBody({ data: packedCalldata({ amount: 7n, payload: destination().payload }) }),
    })

    const quote = await bungee.buildQuote(routes, 'q1')

    expect(quote.verification.advisories.map((failure) => failure.check)).toContain('sell-amount-in-calldata')
    expect(quote.verification.sendable).toBe(true)
  })

  /**
   * A native route has no approval to compare and no spender to identify the bridge by. Those must
   * read as inapplicable rather than as failures, or a safety change quietly makes native bridging
   * impossible — and arrives as "the app is broken" rather than as a check that fired.
   */
  it('treats a native-token route’s missing approval as inapplicable, not as a failure', async () => {
    const { bungee, routes } = await listed({
      '/quote': quoteBody([route('q1', '999000000')]),
      '/build-tx': buildBody({ approval: null, value: '1000000000' }),
    })

    const quote = await bungee.buildQuote(routes, 'q1')

    expect(quote.approval).toBeNull()
    expect(quote.verification.sendable).toBe(true)
    for (const check of ['approval-token', 'approval-user', 'approval-amount', 'route-identity'] as const) {
      expect(quote.verification.checks.find((outcome) => outcome.check === check)?.state).toBe('not-applicable')
    }
  })

  it('builds the route it was asked for, not the largest', async () => {
    const { bungee, calls, routes } = await listed({
      '/quote': quoteBody([route('best', '999000000'), route('smaller', '900000000')]),
      '/build-tx': buildBody(),
    })

    await bungee.buildQuote(routes, 'smaller')

    const build = calls.find((url) => url.pathname.endsWith('/build-tx'))
    expect(build?.searchParams.get('quoteId')).toBe('smaller')
  })

  it('refuses an id that is not in the set, without asking Bungee', async () => {
    const { bungee, calls, routes } = await listed({ '/quote': quoteBody([route('q1', '999000000')]) })

    await expect(bungee.buildQuote(routes, 'nope')).rejects.toMatchObject({ code: 'route-not-found' })
    expect(calls.some((url) => url.pathname.endsWith('/build-tx'))).toBe(false)
  })

  /** And specifically not by silently re-quoting, which would build a route nobody saw a verdict for. */
  it('refuses an expired route without building or re-quoting it', async () => {
    const stale = { ...route('q1', '999000000'), quoteExpiry: NOW_SECONDS - 1 }
    const { doFetch, calls } = fakeFetch({ '/quote': quoteBody([stale]), '/build-tx': buildBody() })
    const bungee = provider(doFetch, { capabilityOverrides: ACROSS_OBSERVED })
    const routes = await bungee.getRoutes(request())

    await expect(bungee.buildQuote(routes, 'q1')).rejects.toMatchObject({ code: 'route-expired' })
    expect(calls.filter((url) => url.pathname.endsWith('/quote'))).toHaveLength(1)
    expect(calls.some((url) => url.pathname.endsWith('/build-tx'))).toBe(false)
  })

  it('keeps both responses verbatim, so a raw view shows what actually arrived', async () => {
    const quoteResponse = quoteBody([route('q1', '999000000')])
    const buildResponse = buildBody()
    const { bungee, routes } = await listed({ '/quote': quoteResponse, '/build-tx': buildResponse })

    const quote = await bungee.buildQuote(routes, 'q1')

    expect(quote.raw.quote).toEqual(quoteResponse.result)
    expect(quote.raw.build).toEqual(buildResponse.result)
    // Wire JSON only, so the raw view can stringify it. A mapped quote holds bigints and would throw.
    expect(() => JSON.stringify(quote.raw)).not.toThrow()
  })

  /**
   * The companion to removing the field at the type level. A future "convenience" that re-adds a
   * `transaction` property would restore the exact path the incident's calldata took to a wallet.
   */
  it('exposes no transaction field to read around the verdict', async () => {
    const { bungee, routes } = await listed({
      '/quote': quoteBody([route('q1', '999000000')]),
      '/build-tx': buildBody(),
    })

    const quote = await bungee.buildQuote(routes, 'q1')
    expect('transaction' in quote).toBe(false)
  })

  describe('the delivery target', () => {
    it('catches a payload that names another drop', async () => {
      const other = compileRecipe(
        swapOnArrival({
          chainId: GNOSIS,
          owner: COW,
          sellToken: USDC_GNOSIS,
          buyToken: COW,
          limitPrice: { price: '2.5', sellDecimals: 6, buyDecimals: 18 },
        }),
      )
      const swapped = { ...destination(), payload: bungeeDelivery(other).payload }
      // The calldata genuinely carries the swapped payload, so every structural check passes and this
      // is the only thing left to catch it. That is the situation worth testing: nothing visible is
      // wrong, and the money would activate a different recipe.
      const { bungee, routes } = await listed(
        {
          '/quote': quoteBody([route('q1', '999000000')]),
          '/build-tx': buildBody({ data: packedCalldata({ payload: swapped.payload }) }),
        },
        request({ destination: swapped }),
      )

      const quote = await bungee.buildQuote(routes, 'q1')
      const failure = quote.verification.blocking.find((check) => check.check === 'delivery-target')

      expect(quote.verification.blocking.map((check) => check.check)).toEqual(['delivery-target'])
      expect(failure?.detail).toMatch(/somebody else's recipe/)
    })

    it('says so when no recipe was supplied to check against', async () => {
      const { bungee, routes } = await listed(
        { '/quote': quoteBody([route('q1', '999000000')]), '/build-tx': buildBody() },
        request({ expectedRecipe: undefined }),
      )

      const quote = await bungee.buildQuote(routes, 'q1')
      const check = quote.verification.checks.find((outcome) => outcome.check === 'delivery-target')

      expect(check?.state).toBe('not-applicable')
      expect(check?.detail).toMatch(/strongest available check did not run/)
      expect(quote.verification.sendable).toBe(true)
    })

    it('catches a direct delivery aimed at anything but the drop', async () => {
      const crossed = { ...directDestination(), receiver: COW }
      const { bungee, routes } = await listed(
        {
          '/quote': quoteBody([route('q1', '999000000')], { receiverAddress: COW }),
          '/build-tx': buildBody({ data: packedCalldata({ receiver: COW }) }),
        },
        request({ destination: crossed }),
      )

      const quote = await bungee.buildQuote(routes, 'q1')
      const checks = quote.verification.blocking.map((failure) => failure.check)

      expect(checks).toContain('direct-receiver')
      expect(checks).toContain('delivery-target')
    })
  })
})

// =============================================================================================
// getQuote, the convenience
// =============================================================================================

describe('BungeeDropProvider.getQuote', () => {
  it('picks the best allowed route and builds it', async () => {
    const { doFetch } = fakeFetch({
      '/quote': quoteBody([route('best', '999000000'), route('worse', '900000000')]),
      '/build-tx': buildBody(),
    })

    const quote = await provider(doFetch, { capabilityOverrides: ACROSS_OBSERVED }).getQuote(request())

    expect(quote.route.id).toBe('best')
    expect(quote.output.amount).toBe(999_000_000n)
    expect(quote.expiresAt).toBe(1_800_000_600)
    expect(quote.destination).toEqual(destination())
  })

  /**
   * Distinct from `no-routes` because the remedy differs: this one means switch to direct delivery,
   * not change the pair. It is also the permanent state of atomic delivery until a bridge is observed,
   * which is a designed refusal rather than an outage and has to read that way.
   */
  it('says every route is disabled rather than that there are none', async () => {
    const { doFetch } = fakeFetch({
      '/quote': quoteBody([route('q1', '999000000', 'gnosis-native-bridge')]),
      '/build-tx': buildBody(),
    })

    const error = await provider(doFetch).getQuote(request()).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(BridgeError)
    expect((error as BridgeError).code).toBe('no-eligible-routes')
  })

  it('says the quote expired when the transaction cannot be built', async () => {
    const { doFetch } = fakeFetch({
      '/quote': quoteBody([route('q1', '999000000')]),
      '/build-tx': { success: false, statusCode: 400, result: null },
    })

    const error = await provider(doFetch, { capabilityOverrides: ACROSS_OBSERVED })
      .getQuote(request())
      .catch((cause: unknown) => cause)

    expect((error as BridgeError).code).toBe('build-failed')
  })
})

// =============================================================================================
// getDeliverableTokens
// =============================================================================================

describe('BungeeDropProvider.getDeliverableTokens', () => {
  it('lists what can land in the drop, with the logo field this app uses', async () => {
    const { doFetch, calls } = fakeFetch({
      '/dest-tokens': { success: true, statusCode: 200, result: [token(USDC_GNOSIS, 'USDC', 6, GNOSIS)] },
    })

    const tokens = await provider(doFetch).getDeliverableTokens({
      sellChainId: BASE,
      sellToken: USDC_BASE,
      buyChainId: GNOSIS,
    })

    expect(tokens).toEqual([
      {
        chainId: GNOSIS,
        address: USDC_GNOSIS,
        name: 'USDC',
        symbol: 'USDC',
        decimals: 6,
        logoUrl: 'https://logos/USDC.png',
      },
    ])
    expect(calls[0]?.searchParams.get('toChainId')).toBe(String(GNOSIS))
  })

  /** No bridge can deliver an executed payload while none has been observed doing it, and that needs no round trip. */
  it('answers an atomic question with nothing, and without asking', async () => {
    const { doFetch, calls } = fakeFetch({})

    const tokens = await provider(doFetch).getDeliverableTokens({
      sellChainId: BASE,
      buyChainId: GNOSIS,
      executesPayload: true,
    })

    expect(tokens).toEqual([])
    expect(calls).toEqual([])
  })
})
