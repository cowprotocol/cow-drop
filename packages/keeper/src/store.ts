import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Address } from 'viem'

import type { RegisteredDrop } from './types.js'

/**
 * The drops this keeper looks after.
 *
 * Shaped like the watch tower's `Cursor`: a small interface with a JSON-file implementation now and
 * room for Postgres later. The one addition worth noting is `update`, which is a read-modify-write
 * under the store's own lock rather than a `put` the caller races on — that is the seam a Postgres
 * implementation fills with `SELECT … FOR UPDATE`, and it is what stops a tick clobbering a
 * registration that arrived while it was running.
 */
export interface DropStore {
  get(chainId: number, address: Address): Promise<RegisteredDrop | undefined>
  /** First write. Rejects an address already held with different `setupData`. */
  put(drop: RegisteredDrop): Promise<void>
  /**
   * Read, mutate, write, atomically. Returns false if the record has gone; a mutator returning
   * `undefined` means "no change" and writes nothing.
   */
  update(
    chainId: number,
    address: Address,
    mutate: (current: RegisteredDrop) => RegisteredDrop | undefined,
  ): Promise<boolean>
  /** Everything the tick loop should consider — excludes `retired`, oldest poll first. */
  active(chainId: number): Promise<RegisteredDrop[]>
  /** Every record, retired included. For the retention sweep. */
  all(chainId: number): Promise<RegisteredDrop[]>
  count(chainId: number): Promise<number>
  delete(chainId: number, address: Address): Promise<void>
}

/**
 * Money already committed, by UTC day.
 *
 * Separate from `DropStore` because it is one row per day rather than one per drop, and because the
 * budget has to survive a crash loop — an in-memory ledger would reset the daily cap every time the
 * process died, which is exactly the moment the cap matters.
 */
export interface SpendStore {
  /** `day` is `YYYY-MM-DD`, UTC. */
  spendOn(day: string): Promise<{ totalWei: bigint; byOwner: Map<Address, bigint> }>
  record(day: string, owner: Address, wei: bigint): Promise<void>
  /** Drop days before `day`. Called by the retention sweep. */
  compact(day: string): Promise<void>
}

/** The `YYYY-MM-DD` a timestamp falls in, UTC — the budget window key. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** Lowercased, so a checksum difference never reads as a different drop. */
function key(chainId: number, address: Address): string {
  return `${chainId}:${address.toLowerCase()}`
}

export interface KeeperStore extends DropStore, SpendStore {}

/** A store that lives only as long as the process. The test default. */
export function memoryStore(initial: RegisteredDrop[] = []): KeeperStore {
  const drops = new Map<string, RegisteredDrop>(initial.map((drop) => [key(drop.chainId, drop.address), drop]))
  const spend = new Map<string, Map<string, bigint>>()

  return {
    async get(chainId, address) {
      return drops.get(key(chainId, address))
    },

    async put(drop) {
      const existing = drops.get(key(drop.chainId, drop.address))
      if (existing && existing.setupData !== drop.setupData) {
        throw new DropConflict(drop.address, drop.chainId)
      }
      drops.set(key(drop.chainId, drop.address), drop)
    },

    async update(chainId, address, mutate) {
      const current = drops.get(key(chainId, address))
      if (!current) return false
      const next = mutate(current)
      if (next) drops.set(key(chainId, address), next)
      return true
    },

    async active(chainId) {
      return byStaleness([...drops.values()].filter((d) => d.chainId === chainId && d.status !== 'retired'))
    },

    async all(chainId) {
      return [...drops.values()].filter((drop) => drop.chainId === chainId)
    },

    async count(chainId) {
      return [...drops.values()].filter((drop) => drop.chainId === chainId).length
    },

    async delete(chainId, address) {
      drops.delete(key(chainId, address))
    },

    async spendOn(day) {
      const byOwner = new Map<Address, bigint>()
      let totalWei = 0n
      for (const [owner, wei] of spend.get(day) ?? []) {
        byOwner.set(owner as Address, wei)
        totalWei += wei
      }
      return { totalWei, byOwner }
    },

    async record(day, owner, wei) {
      const forDay = spend.get(day) ?? new Map<string, bigint>()
      const at = owner.toLowerCase()
      forDay.set(at, (forDay.get(at) ?? 0n) + wei)
      spend.set(day, forDay)
    },

    async compact(day) {
      for (const existing of [...spend.keys()]) {
        if (existing < day) spend.delete(existing)
      }
    },
  }
}

/** Oldest poll first, so nothing starves when a tick caps how much work it does. */
function byStaleness(drops: RegisteredDrop[]): RegisteredDrop[] {
  return drops.sort((a, b) => (a.lastPoll?.at ?? 0) - (b.lastPoll?.at ?? 0))
}

/** The address is already registered under a different recipe. Never silently overwritten. */
export class DropConflict extends Error {
  constructor(
    readonly address: Address,
    readonly chainId: number,
  ) {
    super(`${address} is already registered on chain ${chainId} with a different recipe`)
    this.name = 'DropConflict'
  }
}

interface StoredFile {
  chainId: number
  drops: RegisteredDrop[]
  /** `{ 'YYYY-MM-DD': { '0xowner': '12345' } }` — wei as decimal strings, as everywhere. */
  spend: Record<string, Record<string, string>>
}

/**
 * A store persisted as JSON.
 *
 * Two differences from `fileCursor`, both because of what this file holds. It carries **recipes** —
 * the only bytes that can recover a funded drop — so writes go to a temp file and `rename`, and a
 * torn write can never leave the registry half-parsed. And it holds the **spend ledger**, so it is
 * read once at open and kept in memory; every mutation rewrites the whole document, which is fine for
 * the scale this runs at and wrong the moment it is not, at which point the interface above is the
 * thing to reimplement.
 *
 * Like `fileCursor`, it carries the chain id and refuses to answer for a different one. Pointing a
 * Gnosis keeper at a mainnet state file would otherwise adopt a set of drops whose addresses mean
 * something else there.
 */
export function fileStore(path: string, chainId: number): KeeperStore {
  let cache: StoredFile | undefined
  /** Serialises writes, so two concurrent mutations cannot both read-modify-write the same document. */
  let queue: Promise<unknown> = Promise.resolve()

  async function read(): Promise<StoredFile> {
    if (cache) return cache

    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = { chainId, drops: [], spend: {} }
        return cache
      }
      throw error
    }

    const parsed = JSON.parse(raw) as StoredFile
    if (parsed.chainId !== chainId) {
      throw new Error(`${path} holds state for chain ${parsed.chainId}, not ${chainId}`)
    }
    cache = { chainId, drops: parsed.drops ?? [], spend: parsed.spend ?? {} }
    return cache
  }

  async function write(next: StoredFile): Promise<void> {
    cache = next
    await mkdir(dirname(path), { recursive: true })
    // Temp-then-rename: a crash mid-write leaves the previous file intact rather than a truncated
    // one. This file is the only server-side copy of recipes, so a torn write is lost money.
    const temp = `${path}.tmp`
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`)
    await rename(temp, path)
  }

  /** Every mutation runs through here, one at a time. */
  function serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  return {
    async get(_chainId, address) {
      const file = await read()
      return file.drops.find((drop) => drop.address === address.toLowerCase())
    },

    async put(drop) {
      return serialise(async () => {
        const file = await read()
        const existing = file.drops.find((d) => d.address === drop.address.toLowerCase())
        if (existing && existing.setupData !== drop.setupData) {
          throw new DropConflict(drop.address, drop.chainId)
        }
        const others = file.drops.filter((d) => d.address !== drop.address.toLowerCase())
        await write({ ...file, drops: [...others, drop] })
      })
    },

    async update(_chainId, address, mutate) {
      return serialise(async () => {
        const file = await read()
        const at = file.drops.findIndex((drop) => drop.address === address.toLowerCase())
        if (at === -1) return false

        const next = mutate(file.drops[at]!)
        if (!next) return true

        const drops = [...file.drops]
        drops[at] = next
        await write({ ...file, drops })
        return true
      })
    },

    async active() {
      return byStaleness((await read()).drops.filter((drop) => drop.status !== 'retired'))
    },

    async all() {
      return [...(await read()).drops]
    },

    async count() {
      return (await read()).drops.length
    },

    async delete(_chainId, address) {
      return serialise(async () => {
        const file = await read()
        await write({ ...file, drops: file.drops.filter((drop) => drop.address !== address.toLowerCase()) })
      })
    },

    async spendOn(day) {
      const byOwner = new Map<Address, bigint>()
      let totalWei = 0n
      for (const [owner, wei] of Object.entries((await read()).spend[day] ?? {})) {
        byOwner.set(owner as Address, BigInt(wei))
        totalWei += BigInt(wei)
      }
      return { totalWei, byOwner }
    },

    async record(day, owner, wei) {
      return serialise(async () => {
        const file = await read()
        const at = owner.toLowerCase()
        const forDay = { ...(file.spend[day] ?? {}) }
        forDay[at] = (BigInt(forDay[at] ?? '0') + wei).toString()
        await write({ ...file, spend: { ...file.spend, [day]: forDay } })
      })
    },

    async compact(day) {
      return serialise(async () => {
        const file = await read()
        const spend = Object.fromEntries(Object.entries(file.spend).filter(([existing]) => existing >= day))
        await write({ ...file, spend })
      })
    },
  }
}
