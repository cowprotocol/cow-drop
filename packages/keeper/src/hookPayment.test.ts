import { getDeployment, paymentRequest, PAYMENT_STEPS_ABI } from '@cowprotocol/cow-drop-sdk'
import { decodeFunctionData, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import { createEventBus, type KeeperEvent } from './events.js'
import { COW, fakeChain, fakeSubmitter, manualClock, OWNER, registered, WXDAI } from './fixtures.js'
import { deriveHints, hookPosted } from './hints.js'
import { createKeeper } from './keeper.js'
import { DEFAULT_POLICY } from './policy.js'
import type { PaymentQuoter } from './revenue.js'
import { memoryStore } from './store.js'

const PRICE = 100n * 10n ** 18n
const PAID = 60n * 10n ** 18n
const wxdai = WXDAI.toLowerCase() as Address
const cow = COW.toLowerCase() as Address
const deployment = getDeployment(100, 2)

const recipe = paymentRequest({ chainId: 100, owner: OWNER, buyToken: COW, buyAmount: PRICE, activation: 'hook' })

/** Buying `PRICE` COW costs 50e18 of any token, plus a fee of 1. */
const quoter: PaymentQuoter = {
  quoteBuy: async () => ({ sellAmount: 50n * 10n ** 18n, feeAmount: 1n }),
  quoteSell: async () => undefined,
}

function harness(setup: { balances: bigint[]; token: Address }) {
  const drop = registered({ recipe, generation: 2 })
  const store = memoryStore([drop])
  const chain = fakeChain({
    balances: setup.balances,
    head: 20_000n,
    transfers: [{ token: setup.token, to: drop.address, blockNumber: 19_990n }],
  })
  const submitter = fakeSubmitter(chain.calls)
  const clock = manualClock()
  const events: KeeperEvent[] = []
  const bus = createEventBus({ now: clock.now })
  bus.subscribe(undefined, (event) => events.push(event))

  const orders: Record<string, unknown>[] = []
  const documents: string[] = []

  const keeper = createKeeper({
    chain: chain.chain,
    submitter: submitter.submitter,
    store,
    deployment,
    policy: DEFAULT_POLICY,
    events: bus,
    now: clock.now,
    quoter,
    orderBook: {
      uploadAppData: async (_hash: string, document: string) => {
        documents.push(document)
        return {} as never
      },
      sendOrder: async (order: unknown) => {
        orders.push(order as Record<string, unknown>)
        return 'uid'
      },
    },
  })

  return { keeper, store, chain, clock, events, drop, orders, documents }
}

describe('a payment drop activated by its own order', () => {
  it('is read as a payment that is posted, naming no token to poll', () => {
    expect(hookPosted(recipe)).toBe(true)
    expect(deriveHints(recipe).payment).toEqual({ buyToken: cow, buyAmount: String(PRICE) })
    expect(deriveHints(recipe).tokens).toEqual([])
  })

  it('gets an order in the token that arrived, with a hook naming that token', async () => {
    const h = harness({ balances: [PAID], token: wxdai })

    await h.keeper.tick()

    expect(h.chain.calls).not.toContain('broadcast')
    expect(h.orders).toHaveLength(1)
    expect(h.orders[0]).toMatchObject({
      sellToken: wxdai,
      buyToken: COW,
      sellAmount: PAID.toString(),
      buyAmount: PRICE.toString(),
      signingScheme: 'eip1271',
    })

    const [hook] = JSON.parse(h.documents[0]!).metadata.hooks.pre
    expect(hook.target).toBe(deployment.paymentSteps)
    const { args } = decodeFunctionData({ abi: PAYMENT_STEPS_ABI, data: hook.callData })
    expect((args![2] as Address).toLowerCase()).toBe(wxdai)
  })

  it('latches that token until its order expires, and no longer', async () => {
    const h = harness({ balances: [PAID], token: wxdai })

    await h.keeper.tick()
    h.clock.advance(10 * 60_000)
    await h.keeper.tick()
    expect(h.orders).toHaveLength(1)

    const stored = await h.store.get(100, h.drop.address)
    expect(stored!.payment!.committed[wxdai]!.balance).toBe(String(PAID))

    h.clock.advance(25 * 60_000)
    await h.keeper.tick()
    expect(h.orders).toHaveLength(2)
  })

  it('posts nothing for an underpayment', async () => {
    const h = harness({ balances: [50n * 10n ** 18n], token: wxdai })

    await h.keeper.tick()

    expect(h.orders).toHaveLength(0)
    expect(h.events.filter((e) => e.type === 'payment-underpaid')).toHaveLength(1)
  })

  it('forwards a payment made in the buy token with a transaction, since no order can carry it', async () => {
    const h = harness({ balances: [PRICE], token: cow })

    await h.keeper.tick()

    expect(h.orders).toHaveLength(0)
    expect(h.chain.calls).toContain('broadcast')
  })
})
