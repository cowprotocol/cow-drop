import { compileRecipe, getDeployment } from '@cowprotocol/cow-drop-sdk'
import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'

import { CHAIN_ID, deployment, GENERATION, OWNER, recipeJson, twapRecipeJson, WXDAI } from './fixtures.js'
import { appDataHash } from './appData.js'
import { registerDrop, unregisterDrop } from './registry.js'
import { memoryStore } from './store.js'

const NOW = 1_700_000_000_000
const MAX_DROPS = 100

async function register(overrides: Partial<Parameters<typeof registerDrop>[0]> = {}) {
  const recipe = overrides.recipe ?? recipeJson()
  return registerDrop({
    recipe,
    address: overrides.address ?? compileRecipe(recipe).address,
    store: overrides.store ?? memoryStore(),
    deployment: overrides.deployment ?? deployment(),
    maxDrops: overrides.maxDrops ?? MAX_DROPS,
    now: NOW,
    appDataDocuments: overrides.appDataDocuments,
    requireFeeFor: overrides.requireFeeFor,
    minFeeBps: overrides.minFeeBps,
  })
}

describe('registerDrop', () => {
  it('accepts a recipe whose address the client got right', async () => {
    const result = await register()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toBe(true)
    expect(result.drop.status).toBe('watching')
    expect(result.drop.owner).toBe(OWNER)
    // The token to poll comes out of the recipe, not from anything the client said.
    expect(result.drop.hints.tokens).toEqual([WXDAI.toLowerCase()])
  })

  it('rejects an address the client derived differently, and names both', async () => {
    // The SDK-skew case, and the reason this endpoint checks anything at all: without it the keeper
    // would diligently watch an address nobody funded while the user watches the one they did.
    const wrong = `0x${'11'.repeat(20)}` as Address
    const result = await register({ address: wrong })

    expect(result).toMatchObject({ ok: false, error: 'address-mismatch', supplied: wrong })
    if (result.ok || result.error !== 'address-mismatch') return
    expect(result.derived).toBe(compileRecipe(recipeJson()).address)
  })

  it('does not treat a checksum difference as a mismatch', async () => {
    const derived = compileRecipe(recipeJson()).address
    const result = await register({ address: derived.toLowerCase() as Address })

    expect(result.ok).toBe(true)
  })

  it('stores the address it derived, never the one it was handed', async () => {
    const store = memoryStore()
    await register({ store })

    const stored = await store.get(CHAIN_ID, compileRecipe(recipeJson()).address)
    expect(stored?.address).toBe(compileRecipe(recipeJson()).address.toLowerCase())
  })

  it('registers without an address at all, for a caller using curl', async () => {
    const result = await registerDrop({
      recipe: recipeJson(),
      store: memoryStore(),
      deployment: deployment(),
      maxDrops: MAX_DROPS,
      now: NOW,
    })

    expect(result.ok).toBe(true)
  })

  it('passes the SDK\'s own message through for a recipe that does not compile', async () => {
    // `allowFailure` on a `once` recipe is burnable by anyone, and compileRecipe says so better than
    // this layer could.
    const result = await registerDrop({
      recipe: recipeJson({
        once: true,
        steps: [
          {
            type: 'presignSellAll',
            sellToken: WXDAI,
            buyToken: '0x177127622c4A00F3d409B75571e12cB3c8973d3c',
            limitPrice: { price: '45', sellDecimals: 18, buyDecimals: 18 },
            validitySeconds: 1800,
            allowFailure: true,
          },
        ],
      }),
      store: memoryStore(),
      deployment: deployment(),
      maxDrops: MAX_DROPS,
      now: NOW,
    })

    expect(result).toMatchObject({ ok: false, error: 'invalid-recipe' })
    if (result.ok || result.error !== 'invalid-recipe') return
    expect(result.message).toMatch(/allowFailure/i)
  })

  it('refuses a recipe for a chain this keeper does not serve', async () => {
    // Storing it would mean a registration that is never looked at — the hardest failure to diagnose
    // from the UI, which would just see "registered" and nothing ever happening.
    const result = await register({ recipe: recipeJson({ chainId: 1 }), deployment: getDeployment(1, GENERATION) })

    expect(result.ok).toBe(true) // sanity: chain 1 against a chain-1 deployment is fine

    const mismatched = await register({ recipe: recipeJson({ chainId: 1 }) })
    expect(mismatched).toMatchObject({ ok: false, error: 'wrong-chain', supplied: 1, expected: CHAIN_ID })
  })

  it('records the resolved generation, not the optional field from the JSON', async () => {
    // `generation` is optional and defaults to 1 inside the SDK. Recording the resolved value is what
    // stops a later read resolving it differently.
    const recipe = recipeJson()
    delete (recipe as { generation?: number }).generation
    const result = await register({ recipe })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.drop.generation).toBe(GENERATION)
  })

  it('is idempotent, so a client whose POST timed out can safely retry', async () => {
    const store = memoryStore()
    const first = await register({ store })
    const second = await register({ store })

    expect(first).toMatchObject({ ok: true, created: true })
    expect(second).toMatchObject({ ok: true, created: false })
    expect(await store.count(CHAIN_ID)).toBe(1)
  })

  it('refuses a second, different recipe at the same address', async () => {
    // Cannot happen honestly — the address is a hash of the recipe — so it means somebody is trying.
    const store = memoryStore()
    const drop = await register({ store })
    expect(drop.ok).toBe(true)
    if (!drop.ok) return

    await store.update(CHAIN_ID, drop.drop.address, (current) => ({ ...current, setupData: '0xdead' }))
    const result = await register({ store })

    expect(result).toMatchObject({ ok: false, error: 'conflict' })
  })

  it('refuses once the registry is full', async () => {
    // Registration is open because it grants nothing, but it is not free: every entry is a recipe
    // stored forever and a line in every tick's poll set.
    const store = memoryStore()
    await register({ store })

    expect(await register({ recipe: recipeJson({ label: 'another' }), store, maxDrops: 1 })).toMatchObject({
      ok: false,
      error: 'at-capacity',
    })
  })
})

describe('unregisterDrop', () => {
  it('retires a drop when given the recipe back', async () => {
    const store = memoryStore()
    const recipe = recipeJson()
    await register({ store, recipe })

    const result = await unregisterDrop({ recipe, store, deployment: deployment(), now: NOW })
    expect(result.ok).toBe(true)
    // The retired record comes back, because the HTTP layer emits an event about it and should not have
    // to recompile the recipe to learn which address it just wrote to.
    if (result.ok) expect(result.drop.address).toBe(compileRecipe(recipe).address.toLowerCase())

    const stored = await store.get(CHAIN_ID, compileRecipe(recipe).address)
    expect(stored?.status).toBe('retired')
    expect(stored?.retiredReason).toBe('unregistered')
    // Retired, not deleted: this is still the only server-side copy of the recipe.
    expect(stored?.recipe).toEqual(recipe)
    expect(await store.active(CHAIN_ID)).toEqual([])
  })

  it('reports not-found for a recipe nobody registered', async () => {
    const result = await unregisterDrop({
      recipe: recipeJson({ label: 'never seen' }),
      store: memoryStore(),
      deployment: deployment(),
      now: NOW,
    })

    expect(result).toEqual({ ok: false, error: 'not-found' })
  })

  it('refuses while an activation is in flight, naming the transaction', async () => {
    // Retiring here would abandon a transaction already paid for: `store.active()` skips retired drops,
    // so nothing would ever reconcile the receipt, and the reserved spend would never be trued up.
    const store = memoryStore()
    const recipe = recipeJson()
    await register({ store, recipe })
    const address = compileRecipe(recipe).address.toLowerCase() as Address

    const ref = `0x${'ab'.repeat(32)}` as const
    await store.update(CHAIN_ID, address, (current) => ({
      ...current,
      status: 'activating',
      pending: {
        ref,
        nonce: 7,
        gasLimit: '300000',
        maxFeePerGas: '2000000000',
        reservedWei: '600000000000000',
        sentAt: NOW,
        sentAtBlock: '100',
        replacements: 0,
      },
    }))

    const result = await unregisterDrop({ recipe, store, deployment: deployment(), now: NOW })

    expect(result).toEqual({ ok: false, error: 'activating', ref })
    // Still watched, and still reconcilable — refusing is what keeps it that way.
    expect((await store.get(CHAIN_ID, address))?.status).toBe('activating')
    expect(await store.active(CHAIN_ID)).toHaveLength(1)
  })
})

describe('registering a drop that was unregistered', () => {
  it('resumes watching it', async () => {
    // The other half of the toggle. Without this, "stop watching" is a one-way door that answers 200:
    // the record stays retired and the repeat registration returns it untouched.
    const store = memoryStore()
    const recipe = recipeJson()
    await register({ store, recipe })
    await unregisterDrop({ recipe, store, deployment: deployment(), now: NOW })

    const again = await register({ store, recipe })

    expect(again.ok).toBe(true)
    if (!again.ok) return
    // Not `created`: it is the same record, resumed. A 201 would claim capacity was taken twice.
    expect(again.created).toBe(false)
    expect(again.drop.status).toBe('watching')
    expect(again.drop.retiredReason).toBeUndefined()

    const stored = await store.get(CHAIN_ID, compileRecipe(recipe).address)
    expect(stored?.status).toBe('watching')
    expect(stored?.retiredReason).toBeUndefined()
    expect(await store.active(CHAIN_ID)).toHaveLength(1)
  })

  it('keeps the history and the backoff it earned', async () => {
    // A revive must not be a way to clear a backoff: that would let anyone holding a recipe ask the
    // keeper to retry a reverting drop as fast as it likes.
    const store = memoryStore()
    const recipe = recipeJson()
    await register({ store, recipe })
    const address = compileRecipe(recipe).address.toLowerCase() as Address

    await store.update(CHAIN_ID, address, (current) => ({
      ...current,
      everFunded: true,
      backoff: { failures: 3, nextAttemptAt: NOW + 60_000 },
      activations: [{ ref: `0x${'cd'.repeat(32)}`, status: 'reverted', at: NOW }],
    }))
    await unregisterDrop({ recipe, store, deployment: deployment(), now: NOW })

    await register({ store, recipe })

    const stored = await store.get(CHAIN_ID, address)
    expect(stored?.backoff).toEqual({ failures: 3, nextAttemptAt: NOW + 60_000 })
    expect(stored?.activations).toHaveLength(1)
    expect(stored?.everFunded).toBe(true)
  })

  it('comes back parked when its activation left a conditional order behind', async () => {
    // The TWAP case, and the reason this is not simply `status: 'watching'`. A TWAP drop holds its sell
    // balance for the whole schedule and spends it as the parts fill, so no balance-watching gate can
    // hold it: handing it back to the simulator would register a second TWAP over the remaining balance
    // or restart the schedule of the first. Nothing off-chain can tell a finished schedule from a
    // running one, so it stays out of the simulator's set entirely.
    const store = memoryStore()
    const recipe = twapRecipeJson()
    await register({ store, recipe })
    const address = compileRecipe(recipe).address.toLowerCase() as Address
    await store.update(CHAIN_ID, address, (current) => ({
      ...current,
      status: 'activated',
      everFunded: true,
      activations: [{ ref: `0x${'ef'.repeat(32)}`, status: 'confirmed', at: NOW, blockNumber: '1001' }],
    }))
    await unregisterDrop({ recipe, store, deployment: deployment(), now: NOW })

    const again = await register({ store, recipe })

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.drop.status).toBe('activated')
    expect(again.drop.retiredReason).toBeUndefined()
    // Back in the registry — a reload of the page can see it again — but not in the simulator's set.
    const stored = await store.get(CHAIN_ID, address)
    expect(stored?.status).toBe('activated')
    expect(await store.active(CHAIN_ID)).toHaveLength(1)
  })

  it('comes back armed when its activation signed a discrete order', async () => {
    // The other half. A `presignSellAll` drop's commitment ends at a deadline the keeper can read, so
    // parking it would make a reusable deposit address one that fires exactly once.
    const store = memoryStore()
    const recipe = recipeJson({ once: false })
    await register({ store, recipe })
    const address = compileRecipe(recipe).address.toLowerCase() as Address
    await store.update(CHAIN_ID, address, (current) => ({
      ...current,
      status: 'activated',
      everFunded: true,
      activations: [{ ref: `0x${'ef'.repeat(32)}`, status: 'confirmed', at: NOW, blockNumber: '1001' }],
    }))
    await unregisterDrop({ recipe, store, deployment: deployment(), now: NOW })

    const again = await register({ store, recipe })

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.drop.status).toBe('watching')
  })

  it('will not launder a spent `once` drop back into a live one', async () => {
    // Unregistering a drop that is already retired must not rewrite `once-consumed` into
    // `unregistered`, because only `unregistered` revives. Otherwise this pair is a resurrection
    // ritual for a drop the keeper had permanently given up on.
    const store = memoryStore()
    const recipe = recipeJson({ once: true })
    await register({ store, recipe })
    const address = compileRecipe(recipe).address.toLowerCase() as Address
    await store.update(CHAIN_ID, address, (current) => ({
      ...current,
      status: 'retired',
      retiredReason: 'once-consumed',
      activations: [{ ref: `0x${'ef'.repeat(32)}`, status: 'confirmed', at: NOW }],
    }))

    // Answers ok — there is nothing left to stop — but changes nothing.
    expect((await unregisterDrop({ recipe, store, deployment: deployment(), now: NOW })).ok).toBe(true)
    expect((await store.get(CHAIN_ID, address))?.retiredReason).toBe('once-consumed')

    const again = await register({ store, recipe })

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.drop.status).toBe('retired')
    expect(await store.active(CHAIN_ID)).toEqual([])
  })

  it('does not resurrect a drop retired for a reason of its own', async () => {
    // `once-consumed` cannot fire twice, so watching it again is polling for something that cannot
    // happen. Only a stop the recipe holder chose is undone.
    const store = memoryStore()
    const recipe = recipeJson()
    await register({ store, recipe })
    const address = compileRecipe(recipe).address.toLowerCase() as Address
    await store.update(CHAIN_ID, address, (current) => ({
      ...current,
      status: 'retired',
      retiredReason: 'once-consumed',
    }))

    const again = await register({ store, recipe })

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.drop.status).toBe('retired')
    expect(await store.active(CHAIN_ID)).toEqual([])
  })
})

describe('paying mode', () => {
  const KEEPER = '0x00000000000000000000000000000000000cafe0' as const

  function docWith(fee: unknown): string {
    return JSON.stringify({ version: '1.4.0', appCode: 'cow-drop', metadata: { partnerFee: fee } })
  }

  /** A recipe whose trading step commits to `document`'s hash. */
  function payingRecipe(document: string) {
    return recipeJson({
      steps: [
        {
          type: 'presignSellAll',
          sellToken: WXDAI,
          buyToken: '0x177127622c4A00F3d409B75571e12cB3c8973d3c',
          limitPrice: { price: '45', sellDecimals: 18, buyDecimals: 18 },
          validitySeconds: 1800,
          appData: appDataHash(document),
        },
      ],
    })
  }

  it('accepts a recipe whose appData promises the keeper a volume fee', async () => {
    const document = docWith({ volumeBps: 10, recipient: KEEPER })
    const result = await register({
      recipe: payingRecipe(document),
      appDataDocuments: [document],
      requireFeeFor: KEEPER,
      minFeeBps: 5,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.drop.fee).toMatchObject({ volumeBps: 10, recipient: KEEPER, sellToken: WXDAI.toLowerCase() })
    // Kept so the watch tower can upload it — the order book rejects a hash it has never seen.
    expect(result.drop.appDataDocuments?.[appDataHash(document)]).toBe(document)
  })

  it('refuses a recipe that promises the keeper nothing', async () => {
    const result = await register({ requireFeeFor: KEEPER, minFeeBps: 5 })

    expect(result).toMatchObject({ ok: false, error: 'no-fee', recipient: KEEPER })
  })

  it('refuses a fee below the minimum', async () => {
    const document = docWith({ volumeBps: 1, recipient: KEEPER })
    const result = await register({
      recipe: payingRecipe(document),
      appDataDocuments: [document],
      requireFeeFor: KEEPER,
      minFeeBps: 5,
    })

    expect(result).toMatchObject({ ok: false, error: 'no-fee' })
  })

  it('refuses a document the recipe did not commit to', async () => {
    // A fee in a document nobody signed is not a promise — the recipe commits to a hash, and only
    // the document behind that hash counts.
    const committed = docWith({ volumeBps: 10, recipient: KEEPER })
    const forged = docWith({ volumeBps: 500, recipient: KEEPER })

    const result = await register({
      recipe: payingRecipe(committed),
      appDataDocuments: [forged],
      requireFeeFor: KEEPER,
    })

    expect(result).toMatchObject({ ok: false, error: 'app-data-mismatch', supplied: appDataHash(forged) })
  })

  it('takes the documents without a fee requirement, for the watch tower to upload', async () => {
    // Even in `all` mode the order book needs the document, so it is stored regardless.
    const document = docWith({ volumeBps: 10, recipient: KEEPER })
    const result = await register({ recipe: payingRecipe(document), appDataDocuments: [document] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.drop.fee).toBeUndefined()
    expect(result.drop.appDataDocuments?.[appDataHash(document)]).toBe(document)
  })
})
