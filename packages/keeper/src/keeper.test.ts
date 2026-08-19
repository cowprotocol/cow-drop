import { compileRecipe } from '@cowprotocol/cow-drop-sdk'
import { describe, expect, it } from 'vitest'

import { createEventBus, type KeeperEvent } from './events.js'
import {
  CHAIN_ID,
  COW,
  deployment,
  fakeChain,
  fakeSubmitter,
  manualClock,
  recipeJson,
  registered,
  twapRecipeJson,
  WXDAI,
} from './fixtures.js'
import { createKeeper, type KeeperOptions } from './keeper.js'
import { DEFAULT_POLICY } from './policy.js'
import { memoryStore, utcDay } from './store.js'
import type { RegisteredDrop, SubsidyPolicy } from './types.js'

const FUNDED = [1000n * 10n ** 18n]

function harness(setup: {
  drop?: RegisteredDrop
  chain?: ReturnType<typeof fakeChain>
  policy?: Partial<SubsidyPolicy>
  options?: Partial<KeeperOptions>
  balance?: bigint
} = {}) {
  const drop = setup.drop ?? registered()
  const store = memoryStore([drop])
  const chain = setup.chain ?? fakeChain({ balances: FUNDED })
  const submitter = fakeSubmitter(chain.calls, setup.balance)
  const clock = manualClock()
  const events: KeeperEvent[] = []
  const bus = createEventBus({ now: clock.now })
  bus.subscribe(undefined, (event) => events.push(event))

  const keeper = createKeeper({
    chain: chain.chain,
    submitter: submitter.submitter,
    store,
    deployment: deployment(),
    policy: { ...DEFAULT_POLICY, ...setup.policy },
    events: bus,
    now: clock.now,
    ...setup.options,
  })

  return { keeper, store, chain, submitter, clock, events, drop, types: (t: string) => events.map((e) => e.type).filter((x) => x === t) }
}

describe('createKeeper', () => {
  it('does not simulate a drop with no money at it', async () => {
    // The cost guard: an eth_call per empty drop per tick would be the bulk of the RPC bill.
    const h = harness({ chain: fakeChain({ balances: [0n] }) })

    await h.keeper.tick()

    expect(h.chain.calls).not.toContain('simulate')
  })

  it('announces the first money to arrive, once', async () => {
    const h = harness()

    await h.keeper.tick()
    await h.keeper.tick()

    expect(h.events.filter((e) => e.type === 'funded')).toHaveLength(1)
  })

  it('does not re-simulate while the balances have not moved', async () => {
    // A drop waiting on a time window is funded and not ready; without the digest check it would
    // cost an eth_call every tick, forever.
    const chain = fakeChain({ balances: FUNDED, simulate: { ok: false, message: 'not yet' } })
    const h = harness({ chain })

    await h.keeper.tick()
    await h.keeper.tick()

    expect(chain.calls.filter((c) => c === 'simulate')).toHaveLength(1)
  })

  it('re-simulates once a balance moves', async () => {
    const chain = fakeChain({ balances: FUNDED, simulate: { ok: false, message: 'not yet' } })
    const h = harness({ chain })

    await h.keeper.tick()
    chain.state.balances = [2000n * 10n ** 18n]
    await h.keeper.tick()

    expect(chain.calls.filter((c) => c === 'simulate')).toHaveLength(2)
  })

  it('re-simulates after the interval even with nothing moving', async () => {
    const chain = fakeChain({ balances: FUNDED, simulate: { ok: false, message: 'not yet' } })
    const h = harness({ chain, options: { resimulateIntervalMs: 60_000 } })

    await h.keeper.tick()
    h.clock.advance(61_000)
    await h.keeper.tick()

    expect(chain.calls.filter((c) => c === 'simulate')).toHaveLength(2)
  })

  it('probes a blind recipe on a timer, with no balance to go on', async () => {
    // An all-raw recipe: nothing to poll, and the simulation was always the real gate anyway.
    const blind = registered({
      recipe: recipeJson({ steps: [{ type: 'raw', target: '0x00000000000000000000000000000000000a11ce', callData: '0x12' }] }),
    })
    const chain = fakeChain({ balances: [0n], simulate: { ok: false, message: 'not yet' } })
    const h = harness({ drop: blind, chain, options: { blindProbeIntervalMs: 60_000 } })

    await h.keeper.tick()
    expect(chain.calls.filter((c) => c === 'simulate')).toHaveLength(1)

    await h.keeper.tick()
    expect(chain.calls.filter((c) => c === 'simulate')).toHaveLength(1)

    h.clock.advance(61_000)
    await h.keeper.tick()
    expect(chain.calls.filter((c) => c === 'simulate')).toHaveLength(2)
  })

  it('writes the pending record before it broadcasts', async () => {
    // The crash-safety invariant. Signing yields the hash before any bytes leave, so the store can
    // record it first — and a crash in between can never mean a transaction nobody knows about.
    const h = harness()

    await h.keeper.tick()

    const prepare = h.chain.calls.indexOf('prepare')
    const broadcast = h.chain.calls.indexOf('broadcast')
    expect(prepare).toBeGreaterThanOrEqual(0)
    expect(broadcast).toBeGreaterThan(prepare)

    const spend = await h.store.spendOn(utcDay(h.clock.now()))
    expect(spend.totalWei).toBeGreaterThan(0n)
  })

  it('sends nothing when the policy refuses, and says so once', async () => {
    const h = harness({ policy: { dailyBudgetWei: 0n } })

    await h.keeper.tick()
    await h.keeper.tick()

    expect(h.submitter.broadcasts).toBe(0)
    expect(h.events.filter((e) => e.type === 'blocked')).toHaveLength(1)
  })

  it('refunds the budget and stays watching when the broadcast fails', async () => {
    const h = harness()
    h.submitter.failBroadcast(new Error('node unreachable'))

    await h.keeper.tick()

    const stored = await h.store.get(CHAIN_ID, h.drop.address)
    expect(stored?.status).toBe('watching')
    expect(stored?.pending).toBeUndefined()
    expect((await h.store.spendOn(utcDay(h.clock.now()))).totalWei).toBe(0n)
    expect(h.events.some((e) => e.type === 'activation-failed')).toBe(true)
  })

  it('settles the budget at what the receipt actually cost, not the reservation', async () => {
    const chain = fakeChain({ balances: FUNDED })
    const h = harness({ chain })

    await h.keeper.tick()
    const reserved = (await h.store.spendOn(utcDay(h.clock.now()))).totalWei

    chain.state.receipt = { status: 'success', blockNumber: 1001n, costWei: 1234n }
    await h.keeper.tick()

    expect(reserved).not.toBe(1234n)
    expect((await h.store.spendOn(utcDay(h.clock.now()))).totalWei).toBe(1234n)
  })

  it('retires a one-shot drop once its activation confirms', async () => {
    const chain = fakeChain({ balances: FUNDED })
    const h = harness({ chain })

    await h.keeper.tick()
    chain.state.receipt = { status: 'success', blockNumber: 1001n, costWei: 1n }
    await h.keeper.tick()

    const stored = await h.store.get(CHAIN_ID, h.drop.address)
    expect(stored?.status).toBe('retired')
    expect(stored?.retiredReason).toBe('once-consumed')
    // Retired, not deleted: the recipe is still the only way to recover the address.
    expect(stored?.recipe).toBeDefined()
  })

  it('keeps watching a reusable drop after it activates', async () => {
    // Running again on the next arrival is the entire point of a reusable deposit address. This used to
    // land in `activated`, which the tick loop never looks at — so a refund could never wake it.
    const reusable = registered({ recipe: recipeJson({ once: false }) })
    const chain = fakeChain({ balances: FUNDED })
    const h = harness({ drop: reusable, chain })

    await h.keeper.tick()
    chain.state.receipt = { status: 'success', blockNumber: 1001n, costWei: 1n }
    await h.keeper.tick()

    expect((await h.store.get(CHAIN_ID, reusable.address))?.status).toBe('watching')
  })

  it('does not activate a reusable drop again on the balance its last order is selling', async () => {
    // The money does not leave at activation: the pre-signature is on chain but the order settles
    // later, so the balance the order was sized against is still sitting there. Activating again on it
    // signs a second order that the first one's fill makes unfillable, bought with the keeper's gas.
    const reusable = registered({ recipe: recipeJson({ once: false }) })
    const chain = fakeChain({ balances: FUNDED })
    const h = harness({ drop: reusable, chain })

    await h.keeper.tick()
    chain.state.receipt = { status: 'success', blockNumber: 1001n, costWei: 1n }
    await h.keeper.tick()
    await h.keeper.tick()

    expect(h.submitter.broadcasts).toBe(1)
    expect((await h.store.get(CHAIN_ID, reusable.address))?.committedDigest).toBeDefined()
  })

  it('activates a reusable drop again as soon as the balance moves', async () => {
    const reusable = registered({ recipe: recipeJson({ once: false }) })
    const chain = fakeChain({ balances: FUNDED })
    const h = harness({ drop: reusable, chain })

    await h.keeper.tick()
    chain.state.receipt = { status: 'success', blockNumber: 1001n, costWei: 1n }
    await h.keeper.tick()

    chain.state.balances = [2000n * 10n ** 18n]
    await h.keeper.tick()

    expect(h.submitter.broadcasts).toBe(2)
  })

  it('releases the commitment when the fill empties the drop', async () => {
    // Why the commitment is a latch rather than a comparison: the fill is what frees the money, so the
    // balance reaching zero has to release it. Otherwise a refund of exactly the last order's size would
    // read as the balance already committed, and the drop would never fire again.
    //
    // Landing back on a balance this drop has already been simulated against still waits out
    // `resimulateIntervalMs` — `shouldSimulate` compares digests by value, not by sequence. A refund of
    // any other size activates at once, as the test above shows.
    const reusable = registered({ recipe: recipeJson({ once: false }) })
    const chain = fakeChain({ balances: FUNDED })
    const h = harness({ drop: reusable, chain })

    await h.keeper.tick()
    chain.state.receipt = { status: 'success', blockNumber: 1001n, costWei: 1n }
    await h.keeper.tick()

    chain.state.balances = [0n]
    await h.keeper.tick()
    expect((await h.store.get(CHAIN_ID, reusable.address))?.committedDigest).toBeUndefined()

    chain.state.balances = FUNDED
    h.clock.advance(6 * 60_000)
    await h.keeper.tick()

    expect(h.submitter.broadcasts).toBe(2)
  })

  it('activates a reusable drop again once its order can no longer fill', async () => {
    // The other half of the gate. An order that expires unfilled leaves the balance untouched, so
    // nothing moves and the latch never opens — without a deadline the drop would be stuck for good.
    const reusable = registered({ recipe: recipeJson({ once: false }) })
    const chain = fakeChain({ balances: FUNDED })
    const h = harness({ drop: reusable, chain })

    await h.keeper.tick()
    chain.state.receipt = { status: 'success', blockNumber: 1001n, costWei: 1n }
    await h.keeper.tick()

    // Past the 1800s the recipe commits to, on the same untouched balance.
    h.clock.advance(1801 * 1000)
    await h.keeper.tick()

    expect(h.submitter.broadcasts).toBe(2)
  })

  it('reads the deadline from the posted order uid rather than the recipe', async () => {
    // `validTo` is the last four bytes of the uid, and the uid is what the watch tower actually posted —
    // so a drop whose order is already dead is released without waiting out the recipe's window.
    const reusable = registered({ recipe: recipeJson({ once: false }) })
    const chain = fakeChain({ balances: FUNDED })
    const h = harness({ drop: reusable, chain })

    await h.keeper.tick()
    chain.state.receipt = { status: 'success', blockNumber: 1001n, costWei: 1n }
    await h.keeper.tick()

    // What `forwardOrderResults` writes when the watch tower posts: a uid whose validTo has passed.
    const expired = Math.floor(h.clock.now() / 1000) - 1
    await h.store.update(CHAIN_ID, reusable.address, (current) => ({
      ...current,
      activations: current.activations.map((activation) => ({
        ...activation,
        orderUids: [`0x${'11'.repeat(52)}${expired.toString(16).padStart(8, '0')}` as `0x${string}`],
      })),
    }))

    // Enough for the re-simulation timer, but well inside the recipe's 1800s window.
    h.clock.advance(6 * 60_000)
    await h.keeper.tick()

    expect(h.submitter.broadcasts).toBe(2)
  })

  it('reads a validity the recipe carried as a string', async () => {
    // Recipe numbers are `number | string` — it is JSON a client wrote. Reading `"1800"` as no validity
    // at all would fall back to the default window and release the commitment at the wrong moment.
    const reusable = registered({
      recipe: recipeJson({
        once: false,
        steps: [
          {
            type: 'presignSellAll',
            sellToken: WXDAI,
            buyToken: COW,
            limitPrice: { price: '45', sellDecimals: 18, buyDecimals: 18 },
            validitySeconds: '3600',
          },
        ],
      }),
    })
    const chain = fakeChain({ balances: FUNDED })
    const h = harness({ drop: reusable, chain })

    await h.keeper.tick()
    chain.state.receipt = { status: 'success', blockNumber: 1001n, costWei: 1n }
    await h.keeper.tick()

    // Past the 30-minute default, inside the hour the recipe actually committed to.
    h.clock.advance(31 * 60_000)
    await h.keeper.tick()

    expect(h.submitter.broadcasts).toBe(1)
  })

  it('parks a drop whose activation registered a conditional order', async () => {
    // A TWAP is self-driving and its balance falls as the parts fill, so no balance-watching gate can
    // hold it. Activating again would register a second schedule over what the first has left.
    const twap = registered({ recipe: twapRecipeJson() })
    const chain = fakeChain({ balances: FUNDED })
    const h = harness({ drop: twap, chain })

    await h.keeper.tick()
    chain.state.receipt = { status: 'success', blockNumber: 1001n, costWei: 1n }
    await h.keeper.tick()

    chain.state.balances = [750n * 10n ** 18n]
    h.clock.advance(6 * 60_000)
    await h.keeper.tick()

    expect((await h.store.get(CHAIN_ID, twap.address))?.status).toBe('activated')
    expect(h.submitter.broadcasts).toBe(1)
  })

  it('charges the gas but does not retire when the activation reverts on chain', async () => {
    // Somebody else got there first, or an oracle rolled between simulation and inclusion.
    const chain = fakeChain({ balances: FUNDED })
    const h = harness({ chain })

    await h.keeper.tick()
    chain.state.receipt = { status: 'reverted', blockNumber: 1001n, costWei: 999n }
    await h.keeper.tick()

    const stored = await h.store.get(CHAIN_ID, h.drop.address)
    expect(stored?.status).toBe('watching')
    expect((await h.store.spendOn(utcDay(h.clock.now()))).totalWei).toBe(999n)
  })

  it('retires on a terminal revert and never on an unrecognised one', async () => {
    const consumed = fakeChain({
      balances: FUNDED,
      simulate: { ok: false, revertData: '0x2f2ecb6a', message: 'reverted' },
    })
    // 0x2f2ecb6a is not a selector this build knows; unknown must never retire a live drop.
    const h = harness({ chain: consumed })

    await h.keeper.tick()

    expect((await h.store.get(CHAIN_ID, h.drop.address))?.status).toBe('watching')
  })

  it('retires a drop whose committed deadline has passed', async () => {
    const clock = manualClock()
    const expired = registered({
      recipe: recipeJson({
        steps: [
          { type: 'requireTimeWindow', notAfter: Math.floor(clock.now() / 1000) - 10 },
          {
            type: 'presignSellAll',
            sellToken: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
            buyToken: '0x177127622c4A00F3d409B75571e12cB3c8973d3c',
            limitPrice: { price: '45', sellDecimals: 18, buyDecimals: 18 },
            validitySeconds: 1800,
          },
        ],
      }),
    })
    const h = harness({ drop: expired })

    await h.keeper.tick()

    expect((await h.store.get(CHAIN_ID, expired.address))?.retiredReason).toBe('expired')
  })

  it('writes no balances at all when the read fails', async () => {
    // Recording an unread balance as zero looks exactly like the money leaving.
    const h = harness()
    h.chain.chain.getBalances = async () => {
      throw new Error('rpc down')
    }

    await expect(h.keeper.tick()).rejects.toThrow('rpc down')
    expect((await h.store.get(CHAIN_ID, h.drop.address))?.lastPoll).toBeUndefined()
  })

  it('survives a failing tick and keeps running until aborted', async () => {
    const h = harness()
    const stop = new AbortController()
    h.chain.chain.getBalances = async () => {
      stop.abort()
      throw new Error('rpc down')
    }

    await expect(h.keeper.run(stop.signal)).resolves.toBeUndefined()
  })

  it('reports the oldest in-flight block, so the watch tower can be rewound to it', async () => {
    // Without the rewind, a restart between broadcast and scan skips the block the activation landed
    // in and its orders are never posted.
    const h = harness()
    await h.keeper.tick()

    expect(await h.keeper.oldestPendingBlock()).toBe(1000n)
  })

  it('reconciles an activation it finds already pending after a restart', async () => {
    const chain = fakeChain({
      balances: FUNDED,
      receipt: { status: 'success', blockNumber: 1001n, costWei: 500n },
    })
    const pending = registered({
      status: 'activating',
      pending: {
        ref: `0x${'cd'.repeat(32)}`,
        nonce: 0,
        gasLimit: '300000',
        maxFeePerGas: '1000000000',
        reservedWei: '1000',
        sentAt: 0,
        sentAtBlock: '999',
        replacements: 0,
      },
    })
    const h = harness({ drop: pending, chain })

    await h.keeper.tick()

    expect(h.submitter.broadcasts).toBe(0)
    expect((await h.store.get(CHAIN_ID, pending.address))?.status).toBe('retired')
  })

  it('does not send twice when two ticks overlap', async () => {
    const h = harness()

    await Promise.all([h.keeper.tick(), h.keeper.tick()])

    expect(h.submitter.broadcasts).toBe(1)
  })

  it('prepares but never broadcasts on a dry run', async () => {
    const h = harness({ options: { dryRun: true } })

    await h.keeper.tick()

    expect(h.submitter.broadcasts).toBe(0)
    expect((await h.store.get(CHAIN_ID, h.drop.address))?.status).toBe('watching')
  })

  it('leaves the drop address it was given alone', async () => {
    const h = harness()
    await h.keeper.tick()
    expect((await h.store.get(CHAIN_ID, h.drop.address))?.address).toBe(compileRecipe(recipeJson()).address.toLowerCase())
  })
})

describe('paying mode', () => {
  const KEEPER = '0x00000000000000000000000000000000000cafe0' as const
  const paying = { mode: 'paying' as const, minFeeBps: 5, minRevenueRatio: 1.5 }

  /** A drop that promises the keeper 10 bps of the WXDAI it sells. */
  function withFee(volumeBps = 10) {
    return registered({
      fee: { volumeBps, recipient: KEEPER, appData: `0x${'ab'.repeat(32)}`, sellToken: WXDAI.toLowerCase() as never },
    })
  }

  function prices(nativePrice: number | undefined) {
    return { nativePrice: async () => nativePrice }
  }

  it('activates a drop whose fee comfortably covers the gas', async () => {
    const h = harness({
      drop: withFee(),
      policy: paying,
      options: { prices: prices(1e9) },
    })

    await h.keeper.tick()

    expect(h.submitter.broadcasts).toBe(1)
  })

  it('refuses a drop that promises nothing, where "all" would have paid', async () => {
    // The hole this mode closes.
    const h = harness({ policy: paying, options: { prices: prices(1e9) } })

    await h.keeper.tick()

    expect(h.submitter.broadcasts).toBe(0)
    expect(h.events.find((e) => e.type === 'blocked')).toMatchObject({ reason: 'no-fee' })
  })

  it('refuses a fee that does not cover the gas', async () => {
    // A real promise, worth less than it costs to collect: 10 bps of 1000 units of a token worth
    // 1e-6 wei each is ~1e9 wei, against ~3.75e14 wei of gas.
    const h = harness({ drop: withFee(), policy: paying, options: { prices: prices(1e-6) } })

    await h.keeper.tick()

    expect(h.submitter.broadcasts).toBe(0)
    expect(h.events.find((e) => e.type === 'blocked')).toMatchObject({ reason: 'revenue-below-gas' })
  })

  it('refuses a token the order book will not price, rather than assuming it is worthless', async () => {
    const h = harness({ drop: withFee(), policy: paying, options: { prices: prices(undefined) } })

    await h.keeper.tick()

    expect(h.events.find((e) => e.type === 'blocked')).toMatchObject({ reason: 'unpriceable' })
  })

  it('prices the fee against the balance that actually arrived', async () => {
    // Ten times the money means ten times the fee, which is what makes the gate scale.
    const small = harness({
      drop: withFee(),
      policy: paying,
      chain: fakeChain({ balances: [10n ** 18n] }),
      options: { prices: prices(1e-6) },
    })
    await small.keeper.tick()
    expect(small.submitter.broadcasts).toBe(0)

    // A million times the money, same price, same fee rate — and now it pays for itself.
    const large = harness({
      drop: withFee(),
      policy: paying,
      chain: fakeChain({ balances: [10n ** 24n] }),
      options: { prices: prices(1e-6) },
    })
    await large.keeper.tick()
    expect(large.submitter.broadcasts).toBe(1)
  })
})
