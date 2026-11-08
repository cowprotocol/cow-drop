import { useEffect, useState } from 'react'
import type { Address } from 'viem'

/**
 * Your own name for a drop, kept in this browser.
 *
 * Distinct from the recipe's `label`, and deliberately so. That one is encoded into `setupData` and
 * is therefore part of the address — it cannot change once a drop is funded, because changing it
 * would be describing a different drop at a different address. This is the other thing people want:
 * a name they can put on the drops they already have, to tell four `swap on arrival` rows apart.
 *
 * What that buys, and what it costs:
 *
 * - It is editable at any time, for funded drops included, because nothing derives from it.
 * - It never leaves this browser. Clearing site data loses it, it does not travel with the
 *   `.drop.json`, and it is not in the share link or the QR. Anybody you send a drop to sees the
 *   recipe's name, not yours.
 *
 * So it is shown where *you* are identifying your own drops — the saved list, the header, the
 * activity feed — and never on the share card, which is written for someone else.
 *
 * Keyed by chain and address rather than by recipe, so a drop the keeper holds and this browser has
 * no recipe for can still be named.
 */

const KEY = 'cow-drop:nicknames:v1'
const CHANGED = 'cow-drop:nicknames-changed'

/** How long a nickname may be. Nothing enforces it on-chain; this is a list that has to stay readable. */
export const NICKNAME_MAX = 40

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    // A corrupt or blocked store costs a convenience, not a recipe.
    return {}
  }
}

function write(all: Record<string, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // Private browsing, or a full quota. The rename simply does not stick.
  }
  window.dispatchEvent(new Event(CHANGED))
}

/** The same address on two chains is two drops, so the chain is part of the key. */
function key(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`
}

/** Your name for this drop, or null. */
export function nicknameOf(chainId: number, address: Address | string): string | null {
  return read()[key(chainId, address)] ?? null
}

/** Set it, or clear it by passing an empty string. */
export function setNickname(chainId: number, address: Address | string, nickname: string): void {
  const all = read()
  const trimmed = nickname.trim().slice(0, NICKNAME_MAX)
  if (trimmed === '') delete all[key(chainId, address)]
  else all[key(chainId, address)] = trimmed
  write(all)
}

/**
 * A counter that changes whenever any nickname does, for components that render one.
 *
 * Kept here rather than in each consumer so there is one subscription shape, and because a nickname
 * can be edited from a row the consumer knows nothing about.
 */
export function useNicknameRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => onNicknamesChanged(() => setRevision((n) => n + 1)), [])
  return revision
}

/** Call `listener` whenever any nickname changes, in this tab or another. */
export function onNicknamesChanged(listener: () => void): () => void {
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
