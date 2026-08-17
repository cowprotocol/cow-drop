import { OrderQuoteSideKindSell, SigningScheme, type OrderQuoteRequest } from '@cowprotocol/cow-sdk'
import type { Address } from 'viem'

import { orderBookApi } from './chain.js'

export interface MarketQuote {
  /** Human price, buy units per sell unit, as a decimal string ready for `limitPriceToFraction`. */
  price: string
  sellAmount: bigint
  buyAmount: bigint
  feeAmount: bigint
}

/**
 * Ask the CoW API what the market is currently paying, so a limit price can be set from something
 * real instead of guessed.
 *
 * A drop cannot know its amount in advance, so the quote is for a *reference* amount and only its
 * price is used. That amount still matters: quote too little and the fee dominates, making the price
 * look far worse than it is. Hence the reference amount is a visible input rather than a constant
 * nobody can see.
 */
export async function quoteMarketPrice(params: {
  sellToken: Address
  buyToken: Address
  sellAmount: bigint
  sellDecimals: number
  buyDecimals: number
  /** The address the quote is attributed to. */
  from: Address
}): Promise<MarketQuote> {
  const request: OrderQuoteRequest = {
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    from: params.from,
    kind: OrderQuoteSideKindSell.SELL,
    sellAmountBeforeFee: params.sellAmount.toString(),
    validFor: 30 * 60,
    // The drop signs on-chain, so quote it the way it will actually be settled.
    signingScheme: SigningScheme.PRESIGN,
  }

  const { quote } = await orderBookApi.getQuote(request)

  const sellAmount = BigInt(quote.sellAmount)
  const buyAmount = BigInt(quote.buyAmount)

  return {
    price: formatPrice(sellAmount, buyAmount, params.sellDecimals, params.buyDecimals),
    sellAmount,
    buyAmount,
    feeAmount: BigInt(quote.feeAmount),
  }
}

const PRICE_DECIMALS = 10

/**
 * Buy units per sell unit, as an exact-as-possible decimal string.
 *
 * Done in integer arithmetic: the result is fed to `limitPriceToFraction` and ends up committed into
 * a drop address, so float rounding here would be a rounding difference in an address.
 */
export function formatPrice(
  sellAmount: bigint,
  buyAmount: bigint,
  sellDecimals: number,
  buyDecimals: number,
): string {
  if (sellAmount === 0n) throw new Error('cannot derive a price from a zero sell amount')

  // price = (buy / 10^buyDec) / (sell / 10^sellDec), scaled up so we can read off the decimals.
  const scale = 10n ** BigInt(PRICE_DECIMALS)
  const scaled = (buyAmount * 10n ** BigInt(sellDecimals) * scale) / (sellAmount * 10n ** BigInt(buyDecimals))

  const whole = scaled / scale
  const fraction = (scaled % scale).toString().padStart(PRICE_DECIMALS, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : `${whole}`
}

/**
 * Apply a slippage haircut to a price, keeping it an exact decimal string.
 *
 * The result gains four decimal places rather than keeping the input's: a haircut in basis points
 * needs them. Preserving the input's precision instead truncates, and badly — `45` less 1% came out
 * as `44`, not `44.55`.
 */
export function applySlippage(price: string, percent: number): string {
  const [whole, fraction = ''] = price.split('.')
  const scaled = BigInt(`${whole || '0'}${fraction}`)
  const basisPoints = BigInt(Math.round((100 - percent) * 100))

  // scaled is price * 10^digits; multiplying by basis points gives price * 10^(digits + 4).
  const reduced = scaled * basisPoints
  const digits = fraction.length + 4

  const asString = reduced.toString().padStart(digits + 1, '0')
  const head = asString.slice(0, asString.length - digits)
  const tail = asString.slice(asString.length - digits).replace(/0+$/, '')
  return tail ? `${head}.${tail}` : head
}
