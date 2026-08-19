import { bungeeDelivery, compileRecipe, swapOnArrival } from '@cowprotocol/cow-drop-sdk'
import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'

import { BridgeError } from '../errors.js'
import { BungeeDropProvider } from './provider.js'

const SENDER: Address = '0x1111111111111111111111111111111111111111'
const USDC_BASE: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_GNOSIS: Address = '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0'
const COW: Address = '0x177127622c4A00F3d409B75571e12cB3c8973d3c'
const BASE = 8453
const GNOSIS = 100

/** The drop the bridge is aimed at: sell whatever USDC arrives on Gnosis for COW. */
function destination() {
  return bungeeDelivery(
    compileRecipe(
      swapOnArrival({
        chainId: GNOSIS,
        owner: SENDER,
        sellToken: USDC_GNOSIS,
        buyToken: COW,
        limitPrice: { price: '2.5', sellDecimals: 6, buyDecimals: 18 },
      }),
    ),
  )
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
      spenderAddress: '0x3a23F943181408EAC424116Af7b7790c94Cb97a5',
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
 * `calls` is the point of it as much as the canned bodies: most of what matters here is what goes
 * *out* — that the receiver, the payload and the gas limit reach Bungee — and that is only
 * observable on the request.
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

function quoteBody(routes: unknown[]) {
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
    },
  }
}

const BUILD_BODY = {
  success: true,
  statusCode: 200,
  result: {
    approvalData: {
      spenderAddress: '0x3a23F943181408EAC424116Af7b7790c94Cb97a5',
      amount: '1000000000',
      tokenAddress: USDC_BASE,
      userAddress: SENDER,
    },
    txData: {
      data: '0xfeedface',
      to: '0x3a23F943181408EAC424116Af7b7790c94Cb97a5',
      chainId: BASE,
      value: '0',
    },
    userOp: null,
  },
}

function request() {
  return {
    sender: SENDER,
    sellChainId: BASE,
    sellToken: USDC_BASE,
    sellAmount: 1_000_000_000n,
    buyChainId: GNOSIS,
    buyToken: USDC_GNOSIS,
    destination: destination(),
  }
}

describe('BungeeDropProvider.getQuote', () => {
  /** The whole integration in one assertion set: the drop's destination reaches the bridge. */
  it('asks Bungee to pay the receiver and to run the drop payload', async () => {
    const { doFetch, calls } = fakeFetch({ '/quote': quoteBody([route('q1', '999000000')]), '/build-tx': BUILD_BODY })
    const target = destination()

    await new BungeeDropProvider({ fetch: doFetch }).getQuote(request())

    const quote = calls.find((url) => url.pathname.endsWith('/quote'))
    expect(quote).toBeDefined()
    // Paid to the receiver, not the drop: the receiver is what runs the payload and activates.
    expect(quote?.searchParams.get('receiverAddress')).toBe(target.receiver)
    expect(quote?.searchParams.get('destinationPayload')).toBe(target.payload)
    expect(quote?.searchParams.get('destinationGasLimit')).toBe(String(target.gasLimit))
    // Manual routes only — a plain bridge, with no destination swap of Bungee's own.
    expect(quote?.searchParams.get('enableManual')).toBe('true')
    expect(quote?.searchParams.get('disableSwapping')).toBe('true')
    expect(quote?.searchParams.get('disableAuto')).toBe('true')
  })

  it('maps the route, the approval and the transaction', async () => {
    const { doFetch } = fakeFetch({ '/quote': quoteBody([route('q1', '999000000')]), '/build-tx': BUILD_BODY })

    const quote = await new BungeeDropProvider({ fetch: doFetch }).getQuote(request())

    expect(quote.provider).toBe('bungee')
    expect(quote.route).toEqual({ name: 'Across', estimatedSeconds: 120 })
    expect(quote.input.amount).toBe(1_000_000_000n)
    expect(quote.output.amount).toBe(999_000_000n)
    expect(quote.output.minAmount).toBe(990_000_000n)
    expect(quote.approval).toEqual({
      spender: '0x3a23F943181408EAC424116Af7b7790c94Cb97a5',
      token: USDC_BASE,
      amount: 1_000_000_000n,
    })
    expect(quote.transaction).toEqual({
      to: '0x3a23F943181408EAC424116Af7b7790c94Cb97a5',
      data: '0xfeedface',
      value: 0n,
      chainId: BASE,
    })
    expect(quote.expiresAt).toBe(1_800_000_600)
    expect(quote.destination).toEqual(destination())
  })

  it('takes the route that delivers most, and builds that one', async () => {
    const routes = [route('cheap', '900000000', 'CCTP'), route('best', '999000000'), route('mid', '950000000')]
    const { doFetch, calls } = fakeFetch({ '/quote': quoteBody(routes), '/build-tx': BUILD_BODY })

    const quote = await new BungeeDropProvider({ fetch: doFetch }).getQuote(request())

    expect(quote.output.amount).toBe(999_000_000n)
    const build = calls.find((url) => url.pathname.endsWith('/build-tx'))
    expect(build?.searchParams.get('quoteId')).toBe('best')
  })

  it('reports having no route rather than returning an empty quote', async () => {
    const { doFetch } = fakeFetch({ '/quote': quoteBody([]) })

    await expect(new BungeeDropProvider({ fetch: doFetch }).getQuote(request())).rejects.toMatchObject({
      code: 'no-routes',
    })
  })

  it('says the quote expired when the transaction cannot be built', async () => {
    const { doFetch } = fakeFetch({
      '/quote': quoteBody([route('q1', '999000000')]),
      '/build-tx': { success: false, statusCode: 400, result: null },
    })

    const error = await new BungeeDropProvider({ fetch: doFetch }).getQuote(request()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BridgeError)
    expect((error as BridgeError).code).toBe('build-failed')
  })

  it('does not present an upstream outage as a missing route', async () => {
    const { doFetch } = fakeFetch({}, { status: 503 })

    await expect(new BungeeDropProvider({ fetch: doFetch }).getQuote(request())).rejects.toMatchObject({
      code: 'unreachable',
    })
  })
})

describe('BungeeDropProvider.getDeliverableTokens', () => {
  it('lists what can land in the drop, with the logo field this app uses', async () => {
    const { doFetch, calls } = fakeFetch({
      '/dest-tokens': { success: true, statusCode: 200, result: [token(USDC_GNOSIS, 'USDC', 6, GNOSIS)] },
    })

    const tokens = await new BungeeDropProvider({ fetch: doFetch }).getDeliverableTokens({
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
})
