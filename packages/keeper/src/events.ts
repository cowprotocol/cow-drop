import type { Address, Hex } from 'viem'

import type { DropStatus, PolicyRefusal, RetiredReason } from './types.js'

interface Base {
  /** Monotonic per process. The SSE `id:`, and what `Last-Event-ID` replays from. */
  seq: number
  at: number
  chainId: number
  drop: Address
  owner: Address
}

/**
 * What the keeper tells a subscriber.
 *
 * Two things are deliberately *not* events. A `waiting` simulation emits nothing — "not funded yet"
 * is the normal state of a drop, and at a twelve-second cadence it would be a firehose. And `blocked`
 * fires only when the *reason* changes, for the same reason: it is the UI's cue to say "activate it
 * yourself", not a heartbeat.
 */
export type KeeperEvent = Base &
  (
    | { type: 'registered'; label: string }
    /** Money seen at the address for the first time. Usually the first thing a UI wants to hear. */
    | { type: 'funded'; native: string; tokens: Record<Address, string> }
    /** The simulation passed: the drop is genuinely activatable right now. */
    | { type: 'ready'; gas: string; estimatedCostWei: string }
    | { type: 'blocked'; reason: PolicyRefusal; detail: string; retryAt?: number }
    | { type: 'activation-sent'; hash: Hex; estimatedCostWei: string; replacementOf?: Hex }
    | { type: 'activation-confirmed'; hash: Hex; blockNumber: string; costWei: string }
    | { type: 'activation-failed'; hash?: Hex; stage: 'send' | 'receipt' | 'stuck'; detail: string }
    | { type: 'order-posted'; orderUid: Hex; status: 'posted' | 'duplicate' }
    | { type: 'order-rejected'; orderUid: Hex; detail: string }
    | { type: 'retired'; reason: RetiredReason }
  )

/**
 * `Omit` that survives a union.
 *
 * A plain `Omit<Union, K>` collapses to the members' common keys, which for a discriminated event
 * type means every payload field disappears. Distribution only happens over a naked type parameter,
 * hence the generic.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An event before the bus stamps it with a sequence number and a timestamp. */
export type KeeperEventInput = DistributiveOmit<KeeperEvent, 'seq' | 'at'> & { at?: number }

/** A drop's current state, sent on connect so a late subscriber is never blank. */
export interface DropSnapshot {
  drop: Address
  status: DropStatus
  everFunded: boolean
  lastActivation?: { hash: Hex; status: string; blockNumber?: string }
}

export interface EventBus {
  emit(event: KeeperEventInput): KeeperEvent
  subscribe(drops: Address[] | undefined, sink: (event: KeeperEvent) => void): () => void
  /**
   * Events after `seq`, or `undefined` when `seq` has fallen out of the ring and the caller must
   * refetch state instead of assuming it has missed nothing.
   */
  since(seq: number): KeeperEvent[] | undefined
  head(): number
}

/**
 * The fan-out between the tick loop and whoever is listening.
 *
 * Keeps a bounded ring of recent events so an `EventSource` reconnecting with `Last-Event-ID` can be
 * caught up rather than left with a silent gap. Bounded because this is a notification channel, not a
 * log: past the ring the honest answer is "resync", which the HTTP layer turns into a `gap` event.
 */
export function createEventBus(options: { now?: () => number; ringSize?: number } = {}): EventBus {
  const now = options.now ?? Date.now
  const ringSize = options.ringSize ?? 1024

  const subscribers = new Set<{ drops: Set<string> | undefined; sink: (event: KeeperEvent) => void }>()
  let ring: KeeperEvent[] = []
  let seq = 0

  return {
    emit(input) {
      const event = { ...input, seq: ++seq, at: input.at ?? now() } as KeeperEvent

      ring.push(event)
      if (ring.length > ringSize) ring = ring.slice(-ringSize)

      for (const subscriber of subscribers) {
        if (subscriber.drops && !subscriber.drops.has(event.drop.toLowerCase())) continue
        try {
          subscriber.sink(event)
        } catch {
          // A broken subscriber — a socket that went away mid-write — must not stop the others, and
          // must certainly not propagate into the tick loop that emitted this.
        }
      }

      return event
    },

    subscribe(drops, sink) {
      const entry = {
        drops: drops ? new Set(drops.map((drop) => drop.toLowerCase())) : undefined,
        sink,
      }
      subscribers.add(entry)
      return () => subscribers.delete(entry)
    },

    since(from) {
      const oldest = ring[0]
      if (!oldest) return from === seq ? [] : undefined
      // `from` predates the ring: we genuinely cannot say what was missed.
      if (from < oldest.seq - 1) return undefined
      return ring.filter((event) => event.seq > from)
    },

    head: () => seq,
  }
}
