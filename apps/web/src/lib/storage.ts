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
 * also keeps the current one in the URL so a bookmark or a reload is enough to get it back — while the
 * Recipes tab is the one showing; see `./route.ts`, which also explains why `recipeToHash`'s alphabet is
 * now load-bearing for routing and not only for copy-paste.
 */

const KEY = 'cow-drop:recipes:v1'

export interface SavedDrop {
  address: Address
  chainId: number
  label: string
  recipe: DropRecipeJson
  /**
   * Unix ms of the **first** save — when this drop came into existence, as far as this browser knows.
   *
   * Preserved across re-saves on purpose. A recipe is re-saved every time the user copies the address,
   * downloads the file or activates, so a single `Date.now()` would drift forward and the list would
   * report "created" times that are really "last touched" ones. That is invisible at day resolution and
   * obvious once the time is shown.
   */
  savedAt: number
  /** Unix ms of the most recent save. Absent on records written before this field existed. */
  updatedAt?: number
  /**
   * That this browser handed the recipe to a keeper, and to which one.
   *
   * A record of what *we did*, not of what is true now. The keeper's own state is the truth, and its
   * `--state` defaults to memory only — so a restart can drop every registration while this flag still
   * says otherwise. Treat it as "we sent this" and confirm against the keeper before telling anyone it
   * is being watched; see `readKeeperDrop`.
   */
  keeper?: { url: string; registeredAt: number }
}

/** The saved drops, or none. A corrupt entry reads as empty rather than throwing. */
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

/** Persist the list, best effort — see below for why a failure is swallowed. */
function write(drops: SavedDrop[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(drops))
  } catch {
    // Private browsing, or a full quota. Nothing useful to do, and throwing here would break the
    // action the user actually asked for.
  }
}

/** Most recently touched first — which is not the same as most recently created. */
export function listDrops(): SavedDrop[] {
  return read().sort((a, b) => (b.updatedAt ?? b.savedAt) - (a.updatedAt ?? a.savedAt))
}

/** Save a recipe, replacing any earlier entry for the same drop. Returns the stored record. */
export function saveDrop(params: { address: Address; recipe: DropRecipeJson }): SavedDrop {
  const now = Date.now()
  const existing = read().find(
    (drop) => drop.address.toLowerCase() === params.address.toLowerCase() && drop.chainId === params.recipe.chainId,
  )

  const record: SavedDrop = {
    address: params.address,
    chainId: params.recipe.chainId,
    label: params.recipe.label,
    recipe: params.recipe,
    // Kept from the earlier entry, so re-saving does not rewrite when the drop was created.
    savedAt: existing?.savedAt ?? now,
    updatedAt: now,
  }

  const others = read().filter(
    (drop) => !(drop.address.toLowerCase() === record.address.toLowerCase() && drop.chainId === record.chainId),
  )
  write([record, ...others])
  return record
}

/** Remove one drop from this browser's list. */
export function forgetDrop(address: Address, chainId: number): void {
  write(
    read().filter((drop) => !(drop.address.toLowerCase() === address.toLowerCase() && drop.chainId === chainId)),
  )
}

/**
 * Record that the recipe was handed to a keeper. No-op for an address this browser has not saved,
 * since the flag belongs to a saved record rather than standing alone.
 */
export function markSentToKeeper(params: { address: Address; chainId: number; url: string }): void {
  const drops = read()
  const index = drops.findIndex(
    (drop) => drop.address.toLowerCase() === params.address.toLowerCase() && drop.chainId === params.chainId,
  )
  if (index === -1) return

  drops[index] = { ...drops[index]!, keeper: { url: params.url, registeredAt: Date.now() } }
  write(drops)
}

/** Forget that it was sent, after unregistering. */
export function clearSentToKeeper(address: Address, chainId: number): void {
  const drops = read()
  const index = drops.findIndex(
    (drop) => drop.address.toLowerCase() === address.toLowerCase() && drop.chainId === chainId,
  )
  if (index === -1) return

  const { keeper: _dropped, ...rest } = drops[index]!
  drops[index] = rest
  write(drops)
}

/** Whether this browser is already keeping this drop. */
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

/**
 * A recipe back out of the fragment, or null for anything that is not one. The inverse of
 * `recipeToHash`.
 */
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

/**
 * What was being set up on the Bridge tab, per drop.
 *
 * Separate from the recipe, and deliberately not in the URL. The recipe is the key to the money and
 * belongs in a link; the source chain, token and amount are local intent — this browser's half-finished
 * decision about how to fund one particular drop. Keyed by drop address so returning to a drop restores
 * what you were doing for *it*, rather than leaking the last amount you typed onto an unrelated one.
 *
 * Best-effort throughout: nothing here is unrecoverable if it is lost, so a corrupt or full store reads
 * as absent rather than throwing.
 */
const BRIDGE_KEY = 'cow-drop:bridge-form:v1'

export interface SavedBridgeForm {
  sourceChainId: number
  sourceToken: Address
  amountText: string
  onFailure: string
  /**
   * Which bridge provider was selected.
   *
   * Note what is deliberately *not* here: the delivery mode. This record is a half-finished decision
   * about how to fund one drop, and a delivery mode is not that — it is a safety posture. Restoring
   * `atomic` because it was used once, silently, months ago, re-arms the riskier path without anyone
   * choosing it again. A provider is a preference; a mode is a decision, and it gets made each time.
   */
  provider?: string
}

export function readBridgeForm(drop: Address): SavedBridgeForm | null {
  try {
    const raw = localStorage.getItem(BRIDGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, SavedBridgeForm>
    const saved = parsed[drop.toLowerCase()]
    return saved && typeof saved.sourceChainId === 'number' ? saved : null
  } catch {
    return null
  }
}

export function saveBridgeForm(drop: Address, form: SavedBridgeForm): void {
  try {
    const raw = localStorage.getItem(BRIDGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, SavedBridgeForm>) : {}
    parsed[drop.toLowerCase()] = form
    localStorage.setItem(BRIDGE_KEY, JSON.stringify(parsed))
  } catch {
    // A full or disabled store costs a convenience, not a recipe. Nothing to report.
  }
}

/**
 * Bridges this browser has sent.
 *
 * A convenience, not a safety net — unlike a recipe, nothing here is unrecoverable if it is lost, and
 * the source transaction hash is recorded on two chains regardless. What it buys is not having to keep
 * a tab open or dig through a wallet history to find out whether a bridge from an hour ago has landed.
 *
 * Amounts are kept as decimal strings, already formatted for display. Re-deriving them would mean
 * storing decimals and a token list alongside, and this list never does arithmetic on them.
 */
const BRIDGES_KEY = 'cow-drop:bridges:v1'

export interface SavedBridge {
  /** The source-chain transaction. Unique per send, so it is the identity of the row. */
  hash: string
  /** How it was delivered — `direct` or `atomic`. Absent on rows written before the choice existed. */
  mode?: string
  /** Which provider quoted it. Absent on rows written before there was more than one. */
  provider?: string
  sourceChainId: number
  destinationChainId: number
  /** Where the money is going, and the drop whose order should appear once it lands. */
  drop: Address
  label: string
  route: string
  sent: { symbol: string; amount: string }
  expected: { symbol: string; amount: string }
  sentAt: number
}

export function listBridges(): SavedBridge[] {
  try {
    const raw = localStorage.getItem(BRIDGES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SavedBridge[]
    if (!Array.isArray(parsed)) return []
    // Newest first: a history is read from the top, and the one you just sent is the one you want.
    return parsed.filter((row) => typeof row?.hash === 'string').sort((a, b) => b.sentAt - a.sentAt)
  } catch {
    return []
  }
}

export function saveBridge(bridge: SavedBridge): void {
  try {
    // Keyed by hash so a re-render or a retry cannot double-list one send.
    const kept = listBridges().filter((row) => row.hash.toLowerCase() !== bridge.hash.toLowerCase())
    localStorage.setItem(BRIDGES_KEY, JSON.stringify([bridge, ...kept]))
  } catch {
    // A full or disabled store costs a list, not a transaction.
  }
}

export function forgetBridge(hash: string): void {
  try {
    const kept = listBridges().filter((row) => row.hash.toLowerCase() !== hash.toLowerCase())
    localStorage.setItem(BRIDGES_KEY, JSON.stringify(kept))
  } catch {
    // As above.
  }
}
