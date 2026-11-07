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
  /**
   * The drop's saved name at the time the line was written, or `''` when this browser does not know
   * it — a drop followed through the owner subscription rather than from the saved list.
   *
   * A field rather than a prefix on `title`, which is what it used to be. That cost twice: the list
   * could not group or filter by drop without parsing its own sentences back apart, and the fill
   * tracker really did recover the name with `title.replace(/: order posted$/, '')`.
   */
  label: string
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

/** A drop's short address, which is how it is named when this browser has no name for it. */
export function shortDrop(drop: string): string {
  return `${drop.slice(0, 6)}…${drop.slice(-4)}`
}

/** What to call the drop on a line: its saved name, or its short address. Never empty. */
export function dropName(entry: ActivityEntry): string {
  return entry.label || shortDrop(entry.drop)
}

export function listActivity(): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    // Lines written before `label` existed carry the name inside `title` instead. Left alone rather
    // than parsed back out: they still read correctly, and the chip simply does not appear on them.
    return (parsed as ActivityEntry[]).map((entry) => ({ ...entry, label: entry.label ?? '' }))
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
