import type { Address } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import type { ChainReader, RawLog } from './chain.js'
import { COW_ORDER_TOPIC } from './chain.js'
import { memoryCursor } from './cursor.js'
import { cowOrderPlacedLog, dropTriggeredLog } from './fixtures.js'
import { createWatchTower } from './watchTower.js'

const EXECUTOR: Address = '0xB61071638BE341F8959492838899907FDA1dA817'
const SETTLEMENT: Address = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
const DROP: Address = '0x1111111111111111111111111111111111111111'
const DEPLOYMENT = { executor: EXECUTOR, settlement: SETTLEMENT, chainId: 100 }

function chainAt(head: bigint, logs: RawLog[] = [], activations: RawLog[] = []): ChainReader {
  return {
    getBlockNumber: async () => head,
    getLogs: async (filter) => (filter.topics[0] === COW_ORDER_TOPIC ? logs : activations),
    isPreSigned: async () => true,
  }
}

function tower(overrides: Partial<Parameters<typeof createWatchTower>[0]> = {}) {
  return createWatchTower({
    reader: chainAt(1000n),
    orderBook: { sendOrder: vi.fn(async () => 'uid'), uploadAppData: vi.fn(async () => ({}) as never) },
    deployment: DEPLOYMENT,
    cursor: memoryCursor(),
    fromBlock: 900n,
    ...overrides,
  })
}

describe('createWatchTower', () => {
  it('stays behind the head by the confirmation depth', async () => {
    // A pre-signature a reorg removes takes its order with it, so the tip is not scanned.
    const result = await tower({ reader: chainAt(1000n), confirmations: 5 }).tick()

    expect(result?.toBlock).toBe(995n)
  })

  it('resumes from the block after the cursor', async () => {
    const result = await tower({ cursor: memoryCursor(950n), confirmations: 0 }).tick()

    expect(result?.fromBlock).toBe(951n)
    expect(result?.toBlock).toBe(1000n)
  })

  it('starts at the safe head when the cursor is empty and fromBlock is latest', async () => {
    // The default: a fresh watch tower posts what happens next, not the whole history of the chain.
    const result = await tower({ fromBlock: 'latest', confirmations: 2 }).tick()

    expect(result?.fromBlock).toBe(998n)
  })

  it('splits a long backlog into ranges and says there is more waiting', async () => {
    const first = tower({ fromBlock: 0n, confirmations: 0, maxBlockRange: 100n })
    const result = await first.tick()

    expect(result).toMatchObject({ fromBlock: 0n, toBlock: 99n, moreToScan: true })
  })

  it('advances the cursor so the next tick continues where it stopped', async () => {
    const cursor = memoryCursor()
    const watchTower = tower({ cursor, fromBlock: 0n, confirmations: 0, maxBlockRange: 100n })

    await watchTower.tick()
    expect(await cursor.get()).toBe(99n)
    expect((await watchTower.tick())?.fromBlock).toBe(100n)
  })

  it('does nothing when there is no new block', async () => {
    expect(await tower({ cursor: memoryCursor(1000n), confirmations: 0 }).tick()).toBeUndefined()
  })

  it('posts what it finds and reports the outcome', async () => {
    const sendOrder = vi.fn(async () => 'uid')
    const log = cowOrderPlacedLog({ drop: DROP, blockNumber: 950n })
    const reader = chainAt(1000n, [log], [dropTriggeredLog({ executor: EXECUTOR, drop: DROP })])

    const result = await tower({
      reader,
      orderBook: { sendOrder, uploadAppData: vi.fn(async () => ({}) as never) },
      confirmations: 0,
    }).tick()

    expect(result?.found).toBe(1)
    expect(result?.results[0]?.status).toBe('posted')
    expect(sendOrder).toHaveBeenCalledOnce()
  })

  it('leaves the cursor alone when the order book is unreachable, so nothing is lost', async () => {
    // The failure that must not silently skip orders: a 5xx mid-range.
    const cursor = memoryCursor(940n)
    const log = cowOrderPlacedLog({ drop: DROP, blockNumber: 950n })
    const reader = chainAt(1000n, [log], [dropTriggeredLog({ executor: EXECUTOR, drop: DROP })])
    const sendOrder = vi.fn(async () => Promise.reject(Object.assign(new Error('down'), { response: { status: 503 } })))

    const watchTower = tower({
      reader,
      cursor,
      confirmations: 0,
      orderBook: { sendOrder, uploadAppData: vi.fn(async () => ({}) as never) },
    })

    await expect(watchTower.tick()).rejects.toThrow('down')
    expect(await cursor.get()).toBe(940n)
  })

  it('advances past an order the book rejected on its merits', async () => {
    const cursor = memoryCursor(940n)
    const log = cowOrderPlacedLog({ drop: DROP, blockNumber: 950n })
    const reader = chainAt(1000n, [log], [dropTriggeredLog({ executor: EXECUTOR, drop: DROP })])
    const sendOrder = vi.fn(async () =>
      Promise.reject(Object.assign(new Error('nope'), { response: { status: 400 }, body: { errorType: 'ZeroAmount' } })),
    )

    const result = await tower({
      reader,
      cursor,
      confirmations: 0,
      orderBook: { sendOrder, uploadAppData: vi.fn(async () => ({}) as never) },
    }).tick()

    expect(result?.results[0]?.status).toBe('rejected')
    expect(await cursor.get()).toBe(1000n)
  })

  it('refuses a maxBlockRange that could never make progress', async () => {
    expect(() => tower({ maxBlockRange: 0n })).toThrow(/maxBlockRange/)
  })

  it('survives a tick that throws and keeps running until aborted', async () => {
    const stop = new AbortController()
    const errors: string[] = []
    const reader: ChainReader = {
      getBlockNumber: async () => {
        stop.abort()
        throw new Error('rpc down')
      },
      getLogs: async () => [],
      isPreSigned: async () => true,
    }

    await tower({
      reader,
      pollIntervalMs: 0,
      logger: { info: () => {}, warn: () => {}, error: (message) => errors.push(message) },
    }).run(stop.signal)

    expect(errors[0]).toContain('rpc down')
  })
})
