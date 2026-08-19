import type { LimitPriceFraction } from './types.js'

/**
 * Convert a human limit price into the exact atomic-unit fraction the contracts apply.
 *
 * The contracts compute `buyAmount = sellAmount * numerator / denominator` on atomic amounts, so
 * the token decimals have to be folded in. Done as an exact integer fraction rather than a float:
 * the result is committed into a drop address, and a rounding difference between the UI and the
 * SDK would be a different address, not merely a slightly different price.
 *
 * @param price A decimal string of buy units per sell unit, in human terms (e.g. "0.95").
 */
export function limitPriceToFraction(price: string, sellDecimals: number, buyDecimals: number): LimitPriceFraction {
  const trimmed = price.trim()
  if (!/^\d*\.?\d+$/.test(trimmed)) {
    throw new Error(`limit price must be a non-negative decimal number, got: ${price}`)
  }

  const [whole, fraction = ''] = trimmed.split('.')
  const scaled = BigInt(`${whole || '0'}${fraction}`)
  if (scaled === 0n) {
    throw new Error('limit price must be greater than zero')
  }

  // price = scaled / 10^fraction.length, and atomic ratio = price * 10^buyDecimals / 10^sellDecimals
  let numerator = scaled * 10n ** BigInt(buyDecimals)
  let denominator = 10n ** BigInt(fraction.length) * 10n ** BigInt(sellDecimals)

  const divisor = gcd(numerator, denominator)
  numerator /= divisor
  denominator /= divisor

  return { numerator, denominator }
}

/**
 * Greatest common divisor, so the price is stored in its smallest terms rather than as two huge
 * powers of ten.
 */
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    ;[a, b] = [b, a % b]
  }
  return a === 0n ? 1n : a
}
