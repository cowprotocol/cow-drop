import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'

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

    // Same recipe, keys written in a different order — as a hand-edited or re-serialised file
    // would be. The address must not move.
    const reordered = JSON.parse(
      JSON.stringify(swapRecipe(), ['steps', 'type', 'sellToken', 'buyToken', 'limitPrice', 'price', 'sellDecimals', 'buyDecimals', 'validitySeconds', 'owner', 'chainId', 'label', 'once', 'version']),
    ) as DropRecipeJson
    const b = compileRecipe(reordered)

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
