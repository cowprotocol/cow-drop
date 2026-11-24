import type { PostResult } from '@cowprotocol/cow-drop-watch-tower'
import type { OrderBookApi } from '@cowprotocol/cow-sdk'
import type { Address, Hex } from 'viem'

import type { EventBus } from './events.js'
import type { KeeperStore } from './store.js'

/**
 * Turn the watch tower's results into keeper events.
 *
 * The keeper never posts an order. It activates; the watch tower — running in the same process —
 * finds the `OrderPlacement` logs the activation emitted and posts them on its own schedule, with the
 * retry and cursor semantics it already has. One implementation of order posting, not two.
 *
 * The cost is latency: `order-posted` lands `confirmations` blocks plus one watch-tower poll after the
 * receipt, not immediately. That is the right trade, and the UI copy should say so rather than imply
 * the order appears the instant the drop activates.
 *
 * Results for drops nobody registered are dropped on the floor — the watch tower posts for the whole
 * chain, and only registered drops have anyone listening.
 */
export function forwardOrderResults(options: { store: KeeperStore; events: EventBus; chainId: number }) {
  const { store, events, chainId } = options

  return async (result: PostResult): Promise<void> => {
    // `discovered.owner` is the drop: for a pre-signed order the event names the owner in `sender`,
    // and a step running under delegatecall signs and emits as the drop itself.
    const drop = result.discovered.owner.toLowerCase() as Address
    const registered = await store.get(chainId, drop)
    if (!registered) return

    const orderUid = result.orderUid as Hex

    // Attach the uid to the activation that produced it, so a page loading later can see what the
    // drop actually did without replaying an event stream it was never connected to.
    await store.update(chainId, drop, (current) => {
      const last = current.activations.at(-1)
      if (!last || last.status !== 'confirmed') return undefined
      const activations = [...current.activations]
      activations[activations.length - 1] = { ...last, orderUids: [...(last.orderUids ?? []), orderUid] }
      return { ...current, activations }
    })

    if (result.status === 'rejected') {
      events.emit({
        type: 'order-rejected',
        chainId,
        drop,
        owner: registered.owner,
        orderUid,
        detail: describe(result.error),
      })
      return
    }

    if (result.status === 'skipped') return

    events.emit({
      type: 'order-posted',
      chainId,
      drop,
      owner: registered.owner,
      orderUid,
      // A duplicate is a success: anyone may post an order that is already signed, so two posters
      // racing is expected rather than an error.
      status: result.status === 'duplicate' ? 'duplicate' : 'posted',
    })
  }
}

/** The slice of the order book a hook-posted drop needs: its appData document, then its order. */
export type OrderPoster = Pick<OrderBookApi, 'sendOrder' | 'uploadAppData'>

/**
 * How the order book answered an order the keeper posted itself.
 *
 * The same three-way split the watch tower makes: a duplicate is a success, a 4xx is a verdict on the
 * order, and anything else is the order book failing to answer.
 */
export function classifyPostError(error: unknown): 'duplicate' | 'rejected' | 'unavailable' {
  const body = (error as { body?: { errorType?: string } })?.body
  if (body?.errorType === 'DuplicatedOrder') return 'duplicate'
  const status = (error as { response?: { status?: number } })?.response?.status
  return typeof status === 'number' && status >= 400 && status < 500 ? 'rejected' : 'unavailable'
}

/** The most useful line out of an error: the order book's `errorType` when there is one. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  const body = (error as { body?: { errorType?: string } })?.body
  return body?.errorType ?? String(error)
}
