import { parseCowOrderPlaced } from '@cowprotocol/cow-drop-sdk'
import type { Address, Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import type { ChainReader, RawLog } from './chain.js'
import { COW_ORDER_TOPIC } from './chain.js'
import { cowOrderPlacedLog, dropTriggeredLog } from './fixtures.js'
import { scanForOrders, type SkippedLog } from './scanner.js'

const EXECUTOR: Address = '0xB61071638BE341F8959492838899907FDA1dA817'
const SETTLEMENT: Address = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
const DROP: Address = '0x1111111111111111111111111111111111111111'
const IMPOSTOR: Address = '0x9999999999999999999999999999999999999999'
const POSTER: Address = '0x5a2117173284E78CBB160F1cEE3CFC998CbD286B'
const DEPLOYMENT = { executor: EXECUTOR, settlement: SETTLEMENT }

/**
 * A chain that returns exactly the logs it is given, split by which filter asked for them, and
 * answers `preSignature` from a set of uids.
 */
function fakeChain(options: { logs?: RawLog[]; activations?: RawLog[]; signed?: Hex[] } = {}): ChainReader {
  const signed = new Set((options.signed ?? []).map((uid) => uid.toLowerCase()))
  return {
    getBlockNumber: async () => 1000n,
    getLogs: async (filter) =>
      filter.topics[0] === COW_ORDER_TOPIC ? (options.logs ?? []) : (options.activations ?? []),
    isPreSigned: async (_settlement, uid) => signed.has(uid.toLowerCase()),
  }
}

/** The uid of the order a log carries. Decoded rather than sliced, so the layout is not restated. */
function uidOf(log: RawLog): Hex {
  return parseCowOrderPlaced(log).orderUid
}

/** The happy path: one order and the activation that produced it. */
function wellFormed(overrides: Parameters<typeof cowOrderPlacedLog>[0] = { drop: DROP }) {
  const log = cowOrderPlacedLog(overrides)
  return { log, activation: dropTriggeredLog({ executor: EXECUTOR, drop: overrides.drop }) }
}

async function scan(reader: ChainReader, onSkip?: (skipped: SkippedLog) => void) {
  return scanForOrders({ reader, deployment: DEPLOYMENT, fromBlock: 1n, toBlock: 100n, onSkip })
}

describe('scanForOrders', () => {
  it('finds a well-formed order and reports where it came from', async () => {
    const { log, activation } = wellFormed({ drop: DROP })
    const order = (await scanForOrders({
      reader: fakeChain({ logs: [log], activations: [activation] }),
      deployment: DEPLOYMENT,
      fromBlock: 1n,
      toBlock: 100n,
      requireOnChainSignature: false,
    }))[0]

    expect(order).toBeDefined()
    expect(order!.emitter).toBe(DROP)
    expect(order!.order.signingScheme).toBe('presign')
    expect(order!.order.owner).toBe(DROP)
    expect(order!.blockNumber).toBe(100n)
    expect(order!.transactionHash).toBe(log.transactionHash)
  })

  it('asks for the order logs with no address filter, because drops are counterfactual', async () => {
    const getLogs = vi.fn<ChainReader['getLogs']>(async () => [])
    await scan({ getBlockNumber: async () => 1000n, getLogs, isPreSigned: async () => true })

    const filter = getLogs.mock.calls[0]?.[0]
    expect(filter?.topics).toEqual([COW_ORDER_TOPIC])
    // The whole design hinges on this: there is no set of drop addresses to narrow the query with.
    expect(filter?.address).toBeUndefined()
  })

  it('accepts an order announced by something other than its owner', async () => {
    // CowOrderPoster.announce: a contract that cannot delegatecall signs its own order and has the
    // poster emit for it. The signature is the owner's either way, so the order is postable.
    const log = cowOrderPlacedLog({ drop: POSTER, uidOwner: DROP })

    const found = await scan(fakeChain({ logs: [log], signed: [uidOf(log)] }))

    expect(found).toHaveLength(1)
    expect(found[0]!.emitter).toBe(POSTER)
    expect(found[0]!.owner).toBe(DROP)
  })

  it('accepts an order from a contract that is not a drop at all', async () => {
    // The event is protocol-wide, so a plain integrator's order counts. `onlyDrops` narrows it.
    const { log } = wellFormed({ drop: IMPOSTOR })
    const found = await scan(fakeChain({ logs: [log], activations: [], signed: [uidOf(log)] }))

    expect(found).toHaveLength(1)
  })

  it('drops a fabricated order the settlement contract never signed', async () => {
    // The only check that proves anything, and the one a forged log cannot get past.
    const { log } = wellFormed({ drop: IMPOSTOR })
    const skips: SkippedLog[] = []

    expect(await scan(fakeChain({ logs: [log], signed: [] }), (s) => skips.push(s))).toEqual([])
    expect(skips[0]?.reason).toBe('not-signed')
  })

  it('under onlyDrops, refuses an order with no activation from DropExecutor', async () => {
    const { log } = wellFormed({ drop: IMPOSTOR })
    const skips: SkippedLog[] = []

    const found = await scanForOrders({
      reader: fakeChain({ logs: [log], activations: [], signed: [uidOf(log)] }),
      deployment: DEPLOYMENT,
      fromBlock: 1n,
      toBlock: 100n,
      onlyDrops: true,
      onSkip: (skipped) => skips.push(skipped),
    })

    expect(found).toEqual([])
    expect(skips[0]?.reason).toBe('not-a-drop')
  })

  it('under onlyDrops, refuses an order whose activation names a different drop', async () => {
    const { log } = wellFormed({ drop: DROP })
    const skips: SkippedLog[] = []

    const found = await scanForOrders({
      reader: fakeChain({
        logs: [log],
        activations: [dropTriggeredLog({ executor: EXECUTOR, drop: IMPOSTOR })],
        signed: [uidOf(log)],
      }),
      deployment: DEPLOYMENT,
      fromBlock: 1n,
      toBlock: 100n,
      onlyDrops: true,
      onSkip: (skipped) => skips.push(skipped),
    })

    expect(found).toEqual([])
    expect(skips[0]?.reason).toBe('not-a-drop')
  })

  it('under onlyDrops, keeps an order whose activation matches', async () => {
    const { log, activation } = wellFormed({ drop: DROP })

    const found = await scanForOrders({
      reader: fakeChain({ logs: [log], activations: [activation], signed: [uidOf(log)] }),
      deployment: DEPLOYMENT,
      fromBlock: 1n,
      toBlock: 100n,
      onlyDrops: true,
    })

    expect(found).toHaveLength(1)
  })

  it('drops a pre-signed order the settlement contract has no signature for', async () => {
    // What a reorg looks like from here: the log is in our range, the signature is not on chain.
    const { log, activation } = wellFormed({ drop: DROP })
    const skips: SkippedLog[] = []

    expect(await scan(fakeChain({ logs: [log], activations: [activation], signed: [] }), (s) => skips.push(s))).toEqual(
      [],
    )
    expect(skips[0]?.reason).toBe('not-signed')
  })

  it('keeps a pre-signed order the settlement contract does know about', async () => {
    const { log, activation } = wellFormed({ drop: DROP })
    const reader = fakeChain({ logs: [log], activations: [activation] })
    const signed = vi.fn(async () => true)

    const found = await scan({ ...reader, isPreSigned: signed })

    expect(found).toHaveLength(1)
    expect(signed).toHaveBeenCalledWith(SETTLEMENT, found[0]!.order.orderUid)
  })

  it('does not look for a pre-signature for an order that is not pre-signed', async () => {
    // An ERC-1271 order carries its own signature; there is nothing on-chain to read.
    const log = cowOrderPlacedLog({ drop: DROP, signingScheme: 2 })
    const isPreSigned = vi.fn(async () => false)
    const activations = [dropTriggeredLog({ executor: EXECUTOR, drop: DROP })]

    const found = await scan({ ...fakeChain({ logs: [log], activations }), isPreSigned })

    expect(found).toHaveLength(1)
    expect(isPreSigned).not.toHaveBeenCalled()
  })

  it('drops a log that carries the topic but does not decode', async () => {
    const skips: SkippedLog[] = []
    const log: RawLog = { ...cowOrderPlacedLog({ drop: DROP }), data: '0xdeadbeef' }

    expect(await scan(fakeChain({ logs: [log] }), (s) => skips.push(s))).toEqual([])
    expect(skips[0]?.reason).toBe('undecodable')
  })

  it('does not call the chain at all for an empty or backwards range', async () => {
    const getLogs = vi.fn(async () => [])
    const reader = { getBlockNumber: async () => 1000n, getLogs, isPreSigned: async () => true }

    expect(await scanForOrders({ reader, deployment: DEPLOYMENT, fromBlock: 50n, toBlock: 10n })).toEqual([])
    expect(getLogs).not.toHaveBeenCalled()
  })

  it('skips the activation lookup entirely when there are no order logs', async () => {
    const getLogs = vi.fn(async () => [])
    await scan({ getBlockNumber: async () => 1000n, getLogs, isPreSigned: async () => true })

    expect(getLogs).toHaveBeenCalledTimes(1)
  })
})
