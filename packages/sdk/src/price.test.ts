import { describe, expect, it } from 'vitest'

import { CONVERT_HAIRCUT_BPS, convertMinimum, limitPriceToFraction } from './price.js'

describe('limitPriceToFraction', () => {
  it('reduces a same-decimals price to an exact fraction', () => {
    // 0.95 WXDAI-per-WXDAI-ish: both 18 decimals, so the decimals cancel out.
    expect(limitPriceToFraction('0.95', 18, 18)).toEqual({ numerator: 19n, denominator: 20n })
  })

  it('folds in a decimals mismatch', () => {
    // 1 COW (18 decimals) per USDC (6 decimals) is 1e12 atomic buy units per atomic sell unit.
    expect(limitPriceToFraction('1', 6, 18)).toEqual({ numerator: 10n ** 12n, denominator: 1n })
  })

  it('handles the reverse decimals direction', () => {
    expect(limitPriceToFraction('1', 18, 6)).toEqual({ numerator: 1n, denominator: 10n ** 12n })
  })

  it('keeps precision that a float would lose', () => {
    const { numerator, denominator } = limitPriceToFraction('0.1', 18, 18)
    expect(numerator).toBe(1n)
    expect(denominator).toBe(10n)
    // 0.1 + 0.2 !== 0.3 in floats; as an exact fraction there is nothing to lose.
    expect((3n * numerator) / denominator).toBe(0n)
  })

  it('accepts a leading-dot decimal', () => {
    expect(limitPriceToFraction('.5', 18, 18)).toEqual({ numerator: 1n, denominator: 2n })
  })

  it('is deterministic for equivalent spellings of the same price', () => {
    expect(limitPriceToFraction('0.50', 6, 18)).toEqual(limitPriceToFraction('0.5', 6, 18))
  })

  it.each(['', 'abc', '-1', '1e18', '1.2.3', '0'])('rejects %o', (price) => {
    expect(() => limitPriceToFraction(price, 18, 18)).toThrow()
  })
})

describe('convertMinimum', () => {
  it('takes the default haircut off the quote', () => {
    // 100 bps under 1000 is 990.
    expect(convertMinimum(1_000n)).toBe(990n)
    expect(CONVERT_HAIRCUT_BPS).toBe(100)
  })

  it('accepts the whole quote at a zero haircut', () => {
    expect(convertMinimum(1_000n, 0)).toBe(1_000n)
  })

  it('rounds down, so the minimum never exceeds what the quote supports', () => {
    // 999 * 9900 / 10000 = 989.01 → 989, not 990.
    expect(convertMinimum(999n, 100)).toBe(989n)
  })

  it('survives amounts that would overflow a float', () => {
    const huge = 10n ** 30n
    expect(convertMinimum(huge, 100)).toBe((huge * 9_900n) / 10_000n)
  })

  it('refuses a haircut that is not a whole number of bps under 100%', () => {
    for (const bps of [-1, 1.5, 10_000, 20_000]) {
      expect(() => convertMinimum(1_000n, bps)).toThrow(/haircutBps/)
    }
  })

  it('refuses to produce a zero minimum, which is an order anyone fills for nothing', () => {
    expect(() => convertMinimum(0n)).toThrow(/positive minimum/)
    // Rounding a dust quote down to nothing is the same failure, and is refused the same way.
    expect(() => convertMinimum(99n, 9_999)).toThrow(/positive minimum/)
  })
})
