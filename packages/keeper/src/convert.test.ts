import {
  CONVERT_STEPS_ABI,
  convertMinimum,
  getDeployment,
  type DropRecipeJson,
  type EvmCall,
} from '@cowprotocol/cow-drop-sdk'
import { decodeFunctionData, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import { createEventBus, type KeeperEvent } from './events.js'
import { COW, fakeChain, fakeSubmitter, manualClock, OWNER, registered, WXDAI } from './fixtures.js'
import { deriveHints } from './hints.js'
import { createKeeper } from './keeper.js'
import { DEFAULT_POLICY } from './policy.js'
import { registerDrop } from './registry.js'
import type { PaymentQuoter } from './revenue.js'
import { memoryStore } from './store.js'

const USDC: Address = '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83'
const wxdai = WXDAI.toLowerCase() as Address
const cow = COW.toLowerCase() as Address
const ZERO: Address = '0x0000000000000000000000000000000000000000'

/** What the market pays for the balance in these tests. */
const MARKET = 50n * 10n ** 18n

function convertRecipe(pricer: Address = ZERO): DropRecipeJson {
  return {
    version: 1,
    generation: 2,
    label: 'convert on arrival',
    chainId: 100,
    owner: OWNER,
    once: false,
    steps: [{ type: 'convert', buyToken: COW, pricer, validitySeconds: 1800 }],
  }
}

/** A quoter that says any balance fetches `buyAmount` of the buy token. */
function fixedQuoter(buyAmount: bigint | undefined) {
  const asked: { sellToken: Address; sellAmount: bigint }[] = []
  const quoter: PaymentQuoter = {
    quoteBuy: async () => undefined,
    quoteSell: async ({ sellToken, sellAmount }) => {
      asked.push({ sellToken, sellAmount })
      return buyAmount === undefined ? undefined : { buyAmount, feeAmount: 1n }
    },
  }
  return { quoter, asked }
}

function harness(setup: {
  balances: bigint[]
  transfers?: { token: Address; block: bigint }[]
  market?: bigint
  pricer?: Address
  haircutBps?: number
}) {
  const recipe = convertRecipe(setup.pricer ?? ZERO)
  const drop = registered({ recipe, generation: 2 })
  const store = memoryStore([drop])
  const chain = fakeChain({
    balances: setup.balances,
    head: 20_000n,
    transfers: (setup.transfers ?? []).map((t) => ({ token: t.token, to: drop.address, blockNumber: t.block })),
  })
  const submitter = fakeSubmitter(chain.calls)
  const clock = manualClock()
  const events: KeeperEvent[] = []
  const bus = createEventBus({ now: clock.now })
  bus.subscribe(undefined, (event) => events.push(event))
  const quote = fixedQuoter('market' in setup ? setup.market : MARKET)

  const prepared: EvmCall[] = []
  const prepare = submitter.submitter.prepare
  submitter.submitter.prepare = async (params) => {
    prepared.push(params.call)
    return prepare(params)
  }

  const keeper = createKeeper({
    chain: chain.chain,
    submitter: submitter.submitter,
    store,
    deployment: getDeployment(100, 2),
    policy: DEFAULT_POLICY,
    events: bus,
    now: clock.now,
    quoter: quote.quoter,
    ...(setup.haircutBps === undefined ? {} : { convertHaircutBps: setup.haircutBps }),
  })

  const argsOf = (call: EvmCall) => decodeFunctionData({ abi: CONVERT_STEPS_ABI, data: call.data }).args
  const sellTokenOf = (call: EvmCall) => (argsOf(call)[2] as Address).toLowerCase()
  const minBuyOf = (call: EvmCall) => argsOf(call)[3] as bigint

  return { keeper, store, chain, clock, events, drop, quote, prepared, sellTokenOf, minBuyOf }
}

describe('convert drops', () => {
  it('are not blind, and poll nothing until a transfer names a token', () => {
    const hints = deriveHints(convertRecipe())
    expect(hints.blind).toBe(false)
    expect(hints.tokens).toEqual([])
    expect(hints.convert).toEqual({ buyToken: cow, pricer: ZERO })
  })

  it('discover the token from Transfer logs, exactly as a payment drop does', async () => {
    const h = harness({ balances: [0n], transfers: [{ token: wxdai, block: 19_990n }] })

    await h.keeper.tick()

    const stored = await h.store.get(100, h.drop.address)
    expect(stored?.payment?.tokens).toEqual([wxdai])
  })

  // --- the price -----------------------------------------------------------------------------

  it('quote the balance and activate at the market less the haircut', async () => {
    const balance = 60n * 10n ** 18n
    const h = harness({ balances: [balance], transfers: [{ token: wxdai, block: 19_990n }] })

    await h.keeper.tick()

    // Quoted for the balance itself, not a reference amount: that balance is the order's sell amount.
    expect(h.quote.asked).toEqual([{ sellToken: wxdai, sellAmount: balance }])
    expect(h.prepared).toHaveLength(1)
    expect(h.prepared[0]!.to).toBe(getDeployment(100, 2).convertSteps)
    expect(h.sellTokenOf(h.prepared[0]!)).toBe(wxdai)
    expect(h.minBuyOf(h.prepared[0]!)).toBe(convertMinimum(MARKET, 100))
  })

  it('honour an operator haircut, and agree with the SDK on what it means', async () => {
    const h = harness({
      balances: [60n * 10n ** 18n],
      transfers: [{ token: wxdai, block: 19_990n }],
      haircutBps: 250,
    })

    await h.keeper.tick()

    expect(h.minBuyOf(h.prepared[0]!)).toBe(convertMinimum(MARKET, 250))
    // Below the market, and by exactly the haircut asked for.
    expect(h.minBuyOf(h.prepared[0]!)).toBe((MARKET * 9_750n) / 10_000n)
  })

  it('never activate at no price when the order book will not quote the token', async () => {
    const h = harness({
      balances: [10n ** 30n],
      transfers: [{ token: USDC, block: 19_990n }],
      market: undefined,
    })

    await h.keeper.tick()

    // The whole point: no quote means no number to commit, so nothing is sent at all.
    expect(h.prepared).toHaveLength(0)
    expect(h.chain.calls).not.toContain('simulate')
  })

  it('refuse a quote so small the haircut rounds it away', async () => {
    const h = harness({
      balances: [10n ** 18n],
      transfers: [{ token: wxdai, block: 19_990n }],
      market: 0n,
    })

    await h.keeper.tick()

    expect(h.prepared).toHaveLength(0)
  })

  it('forward a balance already in the buy token without quoting', async () => {
    const balance = 7n * 10n ** 18n
    const h = harness({ balances: [balance], transfers: [{ token: cow, block: 19_990n }] })

    await h.keeper.tick()

    expect(h.quote.asked).toEqual([])
    expect(h.sellTokenOf(h.prepared[0]!)).toBe(cow)
    expect(h.minBuyOf(h.prepared[0]!)).toBe(balance)
  })

  it('do not sell the same arrival twice while its order may still fill', async () => {
    const balance = 60n * 10n ** 18n
    const h = harness({ balances: [balance], transfers: [{ token: wxdai, block: 19_990n }] })

    await h.keeper.tick()
    h.chain.state.receipt = { status: 'success', blockNumber: 20_001n, costWei: 1n }
    await h.keeper.tick()

    const stored = await h.store.get(100, h.drop.address)
    expect(stored?.status).toBe('watching')
    expect(stored?.payment?.committed[wxdai]?.balance).toBe(String(balance))

    h.clock.advance(10 * 60_000)
    await h.keeper.tick()
    expect(h.prepared).toHaveLength(1)

    // The order's window has passed with the balance untouched: it expired, so convert again.
    h.clock.advance(30 * 60_000)
    await h.keeper.tick()
    expect(h.prepared).toHaveLength(2)
  })

  it('re-quote rather than reuse the first price when converting again', async () => {
    const balance = 60n * 10n ** 18n
    const h = harness({ balances: [balance], transfers: [{ token: wxdai, block: 19_990n }] })

    await h.keeper.tick()
    h.chain.state.receipt = { status: 'success', blockNumber: 20_001n, costWei: 1n }
    await h.keeper.tick()
    h.clock.advance(40 * 60_000)
    await h.keeper.tick()

    expect(h.prepared).toHaveLength(2)
    // Two activations, two quotes: the second price is the market then, not the market before.
    expect(h.quote.asked).toHaveLength(2)
  })
})

describe('the pricer gate', () => {
  const deployment = getDeployment(100, 2)
  const keeperAddress: Address = '0x1111111111111111111111111111111111111111'

  async function register(recipe: DropRecipeJson, keeper?: Address) {
    return registerDrop({
      recipe,
      store: memoryStore([]),
      deployment,
      maxDrops: 10,
      now: 1_000,
      ...(keeper ? { keeper } : {}),
    })
  }

  it('accepts a drop that names this keeper as its pricer', async () => {
    const result = await register(convertRecipe(keeperAddress), keeperAddress)
    expect(result.ok).toBe(true)
  })

  it('accepts an open drop, which anyone may price', async () => {
    const result = await register(convertRecipe(ZERO), keeperAddress)
    expect(result.ok).toBe(true)
  })

  it('refuses a drop priced by somebody else, rather than watching it forever', async () => {
    const other: Address = '0x2222222222222222222222222222222222222222'
    const result = await register(convertRecipe(other), keeperAddress)

    expect(result).toMatchObject({ ok: false, error: 'cannot-price', pricer: other, keeper: keeperAddress })
  })

  it('skips the check when the keeper cannot name itself', async () => {
    const other: Address = '0x2222222222222222222222222222222222222222'
    const result = await register(convertRecipe(other))
    expect(result.ok).toBe(true)
  })
})
