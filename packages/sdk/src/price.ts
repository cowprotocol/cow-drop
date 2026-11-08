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

/** The slippage the UI adds to what it asks a payer to send to a payment drop: 50 bps. */
export const PAYMENT_SLIPPAGE_BPS = 50

/** How far under the market a convert activation sets its minimum, unless told otherwise: 100 bps. */
export const CONVERT_HAIRCUT_BPS = 100

/**
 * The least a convert activation will accept, from a CoW **sell** quote for the drop's balance.
 *
 * A convert recipe commits no price, so this number *is* the price protection, and both activators —
 * the panel and the keeper — must compute it the same way or the keeper would undercut what the UI
 * showed. Rounded down, so the minimum is never nudged above what the quote actually supports.
 *
 * Zero is refused rather than clamped: an order anyone may fill for nothing is not a price, and the
 * step reverts on it anyway.
 */
export function convertMinimum(buyAmount: bigint, haircutBps: number = CONVERT_HAIRCUT_BPS): bigint {
  if (!Number.isInteger(haircutBps) || haircutBps < 0 || haircutBps >= 10_000) {
    throw new Error(`haircutBps must be an integer in [0, 10000), got: ${haircutBps}`)
  }
  const minimum = (buyAmount * BigInt(10_000 - haircutBps)) / 10_000n
  if (minimum <= 0n) {
    throw new Error('a convert activation needs a positive minimum; this quote and haircut leave none')
  }
  return minimum
}

/**
 * How much of a token pays for a payment drop, from a CoW **buy** quote for the drop's `buyAmount`.
 *
 * The order the drop places is fee-less (`feeAmount: 0`), so the network fee comes out of the sell
 * amount: what has to arrive is the quote's `sellAmount` *plus* its `feeAmount`. `slippageBps` is
 * added on top and rounded up.
 *
 * The two callers use it differently on purpose. The UI asks the payer for `PAYMENT_SLIPPAGE_BPS`
 * extra; the keeper accepts a payment at `0`. The gap is the cushion that absorbs the price moving
 * between the payer's quote and the keeper's, and since the drop sells its whole balance in a sell
 * order, whatever the cushion does not use reaches the receiver as surplus.
 */
export function requiredPayment(
  quote: { sellAmount: bigint; feeAmount: bigint },
  slippageBps: number = PAYMENT_SLIPPAGE_BPS,
): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0) {
    throw new Error(`slippageBps must be a non-negative integer, got: ${slippageBps}`)
  }
  const base = quote.sellAmount + quote.feeAmount
  const scaled = base * BigInt(10_000 + slippageBps)
  return (scaled + 9_999n) / 10_000n
}
