import { getDeployment, PAYMENT_STEPS_ABI, type DropRecipeJson, type EvmCall } from '@cowprotocol/cow-drop-sdk'
import { decodeFunctionData, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import { createEventBus, type KeeperEvent } from './events.js'
import { COW, fakeChain, fakeSubmitter, manualClock, OWNER, registered, WXDAI } from './fixtures.js'
import { deriveHints } from './hints.js'
import { createKeeper } from './keeper.js'
import { DEFAULT_POLICY } from './policy.js'
import type { PaymentQuoter } from './revenue.js'
import { memoryStore } from './store.js'

const PRICE = 100n * 10n ** 18n
const USDC: Address = '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83'
const wxdai = WXDAI.toLowerCase() as Address
const cow = COW.toLowerCase() as Address

function paymentRecipe(): DropRecipeJson {
  return {
    version: 1,
    generation: 2,
    label: 'invoice',
    chainId: 100,
    owner: OWNER,
    steps: [{ type: 'payment', buyToken: COW, buyAmount: String(PRICE), validitySeconds: 1800 }],
  }
}

/** A quoter that says buying `PRICE` COW costs `cost` of any token, plus a fee of 1. */
function fixedQuoter(cost: bigint | undefined) {
  const asked: Address[] = []
  const quoter: PaymentQuoter = {
    quoteBuy: async ({ sellToken }) => {
      asked.push(sellToken)
      return cost === undefined ? undefined : { sellAmount: cost, feeAmount: 1n }
    },
    // Unused by these tests: a payment drop asks what a price costs, never what a balance fetches.
    quoteSell: async () => undefined,
  }
  return { quoter, asked }
}

function harness(setup: { balances: bigint[]; transfers?: { token: Address; block: bigint }[]; cost?: bigint }) {
  const recipe = paymentRecipe()
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
  const quote = fixedQuoter('cost' in setup ? setup.cost : 50n * 10n ** 18n)

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
  })

  const sellTokenOf = (call: EvmCall) =>
    (decodeFunctionData({ abi: PAYMENT_STEPS_ABI, data: call.data }).args[2] as Address).toLowerCase()

  return { keeper, store, chain, clock, events, drop, quote, prepared, sellTokenOf }
}

describe('payment drops', () => {
  it('are not blind, and poll nothing until a transfer names a token', () => {
    const hints = deriveHints(paymentRecipe())
    expect(hints.blind).toBe(false)
    expect(hints.tokens).toEqual([])
    expect(hints.payment).toEqual({ buyToken: cow, buyAmount: String(PRICE) })
  })

  it('discover the token from Transfer logs and announce it once', async () => {
    const h = harness({ balances: [0n], transfers: [{ token: wxdai, block: 19_990n }] })

    await h.keeper.tick()
    await h.keeper.tick()

    const stored = await h.store.get(100, h.drop.address)
    expect(stored?.payment?.tokens).toEqual([wxdai])
    expect(stored?.payment?.scannedTo).toBe('20000')
    expect(h.events.filter((e) => e.type === 'payment-detected')).toHaveLength(1)
  })

  it('scan from the lookback first, then only from the cursor', async () => {
    const h = harness({ balances: [0n] })

    await h.keeper.tick()
    h.chain.state.head = 20_010n
    await h.keeper.tick()

    expect(h.chain.state.transferScans).toEqual([
      { fromBlock: 10_000n, toBlock: 14_999n },
      { fromBlock: 15_000n, toBlock: 19_999n },
      { fromBlock: 20_000n, toBlock: 20_000n },
      { fromBlock: 20_001n, toBlock: 20_010n },
    ])
  })

  it('activate through activatePayment with the token that arrived, when it covers the price', async () => {
    const h = harness({ balances: [60n * 10n ** 18n], transfers: [{ token: wxdai, block: 19_990n }] })

    await h.keeper.tick()

    expect(h.quote.asked).toEqual([wxdai])
    expect(h.prepared).toHaveLength(1)
    expect(h.prepared[0]!.to).toBe(getDeployment(100, 2).paymentSteps)
    expect(h.sellTokenOf(h.prepared[0]!)).toBe(wxdai)
    const stored = await h.store.get(100, h.drop.address)
    expect(stored?.pending?.sellToken).toBe(wxdai)
    expect(stored?.pending?.sellBalance).toBe(String(60n * 10n ** 18n))
  })

  it('refuse an underpayment, say so once, and send nothing', async () => {
    // The quote needs 50e18 + 1; exactly 50e18 arrived.
    const h = harness({ balances: [50n * 10n ** 18n], transfers: [{ token: wxdai, block: 19_990n }] })

    await h.keeper.tick()
    h.clock.advance(10 * 60_000)
    await h.keeper.tick()

    expect(h.prepared).toHaveLength(0)
    expect(h.chain.calls).not.toContain('simulate')
    const underpaid = h.events.filter((e) => e.type === 'payment-underpaid')
    expect(underpaid).toHaveLength(1)
    expect(underpaid[0]).toMatchObject({ token: wxdai, required: String(50n * 10n ** 18n + 1n) })
  })

  it('never activate in a token the order book will not quote', async () => {
    const h = harness({ balances: [10n ** 30n], transfers: [{ token: USDC, block: 19_990n }], cost: undefined })

    await h.keeper.tick()

    expect(h.prepared).toHaveLength(0)
    const underpaid = h.events.find((e) => e.type === 'payment-underpaid')
    expect(underpaid).toMatchObject({ token: USDC })
    expect(underpaid && 'required' in underpaid ? underpaid.required : undefined).toBeUndefined()
  })

  it('forward a payment in the buy token itself without quoting', async () => {
    const h = harness({ balances: [PRICE], transfers: [{ token: cow, block: 19_990n }] })

    await h.keeper.tick()

    expect(h.quote.asked).toEqual([])
    expect(h.sellTokenOf(h.prepared[0]!)).toBe(cow)
  })

  it('do not sell the same payment twice while its order may still fill', async () => {
    const h = harness({ balances: [60n * 10n ** 18n], transfers: [{ token: wxdai, block: 19_990n }] })

    await h.keeper.tick()
    h.chain.state.receipt = { status: 'success', blockNumber: 20_001n, costWei: 1n }
    await h.keeper.tick()

    const stored = await h.store.get(100, h.drop.address)
    expect(stored?.status).toBe('watching')
    expect(stored?.payment?.committed[wxdai]?.balance).toBe(String(60n * 10n ** 18n))

    // Past the resimulate interval, same balance, order still live: no second activation.
    h.clock.advance(10 * 60_000)
    await h.keeper.tick()
    expect(h.prepared).toHaveLength(1)

    // The order's window has passed with the balance untouched: it expired, so pay again.
    h.clock.advance(30 * 60_000)
    await h.keeper.tick()
    expect(h.prepared).toHaveLength(2)
  })
})
