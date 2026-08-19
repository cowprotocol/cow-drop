import type { DropDeployment } from '@cowprotocol/cow-drop-sdk'
import type { OrderBookApi } from '@cowprotocol/cow-sdk'

import type { ChainReader } from './chain.js'
import { memoryCursor, type Cursor } from './cursor.js'
import { postDiscoveredOrder, type AppDataResolver, type PostResult } from './poster.js'
import { scanForOrders, type SkippedLog } from './scanner.js'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Logs nothing. The default, so the library is silent unless a caller asks otherwise. */
export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

export interface WatchTowerOptions {
  reader: ChainReader
  orderBook: Pick<OrderBookApi, 'sendOrder' | 'uploadAppData'>
  deployment: Pick<DropDeployment, 'executor' | 'settlement' | 'chainId'>
  /** Where to resume from. Defaults to an in-memory cursor, i.e. from `fromBlock` every start. */
  cursor?: Cursor
  /**
   * The first block to scan when the cursor is empty. `'latest'` starts at the current head and
   * ignores history. Defaults to `'latest'`.
   */
  fromBlock?: bigint | 'latest'
  /**
   * How far behind the head to stay, in blocks. Default 2.
   *
   * A pre-signature that a reorg removes takes its order with it, and an order posted from a block
   * that no longer exists sits in the book unfillable. Cheap to avoid: an order that has waited two
   * blocks is not in a hurry.
   */
  confirmations?: number
  /** Largest range per `getLogs`. Default 10 000, which most public RPCs accept. */
  maxBlockRange?: bigint
  /** Delay between ticks in `run`. Default 15 000ms. */
  pollIntervalMs?: number
  /**
   * Accept only orders placed by a cow-drop activation. Default `false` — `CowOrderPlaced` is a
   * protocol-wide announcement, so by default this posts any pre-signed order anyone announces.
   */
  onlyDrops?: boolean
  appData?: AppDataResolver
  /** Find and verify orders, report them, post nothing. */
  dryRun?: boolean
  logger?: Logger
  onResult?: (result: PostResult) => void
  onSkip?: (skipped: SkippedLog) => void
}

export interface TickResult {
  fromBlock: bigint
  toBlock: bigint
  found: number
  results: PostResult[]
  /** True when the tick stopped short of the safe head and another one has work waiting. */
  moreToScan: boolean
}

export interface WatchTower {
  /** Scan and post one range. Returns `undefined` when there is nothing new to scan. */
  tick(): Promise<TickResult | undefined>
  /** Tick forever, sleeping between passes. Resolves when `signal` aborts. */
  run(signal?: AbortSignal): Promise<void>
}

/**
 * The watch tower: index `CowOrderPlaced`, post what it finds to the order book.
 *
 * ## What it is for
 *
 * A *conditional* order is self-driving — it goes into ComposableCoW, whose watch tower polls it and
 * posts each part. A *discrete* order is not: the pre-signature is on-chain the moment it is placed,
 * but nothing has told the order book that the order exists, so no solver ever sees it.
 *
 * Not limited to cow-drop. Any contract that pre-signs an order and emits `CowOrderPlaced` — by
 * copying the declaration or by calling `CowOrderPoster` — is picked up here. Set `onlyDrops` to
 * narrow it back to cow-drop's own orders.
 *
 * ## Ordering and failure
 *
 * The cursor advances only after every order in a range has been dealt with, and `postDiscoveredOrder`
 * throws rather than returning for anything that is not a verdict on the order itself. So an order
 * book outage leaves the cursor where it was and the next tick re-scans the same range; a rejected
 * order is reported and passed over, because re-posting it would fail identically forever.
 */
export function createWatchTower(options: WatchTowerOptions): WatchTower {
  const {
    reader,
    orderBook,
    deployment,
    cursor = memoryCursor(),
    fromBlock = 'latest',
    confirmations = 2,
    maxBlockRange = 10_000n,
    pollIntervalMs = 15_000,
    onlyDrops = false,
    appData,
    dryRun = false,
    logger = silentLogger,
    onResult,
    onSkip,
  } = options

  if (maxBlockRange < 1n) throw new Error('maxBlockRange must be at least 1')
  if (confirmations < 0) throw new Error('confirmations cannot be negative')

  async function tick(): Promise<TickResult | undefined> {
    const head = await reader.getBlockNumber()
    const safeHead = head - BigInt(confirmations)
    if (safeHead < 0n) return undefined

    const last = await cursor.get()
    const start = last === undefined ? (fromBlock === 'latest' ? safeHead : fromBlock) : last + 1n
    if (start > safeHead) return undefined

    const end = start + maxBlockRange - 1n < safeHead ? start + maxBlockRange - 1n : safeHead

    const found = await scanForOrders({
      reader,
      deployment,
      fromBlock: start,
      toBlock: end,
      onlyDrops,
      onSkip: (skipped) => {
        logger.warn(`skipped a CowOrderPlaced from ${skipped.log.address}: ${skipped.reason}`)
        onSkip?.(skipped)
      },
    })

    const results: PostResult[] = []
    // Sequential on purpose. The order book is rate-limited to a handful of requests a second, and
    // a burst of parallel posts is the one way a busy block turns into a throttled one.
    for (const discovered of found) {
      const result = await postDiscoveredOrder(discovered, { orderBook, appData, dryRun })
      results.push(result)
      onResult?.(result)

      const line = `${result.orderUid} owned by ${discovered.owner}`
      if (result.status === 'rejected') logger.error(`order book rejected ${line}: ${describe(result.error)}`)
      else logger.info(`${result.status} ${line}`)
    }

    await cursor.set(end)
    if (found.length > 0) logger.info(`blocks ${start}-${end}: ${found.length} order(s)`)

    return { fromBlock: start, toBlock: end, found: found.length, results, moreToScan: end < safeHead }
  }

  async function run(signal?: AbortSignal): Promise<void> {
    logger.info(`watching chain ${deployment.chainId}${dryRun ? ' (dry run)' : ''}`)

    while (!signal?.aborted) {
      let caughtUp = true
      try {
        const result = await tick()
        caughtUp = !result?.moreToScan
      } catch (error) {
        // Kept alive on purpose: an RPC or order-book outage should cost a tick, not the process. The
        // cursor did not advance, so the next pass re-scans the same range.
        logger.error(`tick failed, retrying: ${describe(error)}`)
      }

      // Only sleep once the chain has been caught up to; a backlog is drained at full speed.
      if (caughtUp) await sleep(pollIntervalMs, signal)
    }
  }

  return { tick, run }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // Already aborted means the `abort` event has fired and will not fire again — without this the
  // loop would sit out a whole poll interval before noticing it had been asked to stop.
  if (signal?.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })

    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
  })
}
