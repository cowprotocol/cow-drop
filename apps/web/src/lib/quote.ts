import {
  CONVERT_HAIRCUT_BPS,
  convertMinimum,
  PAYMENT_SLIPPAGE_BPS,
  requiredPayment,
} from '@cowprotocol/cow-drop-sdk'
import {
  OrderQuoteSideKindBuy,
  OrderQuoteSideKindSell,
  SigningScheme,
  type OrderQuoteRequest,
} from '@cowprotocol/cow-sdk'
import type { Address } from 'viem'

import { describeOrderBookError, getOrderBookApi } from './chain.js'

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
  chainId: number
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

  // `describeOrderBookError` rather than the raw failure: the SDK's message is empty for an API
  // error, so an unwrapped rejection reaches the UI as a banner with nothing in it.
  const { quote } = await getOrderBookApi(params.chainId)
    .getQuote(request)
    .catch((cause: unknown) => {
      throw new Error(describeOrderBookError(cause), { cause })
    })

  const sellAmount = BigInt(quote.sellAmount)
  const buyAmount = BigInt(quote.buyAmount)

  return {
    price: formatPrice(sellAmount, buyAmount, params.sellDecimals, params.buyDecimals),
    sellAmount,
    buyAmount,
    feeAmount: BigInt(quote.feeAmount),
  }
}

/** What a payer should send to a payment drop, in one token. */
export interface PaymentQuote {
  /** What to ask the payer for: the market cost plus `PAYMENT_SLIPPAGE_BPS`, rounded up. */
  send: bigint
  /** The market cost alone — the least the keeper will accept as covering the price. */
  atMarket: bigint
  /** When this was quoted, in ms. With `expiresAt`, what a countdown measures against. */
  quotedAt: number
  /**
   * When the order book stops standing behind this quote, in ms — its `expiration`. `null` for a
   * payment in the price token itself, which is a fixed amount and never goes stale.
   */
  expiresAt: number | null
}

/** If the order book's `expiration` cannot be read, treat a quote as good for this long. */
const FALLBACK_QUOTE_LIFETIME_MS = 60_000

/**
 * How much of `sellToken` pays a payment drop, from a **buy** quote for its price.
 *
 * Quoted as the drop, pre-signed, paying `receiver` — exactly the order the drop will place, so the
 * fee in the quote is the fee that order pays. The payer is asked for 50 bps more than the market:
 * that cushion absorbs the price moving before the order is placed, and since the drop sells its
 * whole balance, whatever the cushion does not use reaches the receiver as surplus.
 */
export async function quotePayment(params: {
  sellToken: Address
  buyToken: Address
  buyAmount: bigint
  drop: Address
  receiver: Address
  chainId: number
}): Promise<PaymentQuote> {
  if (params.sellToken.toLowerCase() === params.buyToken.toLowerCase()) {
    // Paid in the token the owner wants: no trade, the drop forwards it.
    return { send: params.buyAmount, atMarket: params.buyAmount, quotedAt: Date.now(), expiresAt: null }
  }

  const request: OrderQuoteRequest = {
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    from: params.drop,
    receiver: params.receiver,
    kind: OrderQuoteSideKindBuy.BUY,
    buyAmountAfterFee: params.buyAmount.toString(),
    validFor: 30 * 60,
    signingScheme: SigningScheme.PRESIGN,
  }

  const { quote, expiration } = await getOrderBookApi(params.chainId)
    .getQuote(request)
    .catch((cause: unknown) => {
      throw new Error(describeOrderBookError(cause), { cause })
    })

  const amounts = { sellAmount: BigInt(quote.sellAmount), feeAmount: BigInt(quote.feeAmount) }
  const quotedAt = Date.now()
  const expires = Date.parse(expiration)
  return {
    send: requiredPayment(amounts, PAYMENT_SLIPPAGE_BPS),
    atMarket: requiredPayment(amounts, 0),
    quotedAt,
    // An expiry already past (clock skew) or unreadable falls back rather than re-quoting in a loop.
    expiresAt: Number.isFinite(expires) && expires > quotedAt ? expires : quotedAt + FALLBACK_QUOTE_LIFETIME_MS,
  }
}

/** What a convert activation would place, from a sell quote for the drop's whole balance. */
export interface ConvertQuote {
  /** The balance the quote was taken for, which is the order's sell amount. */
  sellAmount: bigint
  /** What the market pays for it right now. */
  atMarket: bigint
  /** The order's minimum: `atMarket` less the haircut. What actually gets committed. */
  minimum: bigint
  quotedAt: number
  /** When the order book stops standing behind this, in ms. `null` when no trade is involved. */
  expiresAt: number | null
}

/**
 * What a convert drop would sell its balance for, as the order it is about to place.
 *
 * The mirror of `quotePayment`, and deliberately the same shape: a convert recipe commits no price,
 * so the number that protects it has to come from a live quote rather than from the recipe. Quoted as
 * the drop, pre-signed, paying `receiver` — exactly the order `activateConvert` will place, so the
 * fee in the quote is the fee that order pays.
 *
 * The amount is the balance rather than a reference, because here the balance is known: whatever has
 * arrived is what gets sold.
 */
export async function quoteConvert(params: {
  sellToken: Address
  buyToken: Address
  /** The drop's balance of `sellToken`. */
  sellAmount: bigint
  drop: Address
  receiver: Address
  chainId: number
  haircutBps?: number
}): Promise<ConvertQuote> {
  const haircutBps = params.haircutBps ?? CONVERT_HAIRCUT_BPS

  if (params.sellToken.toLowerCase() === params.buyToken.toLowerCase()) {
    // Already in the buy token: the step forwards it untraded, so there is no price and nothing to expire.
    return {
      sellAmount: params.sellAmount,
      atMarket: params.sellAmount,
      minimum: params.sellAmount,
      quotedAt: Date.now(),
      expiresAt: null,
    }
  }

  const request: OrderQuoteRequest = {
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    from: params.drop,
    receiver: params.receiver,
    kind: OrderQuoteSideKindSell.SELL,
    sellAmountBeforeFee: params.sellAmount.toString(),
    validFor: 30 * 60,
    signingScheme: SigningScheme.PRESIGN,
  }

  const { quote, expiration } = await getOrderBookApi(params.chainId)
    .getQuote(request)
    .catch((cause: unknown) => {
      throw new Error(describeOrderBookError(cause), { cause })
    })

  const atMarket = BigInt(quote.buyAmount)
  const quotedAt = Date.now()
  const expires = Date.parse(expiration)
  return {
    sellAmount: params.sellAmount,
    atMarket,
    minimum: convertMinimum(atMarket, haircutBps),
    quotedAt,
    // An expiry already past (clock skew) or unreadable falls back rather than re-quoting in a loop.
    expiresAt: Number.isFinite(expires) && expires > quotedAt ? expires : quotedAt + FALLBACK_QUOTE_LIFETIME_MS,
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
