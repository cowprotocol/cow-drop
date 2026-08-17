import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address } from 'viem'

/**
 * Local persistence for recipes.
 *
 * This is not a convenience. A drop address is a hash commitment to `setupData`, and **every** path
 * that can touch the drop needs those exact bytes back: `activate` to run it, and
 * `initializeProxyWithoutSetup` — the owner's rescue hatch — to recover from it. `DropTriggered` emits
 * only the hash, so nothing on-chain carries the preimage.
 *
 * The consequence is stark: fund a drop, lose the recipe before ever activating it, and the money is
 * gone for good — not just for you, for anyone. There is no owner override, because the owner needs the
 * same bytes everybody else does.
 *
 * (Once a drop *has* been activated the recipe is recoverable, since `setupData` appears in the
 * calldata of the deploying transaction. That only helps after the fact.)
 *
 * So the recipe is saved at every point where a user might be about to fund an address, and the page
 * also keeps the current one in the URL so a bookmark or a reload is enough to get it back.
 */

const KEY = 'cow-drop:recipes:v1'

export interface SavedDrop {
  address: Address
  chainId: number
  label: string
  recipe: DropRecipeJson
  /** Unix ms, so the list can show the newest first. */
  savedAt: number
}

function read(): SavedDrop[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SavedDrop[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // A corrupt entry must not take the page down with it.
    return []
  }
}

function write(drops: SavedDrop[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(drops))
  } catch {
    // Private browsing, or a full quota. Nothing useful to do, and throwing here would break the
    // action the user actually asked for.
  }
}

export function listDrops(): SavedDrop[] {
  return read().sort((a, b) => b.savedAt - a.savedAt)
}

/** Save a recipe, replacing any earlier entry for the same drop. Returns the stored record. */
export function saveDrop(params: { address: Address; recipe: DropRecipeJson }): SavedDrop {
  const record: SavedDrop = {
    address: params.address,
    chainId: params.recipe.chainId,
    label: params.recipe.label,
    recipe: params.recipe,
    savedAt: Date.now(),
  }

  const others = read().filter(
    (drop) => !(drop.address.toLowerCase() === record.address.toLowerCase() && drop.chainId === record.chainId),
  )
  write([record, ...others])
  return record
}

export function forgetDrop(address: Address, chainId: number): void {
  write(
    read().filter((drop) => !(drop.address.toLowerCase() === address.toLowerCase() && drop.chainId === chainId)),
  )
}

export function isSaved(address: Address, chainId: number): boolean {
  return read().some(
    (drop) => drop.address.toLowerCase() === address.toLowerCase() && drop.chainId === chainId,
  )
}

// --- URL round-trip ------------------------------------------------------------------------------

/**
 * Keep the current recipe in the URL fragment, so a bookmark, a pasted link or a plain reload restores
 * it. The fragment never reaches a server, which suits something that is effectively a key.
 */
export function recipeToHash(recipe: DropRecipeJson): string {
  const json = JSON.stringify(recipe)
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
  // base64url, so the fragment survives copy-paste and does not need escaping.
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function recipeFromHash(hash: string): DropRecipeJson | null {
  const cleaned = hash.replace(/^#/, '').trim()
  if (!cleaned) return null

  try {
    const base64 = cleaned.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
    const json = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
    const parsed = JSON.parse(json) as DropRecipeJson
    return parsed && typeof parsed === 'object' && 'steps' in parsed ? parsed : null
  } catch {
    return null
  }
}
