import type { Address } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { cowOrderPlacedLog, ZERO_APP_DATA } from './fixtures.js'
import { postDiscoveredOrder } from './poster.js'
import type { DiscoveredOrder } from './scanner.js'
import { parseCowOrderPlaced } from '@cowprotocol/cow-drop-sdk'

const DROP: Address = '0x1111111111111111111111111111111111111111'
const CUSTOM_APP_DATA = `0x${'cd'.repeat(32)}` as const

function discovered(appData = ZERO_APP_DATA): DiscoveredOrder {
  const log = cowOrderPlacedLog({ drop: DROP, appData })
  return {
    order: parseCowOrderPlaced(log),
    emitter: DROP,
    owner: DROP,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
  }
}

function fakeOrderBook(sendOrder = vi.fn(async () => 'uid')) {
  return { sendOrder, uploadAppData: vi.fn(async () => ({}) as never) }
}

/** The order book's errors, in the shape `OrderBookApiError` gives them. */
function apiError(status: number, errorType?: string) {
  return Object.assign(new Error(errorType ?? `HTTP ${status}`), {
    response: { status },
    body: errorType ? { errorType } : undefined,
  })
}

describe('postDiscoveredOrder', () => {
  it('posts the order with the scheme and signature the event carried', async () => {
    const orderBook = fakeOrderBook()
    const result = await postDiscoveredOrder(discovered(), { orderBook })

    expect(result.status).toBe('posted')
    expect(orderBook.sendOrder).toHaveBeenCalledWith(
      expect.objectContaining({ signingScheme: 'presign', signature: DROP, from: DROP, kind: 'sell' }),
    )
  })

  it('treats a duplicate as a success, because two posters racing is the expected case', async () => {
    // Activation is permissionless, so anyone may have posted this order already.
    const orderBook = fakeOrderBook(vi.fn(async () => Promise.reject(apiError(400, 'DuplicatedOrder'))))

    expect((await postDiscoveredOrder(discovered(), { orderBook })).status).toBe('duplicate')
  })

  it('reports a 4xx as rejected rather than throwing, so the tower moves past a dead order', async () => {
    const orderBook = fakeOrderBook(vi.fn(async () => Promise.reject(apiError(400, 'InsufficientBalance'))))
    const result = await postDiscoveredOrder(discovered(), { orderBook })

    expect(result.status).toBe('rejected')
    expect(result.error).toBeDefined()
  })

  it('rethrows a 5xx, so the block cursor stays put and the order is retried', async () => {
    const orderBook = fakeOrderBook(vi.fn(async () => Promise.reject(apiError(503))))

    await expect(postDiscoveredOrder(discovered(), { orderBook })).rejects.toThrow()
  })

  it('rethrows a transport failure with no response at all', async () => {
    const orderBook = fakeOrderBook(vi.fn(async () => Promise.reject(new Error('fetch failed'))))

    await expect(postDiscoveredOrder(discovered(), { orderBook })).rejects.toThrow('fetch failed')
  })

  it('uploads the appData document first when one can be resolved', async () => {
    // The chain carries only the hash, and the order book rejects a hash it has never seen.
    const orderBook = fakeOrderBook()
    const document = '{"version":"1.1.0"}'

    await postDiscoveredOrder(discovered(CUSTOM_APP_DATA), {
      orderBook,
      appData: (hash) => (hash === CUSTOM_APP_DATA ? document : undefined),
    })

    expect(orderBook.uploadAppData).toHaveBeenCalledWith(CUSTOM_APP_DATA, document)
    expect(orderBook.sendOrder).toHaveBeenCalledWith(expect.objectContaining({ appData: CUSTOM_APP_DATA }))
  })

  it('posts the hash alone when nothing resolves it', async () => {
    const orderBook = fakeOrderBook()

    await postDiscoveredOrder(discovered(), { orderBook, appData: () => undefined })

    expect(orderBook.uploadAppData).not.toHaveBeenCalled()
    expect(orderBook.sendOrder).toHaveBeenCalled()
  })

  it('sends nothing on a dry run', async () => {
    const orderBook = fakeOrderBook()

    expect((await postDiscoveredOrder(discovered(), { orderBook, dryRun: true })).status).toBe('skipped')
    expect(orderBook.sendOrder).not.toHaveBeenCalled()
  })
})
