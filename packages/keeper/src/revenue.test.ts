import type { Address } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { manualClock } from './fixtures.js'
import { asFraction, feeValueWei, orderBookPrices } from './revenue.js'

const USDC: Address = '0x2222222222222222222222222222222222222222'

describe('asFraction', () => {
  it('represents a value exactly, though not in lowest terms', () => {
    // The fraction is not reduced — it does not need to be, since it is only ever multiplied through.
    const two = asFraction(2)
    expect(two.num / two.den).toBe(2n)

    const half = asFraction(0.5)
    expect((100n * half.num) / half.den).toBe(50n)
  })

  it('keeps twelve significant figures for a large price', () => {
    // The reason this exists: `bigint * float` has to go through Number, which loses everything past
    // 2^53 — and a native price for a 6-decimal token is around 1e9.
    const { num, den } = asFraction(3.33333333333e8)
    expect(Number(num) / Number(den)).toBeCloseTo(3.33333333333e8, -1)
  })

  it('treats a missing or nonsensical price as nothing, not as a crash', () => {
    expect(asFraction(0)).toEqual({ num: 0n, den: 1n })
    expect(asFraction(-1)).toEqual({ num: 0n, den: 1n })
    expect(asFraction(Number.NaN)).toEqual({ num: 0n, den: 1n })
  })
})

describe('feeValueWei', () => {
  it('values a volume fee at the documented convention', () => {
    // 1000 USDC (6 decimals), 10 bps, at a price where one atomic unit is 1e9 wei.
    // fee = 1000e6 * 10/10000 = 1e6 atomic; × 1e9 = 1e15 wei.
    expect(feeValueWei({ sellAmount: 1000n * 10n ** 6n, volumeBps: 10, nativePrice: 1e9 })).toBe(10n ** 15n)
  })

  it('scales with the amount and with the bps', () => {
    const base = feeValueWei({ sellAmount: 10n ** 18n, volumeBps: 10, nativePrice: 1 })
    expect(feeValueWei({ sellAmount: 2n * 10n ** 18n, volumeBps: 10, nativePrice: 1 })).toBe(base * 2n)
    expect(feeValueWei({ sellAmount: 10n ** 18n, volumeBps: 20, nativePrice: 1 })).toBe(base * 2n)
  })

  it('is zero for no fee or no volume', () => {
    expect(feeValueWei({ sellAmount: 10n ** 18n, volumeBps: 0, nativePrice: 1 })).toBe(0n)
    expect(feeValueWei({ sellAmount: 0n, volumeBps: 10, nativePrice: 1 })).toBe(0n)
  })

  it('does not lose precision on a wei-scale amount', () => {
    // A million ether at 1 bps is 100 ether — a number no float could carry exactly.
    const value = feeValueWei({ sellAmount: 10n ** 24n, volumeBps: 1, nativePrice: 1 })
    expect(value).toBe(10n ** 20n)
  })
})

describe('orderBookPrices', () => {
  it('asks the order book once per token per ttl', () => {
    const clock = manualClock()
    const getNativePrice = vi.fn(async () => ({ price: 1e9 }))
    const prices = orderBookPrices({ getNativePrice }, { ttlMs: 60_000, now: clock.now })

    return (async () => {
      expect(await prices.nativePrice(USDC)).toBe(1e9)
      expect(await prices.nativePrice(USDC)).toBe(1e9)
      expect(getNativePrice).toHaveBeenCalledTimes(1)

      clock.advance(61_000)
      await prices.nativePrice(USDC)
      expect(getNativePrice).toHaveBeenCalledTimes(2)
    })()
  })

  it('reports a token it cannot price as undefined, and does not retry it every drop', async () => {
    // Undefined is a refusal, not a zero: unpriceable is "we cannot say", not "worthless".
    const getNativePrice = vi.fn(async () => Promise.reject(new Error('no route')))
    const prices = orderBookPrices({ getNativePrice }, { now: manualClock().now })

    expect(await prices.nativePrice(USDC)).toBeUndefined()
    expect(await prices.nativePrice(USDC)).toBeUndefined()
    expect(getNativePrice).toHaveBeenCalledTimes(1)
  })

  it('passes through a response with no price at all', async () => {
    const prices = orderBookPrices({ getNativePrice: async () => ({}) })
    expect(await prices.nativePrice(USDC)).toBeUndefined()
  })
})
