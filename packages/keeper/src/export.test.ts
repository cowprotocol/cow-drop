import { RECIPE_EXPORT_MAX_WINDOW_SECONDS, recipeExportTypedData } from '@cowprotocol/cow-drop-sdk'
import { describe, expect, it } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { verifyTypedData, type Address, type Hex } from 'viem'

import { createNonceLog, exportRecipes, type SignatureVerifier } from './export.js'
import { recipeJson, registered } from './fixtures.js'
import { memoryStore } from './store.js'

/**
 * The signature gate, which is the whole security of the endpoint.
 *
 * Signed with a real key and verified by viem rather than by a stub: a test whose verifier always
 * says yes proves only that the happy path is wired, and every check below is about the paths where
 * it must say no.
 */

const KEEPER: Address = '0x494b402C0656B1FC89D0A9522ae54047997687e0'
const CHAIN_ID = 100
const NOW = 1_800_000_000

// Generated per run rather than pinned. These only have to sign and verify inside one test, and a
// literal private key in the tree is something to explain forever — to a reader and to a scanner.
const owner = privateKeyToAccount(generatePrivateKey())
const other = privateKeyToAccount(generatePrivateKey())

/** The production shape: recover-or-1271, exactly as `service.ts` wires it. */
const verify: SignatureVerifier = async ({ owner: address, typedData, signature }) =>
  verifyTypedData({ address, ...typedData, signature })

function request(overrides: Partial<Parameters<typeof recipeExportTypedData>[0]> = {}) {
  return {
    owner: owner.address,
    keeper: KEEPER,
    scope: 'all',
    issuedAt: NOW - 10,
    expiresAt: NOW + 120,
    nonce: `0x${'11'.repeat(32)}` as Hex,
    ...overrides,
  }
}

async function sign(req: ReturnType<typeof request>, key = owner) {
  return key.signTypedData(recipeExportTypedData(req, CHAIN_ID))
}

async function storeWith(ownerAddress: Address) {
  const store = memoryStore()
  // Through `registered` so the stored address really is the hash of the stored recipe, which is what
  // a scoped export filters on.
  await store.put(registered({ recipe: recipeJson({ owner: ownerAddress }) }))
  return store
}

async function run(req: ReturnType<typeof request>, signature: Hex, store = undefined as never) {
  return exportRecipes({
    request: req,
    signature,
    store: store ?? (await storeWith(owner.address)),
    chainId: CHAIN_ID,
    keeper: KEEPER,
    verify,
    nonces: createNonceLog(),
    now: NOW,
  })
}

describe('exportRecipes', () => {
  it('returns the owner’s recipes for a valid signature', async () => {
    const req = request()
    const result = await run(req, await sign(req))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.drops).toHaveLength(1)
    expect(result.drops[0]!.recipe).toBeDefined()
  })

  it('refuses a signature from anyone but the owner', async () => {
    const req = request()
    // Signed by a different key, but still *claiming* to be the owner — the forgery that matters.
    const result = await run(req, await sign(req, other))

    expect(result).toMatchObject({ ok: false, error: 'bad-signature' })
  })

  it('refuses a signature naming a different keeper', async () => {
    const req = request({ keeper: '0x000000000000000000000000000000000000dead' })
    const result = await run(req, await sign(req))

    expect(result).toMatchObject({ ok: false, error: 'wrong-keeper' })
  })

  it('refuses an expired signature', async () => {
    const req = request({ issuedAt: NOW - 300, expiresAt: NOW - 1 })
    const result = await run(req, await sign(req))

    expect(result).toMatchObject({ ok: false, error: 'expired' })
  })

  it('refuses a window longer than the maximum, however it is signed', async () => {
    const req = request({ issuedAt: NOW, expiresAt: NOW + RECIPE_EXPORT_MAX_WINDOW_SECONDS + 1 })
    const result = await run(req, await sign(req))

    expect(result).toMatchObject({ ok: false, error: 'window-too-long' })
  })

  it('refuses the same signature twice', async () => {
    const req = request()
    const signature = await sign(req)
    const store = await storeWith(owner.address)
    const nonces = createNonceLog()
    const input = {
      request: req,
      signature,
      store,
      chainId: CHAIN_ID,
      keeper: KEEPER,
      verify,
      nonces,
      now: NOW,
    }

    expect((await exportRecipes(input)).ok).toBe(true)
    expect(await exportRecipes(input)).toMatchObject({ ok: false, error: 'replayed' })
  })

  it('does not return another account’s drops', async () => {
    const req = request()
    const store = await storeWith(other.address)
    const result = await exportRecipes({
      request: req,
      signature: await sign(req),
      store,
      chainId: CHAIN_ID,
      keeper: KEEPER,
      verify,
      nonces: createNonceLog(),
      now: NOW,
    })

    expect(result).toMatchObject({ ok: false, error: 'not-found' })
  })

  it('narrows to one drop when the scope names it', async () => {
    const store = await storeWith(owner.address)
    const [held] = await store.all(CHAIN_ID)
    const req = request({ scope: held!.address.toLowerCase() })
    const result = await exportRecipes({
      request: req,
      signature: await sign(req),
      store,
      chainId: CHAIN_ID,
      keeper: KEEPER,
      verify,
      nonces: createNonceLog(),
      now: NOW,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.drops.map((drop) => drop.address)).toEqual([held!.address])
  })

  it('refuses a scope that is neither `all` nor an address', async () => {
    const req = request({ scope: 'everything' })
    const result = await run(req, await sign(req))

    expect(result).toMatchObject({ ok: false, error: 'invalid-request' })
  })

  it('refuses a signature issued in the future', async () => {
    const req = request({ issuedAt: NOW + 3600, expiresAt: NOW + 3660 })
    const result = await run(req, await sign(req))

    expect(result).toMatchObject({ ok: false, error: 'invalid-request' })
  })
})

describe('createNonceLog', () => {
  it('forgets a nonce once its window has passed, bounding the map by the window', () => {
    const nonces = createNonceLog()
    const nonce = `0x${'22'.repeat(32)}` as Hex

    expect(nonces.claim(nonce, NOW + 60, NOW)).toBe(true)
    expect(nonces.claim(nonce, NOW + 60, NOW)).toBe(false)
    // Past its expiry it is pruned — and a signature that old is refused by the expiry check anyway,
    // so forgetting it costs nothing.
    expect(nonces.claim(nonce, NOW + 500, NOW + 61)).toBe(true)
  })
})
