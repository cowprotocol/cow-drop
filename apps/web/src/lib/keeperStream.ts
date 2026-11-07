import { OrderBookApi, type SupportedChainId } from '@cowprotocol/cow-sdk'
import type { Address } from 'viem'
import { useEffect, useRef } from 'react'

import { addActivity, listActivity, updateActivity, type ActivityEntry } from './activity.js'
import { blockExplorer, cowExplorer, DEFAULT_CHAIN_ID } from './chain.js'
import { keeperUrl } from './keeper.js'
import { configuredKeeperBaseUrl } from './runtimeConfig.js'
import { listDrops } from './storage.js'

/** Keeper events worth a toast and a history line. `ready` and `registered` are left out as noise. */
const EVENT_TYPES = [
  'funded',
  'payment-detected',
  'payment-underpaid',
  'activation-sent',
  'activation-confirmed',
  'activation-failed',
  'order-posted',
  'order-rejected',
  'blocked',
  'retired',
] as const

/** The fields of a keeper event this page reads. See `packages/keeper/src/events.ts`. */
interface KeeperEvent {
  type: string
  at: number
  chainId: number
  drop: Address
  owner: Address
  hash?: string
  orderUid?: string
  token?: Address
  balance?: string
  required?: string
  stage?: string
  detail?: string
  reason?: string
  costWei?: string
}

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`

/**
 * One keeper event as a history line, or null for events this page does not show.
 *
 * The title says what happened and nothing else — which drop it happened to is `label` and `drop`,
 * so the list can show it as a chip and filter on it rather than parsing it back out of a sentence.
 */
export function describeEvent(event: KeeperEvent, label: string): ActivityEntry | null {
  const explorer = blockExplorer(event.chainId)
  const cow = cowExplorer(event.chainId)
  const txLink = event.hash ? [{ label: 'Transaction', url: `${explorer.url}/tx/${event.hash}` }] : []
  const orderLink = event.orderUid ? [{ label: 'Order', url: `${cow}/orders/${event.orderUid}` }] : []
  const base = {
    id: [event.chainId, event.drop, event.type, event.at, event.hash ?? event.orderUid ?? event.token ?? ''].join(':'),
    at: event.at,
    chainId: event.chainId,
    drop: event.drop,
    label,
    type: event.type,
    links: [] as ActivityEntry['links'],
  }

  switch (event.type) {
    case 'funded':
      return { ...base, title: 'Funded', tone: 'info' }
    case 'payment-detected':
      return { ...base, title: 'Payment received', detail: event.token && `in ${short(event.token)}`, tone: 'info' }
    case 'payment-underpaid':
      return {
        ...base,
        title: 'Payment is short',
        detail: event.required ? `holds ${event.balance}, needs ${event.required}` : 'the token cannot be priced',
        tone: 'warn',
      }
    case 'activation-sent':
      return { ...base, title: 'Activation sent', tone: 'info', links: txLink }
    case 'activation-confirmed':
      return { ...base, title: 'Activated', tone: 'ok', links: txLink }
    case 'activation-failed':
      return { ...base, title: 'Activation failed', detail: event.detail, tone: 'error', links: txLink }
    case 'order-posted':
      return { ...base, title: 'Order posted', tone: 'ok', links: orderLink, orderUid: event.orderUid, settled: false }
    case 'order-rejected':
      return { ...base, title: 'Order rejected', detail: event.detail, tone: 'error', links: orderLink }
    case 'blocked':
      return { ...base, title: "Keeper won't pay to activate it", detail: event.detail, tone: 'warn' }
    case 'retired':
      return { ...base, title: 'No longer watched', detail: event.reason, tone: 'info' }
    default:
      return null
  }
}

/** Which chains to follow an owner on: the keeper's own list when a base URL is set, else the default. */
async function ownerChains(): Promise<number[]> {
  const base = configuredKeeperBaseUrl()
  if (!base) return keeperUrl(DEFAULT_CHAIN_ID) ? [DEFAULT_CHAIN_ID] : []
  try {
    const response = await fetch(`${base.replace(/\/+$/, '')}/v1/networks`)
    const body = (await response.json()) as { networks?: { chainId: number }[] }
    return (body.networks ?? []).map((network) => network.chainId)
  } catch {
    return []
  }
}

/**
 * Follow the keeper for this browser's drops and the connected wallet's, one stream per chain.
 *
 * Every new event lands in the activity history; `onNew` is called for those not seen before, which is
 * what raises a toast. Re-subscribes when the account or the saved drops change (`revision`).
 */
export function useKeeperActivity(params: {
  account: Address | null
  revision: number
  onNew: (entry: ActivityEntry) => void
}): void {
  const { account, revision } = params
  const onNew = useRef(params.onNew)
  onNew.current = params.onNew

  useEffect(() => {
    let cancelled = false
    const sources: EventSource[] = []

    void (async () => {
      const saved = listDrops().filter((drop) => drop.keeper)
      const labels = new Map(saved.map((drop) => [`${drop.chainId}:${drop.address.toLowerCase()}`, drop.label]))

      const byChain = new Map<number, { drops: Set<string>; owner: boolean }>()
      const entry = (chainId: number) => {
        const existing = byChain.get(chainId) ?? { drops: new Set<string>(), owner: false }
        byChain.set(chainId, existing)
        return existing
      }
      for (const drop of saved) entry(drop.chainId).drops.add(drop.address.toLowerCase())
      if (account) for (const chainId of await ownerChains()) entry(chainId).owner = true
      if (cancelled) return

      for (const [chainId, wanted] of byChain) {
        const url = keeperUrl(chainId)
        if (!url) continue
        const query = new URLSearchParams()
        for (const drop of wanted.drops) query.append('drop', drop)
        if (wanted.owner && account) query.append('owner', account)
        if ([...query.keys()].length === 0) continue

        const source = new EventSource(`${url}/v1/events?${query.toString()}`)
        for (const type of EVENT_TYPES) {
          source.addEventListener(type, (message) => {
            const event = JSON.parse((message as MessageEvent<string>).data) as KeeperEvent
            // Empty, not a stand-in: a drop this browser has no name for is named by its address at render
            // time, in one place, rather than having a fake name frozen into the record.
            const label = labels.get(`${chainId}:${event.drop.toLowerCase()}`) ?? ''
            const described = describeEvent(event, label)
            if (described && addActivity(described)) onNew.current(described)
          })
        }
        sources.push(source)
      }
    })()

    return () => {
      cancelled = true
      for (const source of sources) source.close()
    }
  }, [account, revision])
}

/** How often a posted order is checked for a fill. */
const FILL_POLL_MS = 20_000

/**
 * Follow every posted order in the history until it fills or expires, and log the outcome — with the
 * settlement transaction when it filled. Survives reloads, since the pending orders live in the history.
 *
 * The keeper may post to production or staging (barn), so an order is looked up in both.
 */
export function useFillTracker(onNew: (entry: ActivityEntry) => void): void {
  const callback = useRef(onNew)
  callback.current = onNew

  useEffect(() => {
    let running = false

    const check = async () => {
      if (running) return
      running = true
      try {
        for (const posted of listActivity().filter((entry) => entry.orderUid && entry.settled === false)) {
          const outcome = await orderOutcome(posted.chainId, posted.orderUid!)
          if (!outcome) continue
          updateActivity(posted.id, { settled: true })
          const filled: ActivityEntry = {
            id: `${posted.id}:${outcome.status}`,
            at: Date.now(),
            chainId: posted.chainId,
            drop: posted.drop,
            label: posted.label,
            type: outcome.status === 'filled' ? 'order-filled' : 'order-expired',
            title: outcome.status === 'filled' ? 'Order filled' : `Order ${outcome.status}`,
            tone: outcome.status === 'filled' ? 'ok' : 'warn',
            links: [
              ...posted.links,
              ...(outcome.txHash
                ? [{ label: 'Settlement', url: `${blockExplorer(posted.chainId).url}/tx/${outcome.txHash}` }]
                : []),
            ],
          }
          if (addActivity(filled)) callback.current(filled)
        }
      } finally {
        running = false
      }
    }

    void check()
    const timer = setInterval(() => void check(), FILL_POLL_MS)
    return () => clearInterval(timer)
  }, [])
}

/** Final state of an order, or undefined while it can still fill (or cannot be found yet). */
async function orderOutcome(
  chainId: number,
  orderUid: string,
): Promise<{ status: 'filled' | 'expired' | 'cancelled'; txHash?: string } | undefined> {
  for (const env of ['prod', 'staging'] as const) {
    const api = new OrderBookApi({ chainId: chainId as SupportedChainId, env })
    let order
    try {
      order = await api.getOrder(orderUid)
    } catch {
      continue // not in this environment's book
    }
    if (order.status === 'fulfilled') {
      const trades = await api.getTrades({ orderUid }).catch(() => [])
      return { status: 'filled', txHash: trades[0]?.txHash ?? undefined }
    }
    if (order.status === 'expired' || order.status === 'cancelled') return { status: order.status }
    return undefined
  }
  // In neither book. Give up once the order's own deadline (the uid's last four bytes) has passed.
  const validTo = Number.parseInt(orderUid.slice(-8), 16) * 1000
  return Date.now() > validTo + 60_000 ? { status: 'expired' } : undefined
}
