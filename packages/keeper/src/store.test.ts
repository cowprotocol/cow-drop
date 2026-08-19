import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CHAIN_ID, recipeJson, registered, twapRecipeJson } from './fixtures.js'
import { DropConflict, fileStore, memoryStore, utcDay, type KeeperStore } from './store.js'

async function tempPath(name = 'keeper.json'): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'cow-drop-keeper-')), name)
}

/** Both implementations must behave identically, so the suite runs twice. */
const stores: [string, () => Promise<KeeperStore>][] = [
  ['memoryStore', async () => memoryStore()],
  ['fileStore', async () => fileStore(await tempPath(), CHAIN_ID)],
]

describe.each(stores)('%s', (_name, create) => {
  it('round-trips a drop', async () => {
    const store = await create()
    const drop = registered()

    await store.put(drop)

    expect(await store.get(CHAIN_ID, drop.address)).toEqual(drop)
  })

  it('finds a drop whatever the casing of the address asked for', async () => {
    // The address is a key, not a checksum. A caller passing the checksummed form must not miss.
    const store = await create()
    const drop = registered()
    await store.put(drop)

    expect(await store.get(CHAIN_ID, drop.address.toUpperCase().replace('0X', '0x') as `0x${string}`)).toBeDefined()
  })

  it('refuses to overwrite an address with a different recipe', async () => {
    // Silently replacing would point the keeper at a recipe the funder never agreed to.
    const store = await create()
    const drop = registered()
    await store.put(drop)

    await expect(store.put({ ...drop, setupData: '0xdeadbeef' })).rejects.toBeInstanceOf(DropConflict)
  })

  it('accepts a re-put of the identical record', async () => {
    const store = await create()
    const drop = registered()
    await store.put(drop)

    await expect(store.put({ ...drop, everFunded: true })).resolves.toBeUndefined()
  })

  it('applies a mutation and reports whether the record was there', async () => {
    const store = await create()
    const drop = registered()
    await store.put(drop)

    expect(await store.update(CHAIN_ID, drop.address, (d) => ({ ...d, everFunded: true }))).toBe(true)
    expect((await store.get(CHAIN_ID, drop.address))?.everFunded).toBe(true)
    expect(await store.update(CHAIN_ID, '0x' + '11'.repeat(20) as `0x${string}`, (d) => d)).toBe(false)
  })

  it('writes nothing when the mutator returns undefined', async () => {
    const store = await create()
    const drop = registered()
    await store.put(drop)

    expect(await store.update(CHAIN_ID, drop.address, () => undefined)).toBe(true)
    expect(await store.get(CHAIN_ID, drop.address)).toEqual(drop)
  })

  it('leaves retired drops out of the active set but keeps them in all', async () => {
    // A retired record still holds the only server-side copy of the recipe.
    const store = await create()
    const live = registered()
    const dead = registered({ recipe: { ...live.recipe, label: 'other' }, status: 'retired' })
    await store.put(live)
    await store.put(dead)

    expect((await store.active(CHAIN_ID)).map((d) => d.address)).toEqual([live.address])
    expect(await store.count(CHAIN_ID)).toBe(2)
    expect((await store.all(CHAIN_ID)).length).toBe(2)
  })

  it('orders the active set oldest-poll-first, so a capped tick starves nothing', async () => {
    const store = await create()
    const fresh = registered({ lastPoll: { at: 500, native: '0', tokens: {} } })
    const stale = registered({
      recipe: { ...registered().recipe, label: 'stale' },
      lastPoll: { at: 100, native: '0', tokens: {} },
    })
    await store.put(fresh)
    await store.put(stale)

    expect((await store.active(CHAIN_ID))[0]?.address).toBe(stale.address)
  })

  it('accumulates spend per day and per owner', async () => {
    const store = await create()
    const day = utcDay(Date.UTC(2026, 0, 15))

    await store.record(day, '0xAAA0000000000000000000000000000000000000', 100n)
    await store.record(day, '0xAAA0000000000000000000000000000000000000', 50n)
    await store.record(day, '0xBBB0000000000000000000000000000000000000', 7n)

    const spend = await store.spendOn(day)
    expect(spend.totalWei).toBe(157n)
    expect(spend.byOwner.get('0xaaa0000000000000000000000000000000000000')).toBe(150n)
  })

  it('reports no spend for a day nothing happened on', async () => {
    const store = await create()
    expect((await store.spendOn('2026-01-01')).totalWei).toBe(0n)
  })

  it('compacts days before the cutoff and keeps the rest', async () => {
    const store = await create()
    await store.record('2026-01-01', '0xAAA0000000000000000000000000000000000000', 1n)
    await store.record('2026-02-01', '0xAAA0000000000000000000000000000000000000', 2n)

    await store.compact('2026-02-01')

    expect((await store.spendOn('2026-01-01')).totalWei).toBe(0n)
    expect((await store.spendOn('2026-02-01')).totalWei).toBe(2n)
  })
})

describe('fileStore', () => {
  it('is empty before the file exists', async () => {
    expect(await fileStore(await tempPath(), CHAIN_ID).count(CHAIN_ID)).toBe(0)
  })

  it('survives a restart, recipe and all', async () => {
    const path = await tempPath()
    const drop = registered()
    await fileStore(path, CHAIN_ID).put(drop)

    // The recipe is the thing that must come back: it is the only way to recover a funded drop.
    expect(await fileStore(path, CHAIN_ID).get(CHAIN_ID, drop.address)).toEqual(drop)
  })

  it('stores wei as strings, so a spend figure cannot round', async () => {
    const path = await tempPath()
    const store = fileStore(path, CHAIN_ID)
    const huge = 2n ** 70n

    await store.record('2026-01-15', '0xAAA0000000000000000000000000000000000000', huge)

    const raw = JSON.parse(await readFile(path, 'utf8'))
    expect(raw.spend['2026-01-15']['0xaaa0000000000000000000000000000000000000']).toBe(huge.toString())
    expect((await fileStore(path, CHAIN_ID).spendOn('2026-01-15')).totalWei).toBe(huge)
  })

  it('un-parks a drop an older build left in `activated`', async () => {
    // That status was written for every confirmed activation and is polled by nothing, so a reusable
    // drop that fired once was stuck: neither retired nor watched, and no refund could wake it. The
    // records are on disk already, so the release has to happen on the way in.
    const path = await tempPath()
    const drop = registered({ recipe: recipeJson({ once: false }) })
    await fileStore(path, CHAIN_ID).put({ ...drop, status: 'activated' })

    expect((await fileStore(path, CHAIN_ID).get(CHAIN_ID, drop.address))?.status).toBe('watching')
  })

  it('leaves a parked conditional-order drop parked', async () => {
    // For a TWAP `activated` still means what it says: the schedule is running, its balance is falling
    // as the parts fill, and re-simulating would register a second one over the remainder.
    const path = await tempPath()
    const drop = registered({ recipe: twapRecipeJson() })
    await fileStore(path, CHAIN_ID).put({ ...drop, status: 'activated' })

    expect((await fileStore(path, CHAIN_ID).get(CHAIN_ID, drop.address))?.status).toBe('activated')
  })

  it('refuses a state file written for another chain', async () => {
    // Adopting another chain's drops would watch addresses that mean something else there.
    const path = await tempPath()
    await fileStore(path, 1).put(registered({ chainId: 1 }))

    await expect(fileStore(path, CHAIN_ID).count(CHAIN_ID)).rejects.toThrow(/chain 1, not 100/)
  })

  it('propagates a corrupt file rather than silently starting over', async () => {
    // Starting fresh would mean quietly dropping every recipe the service is holding.
    const path = await tempPath()
    await writeFile(path, 'not json')

    await expect(fileStore(path, CHAIN_ID).count(CHAIN_ID)).rejects.toThrow()
  })

  it('leaves the previous file intact when a write fails', async () => {
    // Temp-then-rename, and this is the reason for it: a torn write here is a lost recipe, which is
    // lost money. Occupying the temp path with a directory makes the write fail at the only point it
    // can, and the committed file must not have moved.
    const path = await tempPath()
    const store = fileStore(path, CHAIN_ID)
    await store.put(registered())
    const before = await readFile(path, 'utf8')

    await mkdir(`${path}.tmp`, { recursive: true })

    await expect(store.put(registered({ recipe: recipeWithLabel('second') }))).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('serialises concurrent writes instead of losing one', async () => {
    // Read-modify-write on a whole document: without a queue the last writer wins and the other
    // registration vanishes.
    const path = await tempPath()
    const store = fileStore(path, CHAIN_ID)
    const a = registered({ recipe: recipeWithLabel('a') })
    const b = registered({ recipe: recipeWithLabel('b') })

    await Promise.all([store.put(a), store.put(b)])

    expect(await fileStore(path, CHAIN_ID).count(CHAIN_ID)).toBe(2)
  })
})

function recipeWithLabel(label: string) {
  return { ...registered().recipe, label }
}
