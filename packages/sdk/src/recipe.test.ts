import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'

import { decodeRecipe, saltOf } from './encoding.js'
import { compileRecipe, type DropRecipeJson } from './recipe.js'
import { swapOnArrival, twapOnArrival } from './templates.js'

const OWNER: Address = '0x1111111111111111111111111111111111111111'
const WXDAI: Address = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'
const COW: Address = '0x177127622c4A00F3d409B75571e12cB3c8973d3c'
const GNOSIS = 100

function swapRecipe(): DropRecipeJson {
  return swapOnArrival({
    chainId: GNOSIS,
    owner: OWNER,
    sellToken: WXDAI,
    buyToken: COW,
    limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
  })
}

describe('compileRecipe', () => {
  it('produces an address, the committed bytes, and the calls', () => {
    const compiled = compileRecipe(swapRecipe())

    expect(compiled.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(compiled.setupData.startsWith('0x')).toBe(true)
    expect(compiled.recipe.calls).toHaveLength(1)
    // Every recipe primitive must be a delegatecall, or it would read the helper's balance.
    expect(compiled.recipe.calls[0]!.isDelegateCall).toBe(true)
    expect(compiled.recipe.calls[0]!.target).toBe(compiled.deployment.recipes)
  })

  it('is deterministic regardless of JSON key order or formatting', () => {
    const a = compileRecipe(swapRecipe())

    // Same recipe with every object's keys in reverse order, as a hand-edited or re-serialised file
    // might be. The address must not move.
    //
    // Deliberately not done with a `JSON.stringify` key allowlist: that silently *drops* any key not
    // listed, so it would quietly stop covering fields added later — which is exactly what happened
    // when `receiver` gained a default.
    const b = compileRecipe(reverseKeys(swapRecipe()) as DropRecipeJson)

    expect(b.setupData).toBe(a.setupData)
    expect(b.address).toBe(a.address)
  })

  it('survives an export/import round trip through JSON text', () => {
    const original = swapRecipe()
    const roundTripped = JSON.parse(JSON.stringify(original)) as DropRecipeJson

    expect(compileRecipe(roundTripped).address).toBe(compileRecipe(original).address)
  })

  it('accepts an explicit fraction and a human price interchangeably', () => {
    const human = compileRecipe(swapRecipe())
    const explicit = compileRecipe({
      ...swapRecipe(),
      steps: [
        {
          type: 'presignSellAll',
          sellToken: WXDAI,
          buyToken: COW,
          // The template defaults this to the owner; spell it out to isolate the price.
          receiver: OWNER,
          // 0.02 with equal decimals reduces to 1/50.
          limitPrice: { numerator: '1', denominator: '50' },
          validitySeconds: 30 * 60,
        },
      ],
    })

    expect(explicit.address).toBe(human.address)
  })

  it('moves the address when anything in the recipe changes', () => {
    const base = compileRecipe(swapRecipe()).address

    const differentLabel = compileRecipe({ ...swapRecipe(), label: 'something else' }).address
    const differentOwner = compileRecipe({
      ...swapRecipe(),
      owner: '0x2222222222222222222222222222222222222222',
    }).address
    const differentOnce = compileRecipe({ ...swapRecipe(), once: true }).address
    const differentPrice = compileRecipe(
      swapOnArrival({
        chainId: GNOSIS,
        owner: OWNER,
        sellToken: WXDAI,
        buyToken: COW,
        limitPrice: { price: '0.03', sellDecimals: 18, buyDecimals: 18 },
      }),
    ).address

    expect(new Set([base, differentLabel, differentOwner, differentOnce, differentPrice]).size).toBe(5)
  })

  it('refuses allowFailure in a once recipe, which anyone could otherwise spend', () => {
    expect(() =>
      compileRecipe({
        ...swapRecipe(),
        once: true,
        steps: [{ type: 'approveMax', token: WXDAI, spender: COW, allowFailure: true }],
      }),
    ).toThrow(/could be spent by anyone/)
  })

  it('allows allowFailure in a reusable recipe', () => {
    expect(() =>
      compileRecipe({
        ...swapRecipe(),
        once: false,
        steps: [{ type: 'approveMax', token: WXDAI, spender: COW, allowFailure: true }],
      }),
    ).not.toThrow()
  })

  it('compiles guards and keeps them non-optional', () => {
    const compiled = compileRecipe({
      ...swapRecipe(),
      steps: [
        { type: 'requireMinBalance', token: WXDAI, minAmount: '1000000000000000000000' },
        { type: 'requireTimeWindow', notBefore: '2000000000' },
        ...swapRecipe().steps,
      ],
    })

    expect(compiled.recipe.calls).toHaveLength(3)
    // A guard that could be skipped is not a guard.
    expect(compiled.recipe.calls.slice(0, 2).every((call) => !call.allowFailure)).toBe(true)
    expect(compiled.recipe.calls.slice(0, 2).every((call) => call.isDelegateCall)).toBe(true)
  })

  it('rejects a degenerate guard rather than silently compiling a no-op', () => {
    expect(() =>
      compileRecipe({ ...swapRecipe(), steps: [{ type: 'requireTimeWindow' }, ...swapRecipe().steps] }),
    ).toThrow(/at least one of notBefore or notAfter/)
    expect(() =>
      compileRecipe({
        ...swapRecipe(),
        steps: [{ type: 'requireMinBalance', token: WXDAI, minAmount: '0' }, ...swapRecipe().steps],
      }),
    ).toThrow(/positive minAmount/)
  })

  it('twapOnArrival puts a minAmount guard ahead of the schedule', () => {
    const recipe = twapOnArrival({
      chainId: GNOSIS,
      owner: OWNER,
      sellToken: WXDAI,
      buyToken: COW,
      parts: 12,
      partDuration: 3600,
      limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
      minAmount: 1000n * 10n ** 18n,
    })

    expect(recipe.steps.map((s) => s.type)).toEqual(['requireMinBalance', 'twapFromBalance'])
    expect(recipe.once).toBe(true)
  })

  it('gives the same recipe a different address per salt', () => {
    const base = compileRecipe(swapRecipe()).address
    const one = compileRecipe({ ...swapRecipe(), salt: `0x${'00'.repeat(31)}01` }).address
    const max = compileRecipe({ ...swapRecipe(), salt: `0x${'ff'.repeat(32)}` }).address

    expect(new Set([base, one, max]).size).toBe(3)
  })

  it('treats an omitted salt as zero', () => {
    expect(compileRecipe({ ...swapRecipe(), salt: `0x${'00'.repeat(32)}` }).address).toBe(
      compileRecipe(swapRecipe()).address,
    )
  })

  it('round-trips the salt through the committed bytes', () => {
    const salt = `0x${'ab'.repeat(32)}` as const
    const { setupData } = compileRecipe({ ...swapRecipe(), salt })

    expect(saltOf(setupData)).toBe(salt)
    expect(decodeRecipe(setupData).salt).toBe(salt)
  })

  it.each(['0x01', '0xnothex', `0x${'00'.repeat(33)}`, '1'])('rejects malformed salt %o', (salt) => {
    expect(() => compileRecipe({ ...swapRecipe(), salt: salt as `0x${string}` })).toThrow(/32-byte hex/)
  })

  it('rejects a recipe with no steps', () => {
    expect(() => compileRecipe({ ...swapRecipe(), steps: [] })).toThrow(/at least one step/)
  })

  it('rejects an unsupported version', () => {
    expect(() => compileRecipe({ ...swapRecipe(), version: 2 as 1 })).toThrow(/unsupported recipe version/)
  })

  it('rejects a chain with no deployment', () => {
    expect(() => compileRecipe({ ...swapRecipe(), chainId: 999999 })).toThrow(/not deployed on chain/)
  })
})

describe('templates', () => {
  it('swapOnArrival prepends a wrap step for a natively funded drop', () => {
    const recipe = swapOnArrival({
      chainId: GNOSIS,
      owner: OWNER,
      sellToken: WXDAI,
      buyToken: COW,
      limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
      wrapNative: WXDAI,
    })

    expect(recipe.steps.map((s) => s.type)).toEqual(['wrapNative', 'presignSellAll'])
    expect(compileRecipe(recipe).recipe.calls).toHaveLength(2)
  })

  it('swapOnArrival stays reusable, twapOnArrival does not', () => {
    const swap = swapOnArrival({
      chainId: GNOSIS,
      owner: OWNER,
      sellToken: WXDAI,
      buyToken: COW,
      limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
    })
    const twap = twapOnArrival({
      chainId: GNOSIS,
      owner: OWNER,
      sellToken: WXDAI,
      buyToken: COW,
      parts: 12,
      partDuration: 3600,
      limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
    })

    // Re-running a swap processes newly arrived funds; re-running a TWAP would register a second
    // overlapping schedule, so it is one-shot.
    expect(swap.once).toBe(false)
    expect(twap.once).toBe(true)
  })

  it('defaults the receiver to the owner, not the drop', () => {
    // Proceeds should land in the owner's wallet; leaving them in the drop would need a second
    // transaction to get out, which is the wrong default for "drop it in and the cow does the rest".
    for (const recipe of [
      swapOnArrival({
        chainId: GNOSIS,
        owner: OWNER,
        sellToken: WXDAI,
        buyToken: COW,
        limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
      }),
      twapOnArrival({
        chainId: GNOSIS,
        owner: OWNER,
        sellToken: WXDAI,
        buyToken: COW,
        parts: 4,
        partDuration: 3600,
        limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
      }),
    ]) {
      const step = recipe.steps.find((s) => 'receiver' in s)
      expect(step && 'receiver' in step ? step.receiver : undefined).toBe(OWNER)
    }
  })

  it('honours an explicit receiver, including the keep-in-the-drop sentinel', () => {
    const elsewhere = '0x3333333333333333333333333333333333333333' as Address
    const zero = '0x0000000000000000000000000000000000000000' as Address

    const named = swapOnArrival({
      chainId: GNOSIS,
      owner: OWNER,
      sellToken: WXDAI,
      buyToken: COW,
      receiver: elsewhere,
      limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
    })
    const kept = swapOnArrival({
      chainId: GNOSIS,
      owner: OWNER,
      sellToken: WXDAI,
      buyToken: COW,
      receiver: zero,
      limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
    })

    expect(named.steps.find((s) => 'receiver' in s && s.receiver === elsewhere)).toBeTruthy()
    expect(kept.steps.find((s) => 'receiver' in s && s.receiver === zero)).toBeTruthy()
    // And each is a different drop, since the receiver is part of the commitment.
    expect(compileRecipe(named).address).not.toBe(compileRecipe(kept).address)
  })

  it('rejects a TWAP with fewer than two parts', () => {
    expect(() =>
      compileRecipe(
        twapOnArrival({
          chainId: GNOSIS,
          owner: OWNER,
          sellToken: WXDAI,
          buyToken: COW,
          parts: 1,
          partDuration: 3600,
          limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
        }),
      ),
    ).toThrow(/at least 2 parts/)
  })

  it('rejects a span longer than the part duration', () => {
    expect(() =>
      compileRecipe(
        twapOnArrival({
          chainId: GNOSIS,
          owner: OWNER,
          sellToken: WXDAI,
          buyToken: COW,
          parts: 4,
          partDuration: 600,
          span: 900,
          limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
        }),
      ),
    ).toThrow(/span cannot exceed/)
  })
})

/** Deep-copy a value with every object's keys in reverse order, preserving all of them. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, inner]) => [key, reverseKeys(inner)]),
    )
  }
  return value
}
