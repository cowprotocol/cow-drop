import type { Address } from 'viem'

/**
 * What the keeper did for this browser's drops, kept in localStorage.
 *
 * Fed by the keeper's event stream (`./keeperStream.ts`) and by the fill tracker, shown as toasts and in
 * the Drops tab's activity list. A convenience log, not a source of truth: the keeper and the chain are.
 */

const KEY = 'cow-drop:activity:v1'
const MAX_ENTRIES = 200
const CHANGED = 'cow-drop:activity-changed'

export interface ActivityLink {
  label: string
  url: string
}

export interface ActivityEntry {
  /** Stable across reconnects and reloads, so a replayed event is not logged twice. */
  id: string
  at: number
  chainId: number
  drop: Address
  /** The keeper event type, or `order-filled` / `order-expired` from the fill tracker. */
  type: string
  title: string
  detail?: string
  tone: 'info' | 'ok' | 'warn' | 'error'
  links: ActivityLink[]
  /** For `order-posted`: the order to follow until it fills. */
  orderUid?: string
  /** For `order-posted`: set once the fill tracker has an outcome, so it stops polling. */
  settled?: boolean
}

export function listActivity(): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as ActivityEntry[]) : []
  } catch {
    return []
  }
}

function write(entries: ActivityEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    // Storage full or blocked: the toast still shows, only the history is lost.
  }
  window.dispatchEvent(new Event(CHANGED))
}

/** Add an entry, newest first. Returns false when it was already logged. */
export function addActivity(entry: ActivityEntry): boolean {
  const entries = listActivity()
  if (entries.some((existing) => existing.id === entry.id)) return false
  write([entry, ...entries])
  return true
}

export function updateActivity(id: string, patch: Partial<ActivityEntry>): void {
  write(listActivity().map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
}

export function clearActivity(): void {
  write([])
}

/** Call `listener` whenever the history changes, in this tab or another. */
export function onActivityChanged(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener()
  }
  window.addEventListener(CHANGED, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHANGED, listener)
    window.removeEventListener('storage', onStorage)
  }
}
