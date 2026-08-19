import type { Address } from 'viem'

/**
 * What a token is worth in the chain's own currency.
 *
 * `undefined` means the order book could not price it, which is a refusal rather than a zero — an
 * unpriceable token is one we cannot say is worth subsidising, not one we know is worthless.
 */
export interface PriceOracle {
  nativePrice(token: Address): Promise<number | undefined>
}

/**
 * The order book's native price, cached for a tick's worth of time.
 *
 * The API is rate-limited and a tick may ask about the same token many times, so this collapses that
 * to one request per token per `ttlMs`.
 */
export function orderBookPrices(
  api: { getNativePrice(token: Address): Promise<{ price?: number }> },
  options: { ttlMs?: number; now?: () => number } = {},
): PriceOracle {
  const ttlMs = options.ttlMs ?? 60_000
  const now = options.now ?? Date.now
  const cache = new Map<string, { at: number; price: number | undefined }>()

  return {
    async nativePrice(token) {
      const key = token.toLowerCase()
      const hit = cache.get(key)
      if (hit && now() - hit.at < ttlMs) return hit.price

      let price: number | undefined
      try {
        price = (await api.getNativePrice(token)).price
      } catch {
        // A token the order book will not price. Cached as `undefined` so a tick does not retry it
        // for every drop that mentions it.
        price = undefined
      }

      cache.set(key, { at: now(), price })
      return price
    },
  }
}

/**
 * A float as an exact fraction, to about twelve significant figures.
 *
 * The order book returns the native price as a JSON `number`, and multiplying a wei-scale bigint by a
 * float means going through `Number` and losing everything past 2^53. Twelve figures is far more
 * precision than an estimate needs and costs nothing.
 */
export function asFraction(value: number): { num: bigint; den: bigint } {
  if (!Number.isFinite(value) || value <= 0) return { num: 0n, den: 1n }

  const [mantissa = '0', exponent = '0'] = value.toExponential(12).split('e')
  const digits = BigInt(mantissa.replace('.', ''))
  const scale = Number(exponent) - 12

  return scale >= 0 ? { num: digits * 10n ** BigInt(scale), den: 1n } : { num: digits, den: 10n ** BigInt(-scale) }
}

/**
 * What a volume fee on this trade is worth, in wei of the chain's own currency.
 *
 * ## The unit convention, which decides money
 *
 * CoW's native price converts **atomic token units to wei**: `wei = atomicAmount × price`. So for a
 * 6-decimal token worth a thousandth of the native coin, `price` is around `1e18 / 1e6 / 1000 = 1e9`.
 *
 * That convention is not spelled out in the SDK's types — `NativePriceResponse` is just
 * `{ price?: number }` — so **confirm it against the live API before turning the `paying` mode on
 * with real money**. Run the keeper in `--dry-run` first: it logs the estimated revenue beside the
 * gas cost for every drop it considers, which makes a wrong convention obvious by several orders of
 * magnitude rather than subtly expensive.
 */
export function feeValueWei(params: { sellAmount: bigint; volumeBps: number; nativePrice: number }): bigint {
  const { sellAmount, volumeBps, nativePrice } = params
  if (volumeBps <= 0 || sellAmount <= 0n) return 0n

  const feeAtomic = (sellAmount * BigInt(Math.round(volumeBps))) / 10_000n
  const price = asFraction(nativePrice)
  return (feeAtomic * price.num) / price.den
}
