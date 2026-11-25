import { COW_DROP_APP_DATA_DOCUMENT, getDeployment, swapOnArrival } from '@cowprotocol/cow-drop-sdk'
import { describe, expect, it } from 'vitest'

import { createEventBus, type KeeperEvent } from './events.js'
import { CHAIN_ID, COW, fakeChain, fakeSubmitter, manualClock, OWNER, registered, WXDAI } from './fixtures.js'
import { deriveHints, hookPosted } from './hints.js'
import { createKeeper } from './keeper.js'
import { DEFAULT_POLICY } from './policy.js'
import { registerDrop } from './registry.js'
import { memoryStore } from './store.js'

const BALANCE = 1000n * 10n ** 18n
const deployment = getDeployment(CHAIN_ID, 2)

const recipe = swapOnArrival({
  chainId: CHAIN_ID,
  owner: OWNER,
  sellToken: WXDAI,
  buyToken: COW,
  limitPrice: { numerator: '45', denominator: '1' },
  activation: 'hook',
})

/** An order book that records what it was sent, and can be told how to answer. */
function fakeOrderBook() {
  const uploads: { hash: string; document: string }[] = []
  const orders: Record<string, unknown>[] = []
  let failure: unknown

  return {
    uploads,
    orders,
    fail: (error: unknown) => {
      failure = error
    },
    orderBook: {
      uploadAppData: async (hash: string, document: string) => {
        uploads.push({ hash, document })
        return {} as never
      },
      sendOrder: async (order: unknown) => {
        if (failure) throw failure
        orders.push(order as Record<string, unknown>)
        return 'uid'
      },
    },
  }
}

function harness(dropRecipe = recipe) {
  const drop = registered({ recipe: dropRecipe, generation: 2 })
  const store = memoryStore([drop])
  const chain = fakeChain({ balances: [BALANCE] })
  const submitter = fakeSubmitter(chain.calls)
  const clock = manualClock()
  const book = fakeOrderBook()
  const events: KeeperEvent[] = []
  const bus = createEventBus({ now: clock.now })
  bus.subscribe(undefined, (event) => events.push(event))

  const keeper = createKeeper({
    chain: chain.chain,
    submitter: submitter.submitter,
    store,
    deployment,
    // A policy that would refuse to pay for anything: a hook-posted drop must not need it.
    policy: { ...DEFAULT_POLICY, mode: 'allowlist', allowlist: [] },
    events: bus,
    orderBook: book.orderBook,
    now: clock.now,
  })

  return { keeper, store, chain, clock, book, events, drop }
}

describe('a drop activated by its own order', () => {
  it('is recognised from its recipe, and polled on its sell token', () => {
    expect(hookPosted(recipe)).toBe(true)
    expect(deriveHints(recipe).tokens).toEqual([WXDAI.toLowerCase()])
  })

  it('gets an order posted instead of a transaction sent', async () => {
    const h = harness()

    await h.keeper.tick()

    expect(h.chain.calls).toContain('simulate')
    expect(h.chain.calls).not.toContain('prepare')
    expect(h.chain.calls).not.toContain('broadcast')

    expect(h.book.orders).toHaveLength(1)
    expect(h.book.orders[0]).toMatchObject({
      sellToken: WXDAI,
      buyToken: COW,
      sellAmount: BALANCE.toString(),
      buyAmount: (BALANCE * 45n).toString(),
      signingScheme: 'eip1271',
      from: expect.stringMatching(new RegExp(h.drop.address, 'i')),
    })
  })

  it('uploads the appData carrying the activation before the order', async () => {
    const h = harness()

    await h.keeper.tick()

    const [upload] = h.book.uploads
    expect(upload!.hash).toBe(h.book.orders[0]!.appData)
    expect(JSON.parse(upload!.document).metadata.hooks.pre[0].target).toBe(deployment.executor)
  })

  it('records the order and announces it', async () => {
    const h = harness()

    await h.keeper.tick()

    const stored = await h.store.get(CHAIN_ID, h.drop.address)
    expect(stored!.status).toBe('watching')
    expect(stored!.activations).toHaveLength(1)
    expect(stored!.activations[0]).toMatchObject({ status: 'posted' })
    expect(stored!.activations[0]!.orderUids).toEqual([stored!.activations[0]!.ref])
    expect(h.events.filter((e) => e.type === 'order-posted')).toHaveLength(1)
  })

  it('posts a follow-up order with no hook once the relayer can already pull the balance', async () => {
    const h = harness()
    // The drop has been activated before: deployed, and approved for its sell token.
    h.chain.state.allowance = 2n ** 256n - 1n

    await h.keeper.tick()

    const [upload] = h.book.uploads
    expect(JSON.parse(upload!.document).metadata.hooks).toBeUndefined()
    expect(h.book.orders[0]!.appData).toBe(upload!.hash)
    expect(h.book.orders[0]).toMatchObject({ sellAmount: BALANCE.toString(), signingScheme: 'eip1271' })
  })

  it('keeps the hook on every order of a strict recipe, approved or not', async () => {
    const guarded = swapOnArrival({
      chainId: CHAIN_ID,
      owner: OWNER,
      sellToken: WXDAI,
      buyToken: COW,
      limitPrice: { numerator: '45', denominator: '1' },
      activation: 'hook',
      minAmount: 1n,
    })
    const h = harness(guarded)
    h.chain.state.allowance = 2n ** 256n - 1n

    await h.keeper.tick()

    expect(JSON.parse(h.book.uploads[0]!.document).metadata.hooks.pre).toHaveLength(1)
  })

  it('does not post a second order for the same money while the first can still fill', async () => {
    const h = harness()

    await h.keeper.tick()
    h.clock.advance(10 * 60_000)
    await h.keeper.tick()

    expect(h.book.orders).toHaveLength(1)
  })

  it('posts again once the order has expired unfilled', async () => {
    const h = harness()

    await h.keeper.tick()
    h.clock.advance(31 * 60_000)
    await h.keeper.tick()

    expect(h.book.orders).toHaveLength(2)
    expect(h.book.orders[1]!.validTo).toBeGreaterThan(h.book.orders[0]!.validTo as number)
  })

  it('posts for new money after a fill', async () => {
    const h = harness()

    await h.keeper.tick()
    h.chain.state.balances = [0n]
    await h.keeper.tick()
    h.chain.state.balances = [5n * 10n ** 18n]
    await h.keeper.tick()

    expect(h.book.orders).toHaveLength(2)
    expect(h.book.orders[1]!.sellAmount).toBe((5n * 10n ** 18n).toString())
  })

  it('treats an order somebody else already posted as posted', async () => {
    const h = harness()
    h.book.fail({ body: { errorType: 'DuplicatedOrder' }, response: { status: 400 } })

    await h.keeper.tick()

    expect(h.events.find((e) => e.type === 'order-posted')).toMatchObject({ status: 'duplicate' })
    expect((await h.store.get(CHAIN_ID, h.drop.address))!.activations).toHaveLength(1)
  })

  it('backs off and reports when the order book refuses the order', async () => {
    const h = harness()
    h.book.fail({ body: { errorType: 'InvalidEip1271Signature' }, response: { status: 400 } })

    await h.keeper.tick()

    const stored = await h.store.get(CHAIN_ID, h.drop.address)
    expect(stored!.activations).toHaveLength(0)
    expect(stored!.backoff.failures).toBe(1)
    expect(h.events.find((e) => e.type === 'order-rejected')).toMatchObject({ detail: 'InvalidEip1271Signature (HTTP 400)' })
  })

  it('backs off quietly when the order book cannot answer', async () => {
    const h = harness()
    h.book.fail(new Error('socket hang up'))

    await h.keeper.tick()

    expect((await h.store.get(CHAIN_ID, h.drop.address))!.backoff.failures).toBe(1)
    expect(h.events.filter((e) => e.type === 'order-rejected')).toHaveLength(0)
  })

  it('is registered with the standard appData document the web app sends', async () => {
    const result = await registerDrop({
      recipe,
      appDataDocuments: [COW_DROP_APP_DATA_DOCUMENT],
      store: memoryStore([]),
      deployment,
      maxDrops: 10,
      now: 0,
    })

    expect(result).toMatchObject({ ok: true })
  })

  it('is registered in paying mode without a fee, since it costs the keeper no gas', async () => {
    const result = await registerDrop({
      recipe,
      appDataDocuments: [],
      store: memoryStore([]),
      deployment,
      maxDrops: 10,
      now: 0,
      requireFeeFor: '0x00000000000000000000000000000000000cafe0',
    })

    expect(result.ok).toBe(true)
  })
})
