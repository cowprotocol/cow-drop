import { toOrderBookPayload } from '@cowprotocol/cow-drop-sdk'
import type { OrderBookApi, OrderCreation } from '@cowprotocol/cow-sdk'
import type { Hex } from 'viem'

import type { DiscoveredOrder } from './scanner.js'

/**
 * Resolves an `appData` hash to the document behind it, or `undefined` if it does not have one.
 *
 * The chain only carries the hash — that is all `GPv2Order.Data` holds — so a poster cannot invent
 * the document. See `postDiscoveredOrder` for what happens when it cannot be resolved.
 */
export type AppDataResolver = (appDataHash: Hex) => Promise<string | undefined> | string | undefined

/** What happened to one order. */
export type PostStatus =
  /** Accepted by the order book. */
  | 'posted'
  /** Already there — somebody else posted it first, which is a success. */
  | 'duplicate'
  /** Rejected on its merits. Retrying will not change the answer. */
  | 'rejected'
  /** Not sent, because `dryRun` is on. */
  | 'skipped'

export interface PostResult {
  status: PostStatus
  orderUid: Hex
  discovered: DiscoveredOrder
  /** Set when `status` is `rejected`. */
  error?: unknown
}

export interface PostOptions {
  orderBook: Pick<OrderBookApi, 'sendOrder' | 'uploadAppData'>
  appData?: AppDataResolver
  dryRun?: boolean
}

/**
 * Post one discovered order to the order book.
 *
 * ## `appData`
 *
 * The event carries the hash, because the order struct carries the hash. The order book accepts the
 * hash form for a document it already holds, and rejects it otherwise — so a drop whose recipe used
 * a custom `appData` needs the document uploaded before its order can be posted. Supply an
 * `appData` resolver and this uploads it first; the upload is a `PUT` keyed by the hash, so doing it
 * again is harmless and doing it for an order that would have worked anyway costs one request.
 *
 * Without a resolver the hash goes out as-is. That is correct for the common case — a recipe that
 * did not set `appData` leaves it zero — and the honest failure otherwise, since nothing off-chain
 * can reconstruct a document from its hash.
 *
 * ## Retrying
 *
 * A duplicate is a success: anyone may post an order that is already signed, so two posters racing
 * on the same one is the expected case rather than an error. That is also the whole of the idempotency story — this
 * keeps no record of what it has posted, because the order book already is one.
 */
export async function postDiscoveredOrder(
  discovered: DiscoveredOrder,
  options: PostOptions,
): Promise<PostResult> {
  const { orderBook, appData, dryRun = false } = options
  const orderUid = discovered.order.orderUid

  if (dryRun) return { status: 'skipped', orderUid, discovered }

  const document = await appData?.(discovered.order.appData)
  if (document !== undefined) {
    await orderBook.uploadAppData(discovered.order.appData, document)
  }

  try {
    await orderBook.sendOrder(toOrderBookPayload(discovered.order) as OrderCreation)
    return { status: 'posted', orderUid, discovered }
  } catch (error) {
    if (isDuplicate(error)) return { status: 'duplicate', orderUid, discovered }
    if (isPermanentRejection(error)) return { status: 'rejected', orderUid, discovered, error }
    // Anything else — a network blip, a 5xx, a rate limit — is the order book being unavailable
    // rather than the order being bad. Throwing leaves the block cursor where it was, so the next
    // tick tries again instead of losing the order.
    throw error
  }
}

/** The order book's error body, as much of it as matters here. */
function errorBody(error: unknown): { errorType?: string } | undefined {
  const body = (error as { body?: unknown })?.body
  return typeof body === 'object' && body !== null ? (body as { errorType?: string }) : undefined
}

/** Somebody already posted this order — a success here, not a failure. */
function isDuplicate(error: unknown): boolean {
  return errorBody(error)?.errorType === 'DuplicatedOrder'
}

/**
 * Whether the order book refused the order itself, as opposed to being unable to answer.
 *
 * A 4xx is a verdict on the order — the balance went somewhere else, the deadline passed, the
 * `appData` is unknown — and it will be the same verdict next time. Distinguishing it from a
 * transport failure is what lets the watch tower advance past a dead order without also skipping
 * live ones whenever the API hiccups.
 */
function isPermanentRejection(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status
  return typeof status === 'number' && status >= 400 && status < 500
}
