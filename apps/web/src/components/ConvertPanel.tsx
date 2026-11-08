import {
  CONVERT_HAIRCUT_BPS,
  convertMinimum,
  type DropDeployment,
  type DropRecipeJson,
  type DropStepJson,
} from '@cowprotocol/cow-drop-sdk'
import { formatUnits, type Address } from 'viem'
import { useCallback, useEffect, useState } from 'react'

import { activateConvertDrop, postPlacedOrders, readNativeBalance, readTokenBalance } from '../lib/drop.js'
import { quoteConvert, type ConvertQuote } from '../lib/quote.js'
import { keeperConvertHaircutBps } from '../lib/keeper.js'
import { isUserRejection, switchChain, walletChainId, wrappedNative } from '../lib/chain.js'
import { findToken, type TokenInfo } from '../lib/tokenList.js'
import { TokenPicker } from './TokenPicker.js'
import { Tooltip } from './Tooltip.js'

type ConvertStep = Extract<DropStepJson, { type: 'convert' }>

const ZERO: Address = '0x0000000000000000000000000000000000000000'

/** Re-quote this long before the order book's expiry, so the minimum on screen is never a lapsed one. */
const REFRESH_LEAD_MS = 3_000
/** After a failed quote, try again this soon. */
const RETRY_MS = 15_000
/** An arrival already in the buy token has no quote to expire; its balance is re-read this often. */
const FIXED_REFRESH_MS = 30_000

/** The convert step of a recipe, if it has one. */
export function convertStepOf(recipe: DropRecipeJson): ConvertStep | undefined {
  return recipe.steps.find((step): step is ConvertStep => step.type === 'convert')
}

/**
 * "Convert": name this activation's price and run it.
 *
 * A convert recipe commits to no price, so the minimum is a live quote rather than a number in the
 * recipe — the same shape as `PaymentPanel`, for the same reason. The order sells the drop's whole
 * balance, so the quote is taken for that balance and the minimum is what the market pays less a
 * haircut.
 *
 * The quote carries the order book's own expiry. The panel counts it down and re-quotes just before
 * it lapses, so the minimum offered is always one the market still stands behind — a stale one would
 * either undercut the price or name a minimum no solver will fill.
 *
 * Nothing on-chain checks that minimum, which is why only the committed pricer (or the owner) may
 * activate, and why a zero pricer is shown as the deliberate opt-out it is.
 */
export function ConvertPanel({
  recipe,
  address,
  deployment,
  tokens,
  account,
  onMessage,
  onError,
}: {
  recipe: DropRecipeJson
  address: Address
  deployment: DropDeployment
  tokens: TokenInfo[]
  account?: Address | null
  onMessage?: (message: string) => void
  onError?: (message: string) => void
}) {
  const step = convertStepOf(recipe)
  const chainId = recipe.chainId
  const buyToken = step ? findToken(tokens, step.buyToken) : undefined

  const [sellToken, setSellToken] = useState<Address>(() => defaultSellToken(tokens, chainId, step?.buyToken))
  const [balance, setBalance] = useState<bigint | null>(null)
  /**
   * The drop's native balance, when the wrapper is what is being sold.
   *
   * `ConvertSteps` wraps it as part of the activation, so to this panel it is simply part of the
   * balance — shown separately only so the number on screen can be explained.
   */
  const [nativeBalance, setNativeBalance] = useState<bigint>(0n)
  const [quote, setQuote] = useState<ConvertQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  /**
   * Starts at the SDK default and moves to the keeper's, once it says what that is.
   *
   * Not a second setting: the keeper is what names the minimum when it activates, so showing anything
   * else here would be showing a price nobody will use. Still editable — this activation is the one
   * being priced, and the operator's number is a starting point, not a rule.
   */
  const [haircut, setHaircut] = useState(String(CONVERT_HAIRCUT_BPS))
  /** Cleared when the user types, so a late answer never overwrites what they just set. */
  const [haircutTouched, setHaircutTouched] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // A token list for another chain makes the selection meaningless; pick again.
  useEffect(() => {
    if (tokens.length > 0 && !findToken(tokens, sellToken)) {
      setSellToken(defaultSellToken(tokens, chainId, step?.buyToken))
    }
  }, [tokens, chainId, sellToken, step?.buyToken])

  useEffect(() => {
    let cancelled = false
    void keeperConvertHaircutBps(chainId).then((bps) => {
      if (!cancelled && bps !== null && !haircutTouched) setHaircut(String(bps))
    })
    return () => {
      cancelled = true
    }
    // `haircutTouched` is read, not depended on: re-running when it flips would re-fetch for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId])

  // One clock for the countdown. A second is the finest grain it shows.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const receiver = (step?.receiver ?? recipe.owner) as Address

  /** The balance, and what the market would pay for it. One without the other prices nothing. */
  const load = useCallback(async () => {
    if (!step) return
    setRefreshing(true)
    try {
      // Native counts only towards the wrapper, which is the one token the step will wrap into.
      const isWrapper = sellToken.toLowerCase() === wrappedNative(chainId).toLowerCase()
      const [erc20, native] = await Promise.all([
        readTokenBalance(chainId, sellToken, address),
        isWrapper ? readNativeBalance(chainId, address) : Promise.resolve(0n),
      ])
      setNativeBalance(native)
      const held = erc20 + native
      setBalance(held)
      if (held === 0n) {
        setQuote(null)
        setQuoteError(null)
        return
      }
      setQuote(
        await quoteConvert({
          sellToken,
          buyToken: step.buyToken,
          sellAmount: held,
          drop: address,
          receiver,
          chainId,
        }),
      )
      setQuoteError(null)
    } catch (cause) {
      setQuote(null)
      setQuoteError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRefreshing(false)
    }
  }, [step, chainId, sellToken, address, receiver])

  // A different token or drop is a different quote: start over rather than show the old one.
  useEffect(() => {
    setQuote(null)
    setQuoteError(null)
    setBalance(null)
    void load()
  }, [load])

  /*
   * Re-quote just before the order book's expiry, rather than on a fixed timer: the minimum on screen
   * is then always one the market still stands behind. A failed quote is retried on its own, slower,
   * schedule; an arrival already in the buy token only needs its balance re-read now and then.
   */
  useEffect(() => {
    if (refreshing) return
    const delay = quote
      ? quote.expiresAt === null
        ? FIXED_REFRESH_MS
        : Math.max(0, quote.expiresAt - Date.now() - REFRESH_LEAD_MS)
      : quoteError
        ? RETRY_MS
        : null
    if (delay === null) return
    const timer = setTimeout(() => void load(), delay)
    return () => clearTimeout(timer)
  }, [quote, quoteError, refreshing, load])

  if (!step) return null

  const sell = findToken(tokens, sellToken)
  const sellDecimals = sell?.decimals ?? 18
  const sellSymbol = sell?.symbol ?? 'tokens'
  const buyDecimals = buyToken?.decimals ?? 18
  const buySymbol = buyToken?.symbol ?? step.buyToken

  const pricer = (step.pricer ?? ZERO).toLowerCase()
  const isOpen = pricer === ZERO
  const mine = account?.toLowerCase()
  const mayPrice = isOpen || mine === pricer || mine === recipe.owner.toLowerCase()

  const bps = Number(haircut)
  const bpsValid = Number.isInteger(bps) && bps >= 0 && bps < 10_000
  /** Derived here, not in the quote, so typing a haircut re-prices without a round trip. */
  const minimum = (() => {
    if (!quote || !bpsValid) return null
    if (quote.expiresAt === null) return quote.sellAmount
    try {
      return convertMinimum(quote.atMarket, bps)
    } catch {
      return null
    }
  })()

  const forwarding = quote?.expiresAt === null && balance !== null && balance > 0n
  const remainingMs = quote?.expiresAt == null ? null : Math.max(0, quote.expiresAt - now)
  const lifetimeMs = quote?.expiresAt == null ? null : quote.expiresAt - quote.quotedAt
  const expired = remainingMs !== null && remainingMs <= REFRESH_LEAD_MS

  const onActivate = async () => {
    if (!account || minimum === null || minimum <= 0n) return
    setBusy(true)
    try {
      if ((await walletChainId()) !== chainId) await switchChain(chainId)
      const { hash, receipt } = await activateConvertDrop({
        account,
        recipe,
        sellToken,
        minBuyAmount: minimum,
      })
      const posted = await postPlacedOrders(receipt, address, chainId, deployment.settlement)
      onMessage?.(
        posted.length > 0
          ? `Converted ${sellSymbol} in ${hash}, and posted the order: ${posted.join(', ')}`
          : `Converted ${sellSymbol} in ${hash}`,
      )
      await load()
    } catch (cause) {
      if (isUserRejection(cause)) return
      onError?.(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset className="subsection payment">
      <legend>Convert</legend>
      <p>
        Everything here is sold for <strong>{buySymbol}</strong>, priced when you activate.
      </p>

      <TokenPicker
        label="Arrived in"
        tokens={tokens}
        value={sellToken}
        chainId={chainId}
        onChange={setSellToken}
      />

      {balance !== null && (
        <p className={balance > 0n ? 'ok' : 'hint'}>
          Holding {formatUnits(balance, sellDecimals)} {sellSymbol}
          {nativeBalance > 0n && (
            <span className="hint">
              {' '}
              — including {formatUnits(nativeBalance, 18)} native, wrapped as part of the activation
            </span>
          )}
          {balance === 0n && ' — nothing to convert in this token.'}
        </p>
      )}

      {forwarding ? (
        <p className="hint">Already in {buySymbol}: activating forwards it to the receiver, with no order.</p>
      ) : balance === null || balance === 0n ? null : (
        <>
          <label>
            <span className="label-text">
              Accept below market (bps)
              <Tooltip title="Haircut">
                How far under the quote the order&rsquo;s minimum sits. Too tight and no solver fills
                it; too loose and you accept less than the market offers. 100 bps is 1%.
              </Tooltip>
            </span>
            <input
              inputMode="numeric"
              value={haircut}
              onChange={(event) => {
                setHaircutTouched(true)
                setHaircut(event.target.value)
              }}
              aria-invalid={!bpsValid}
            />
          </label>
          {!bpsValid && <span className="field-error">Give a whole number of bps under 10000.</span>}

          {quote && minimum !== null ? (
            <>
              <p className="payment-amount">
                Selling <strong>{formatUnits(quote.sellAmount, sellDecimals)} {sellSymbol}</strong> for at
                least <strong>{formatUnits(minimum, buyDecimals)} {buySymbol}</strong>
              </p>
              <p className="hint">
                Market right now: {formatUnits(quote.atMarket, buyDecimals)} {buySymbol}
              </p>
              {remainingMs !== null && lifetimeMs !== null && (
                <div className="quote-countdown" aria-live="polite">
                  <progress max={lifetimeMs} value={remainingMs} />
                  <span className="hint">
                    {refreshing || expired ? 'Updating price…' : `Price valid for ${formatCountdown(remainingMs)}`}
                  </span>
                  <button onClick={() => void load()} disabled={refreshing}>
                    Refresh
                  </button>
                </div>
              )}
            </>
          ) : quoteError ? (
            <p className="error" role="alert">
              Can&rsquo;t quote {sellSymbol} right now, so there is no market to price against.
            </p>
          ) : (
            <p className="hint">Quoting&hellip;</p>
          )}
        </>
      )}

      <div className="actions">
        <button
          onClick={() => void onActivate()}
          disabled={
            busy ||
            !account ||
            !mayPrice ||
            balance === null ||
            balance === 0n ||
            minimum === null ||
            refreshing ||
            expired
          }
        >
          {busy ? 'Converting…' : `Convert ${sellSymbol}`}
        </button>
        {(balance === null || balance === 0n) && (
          <button onClick={() => void load()} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      {!account ? (
        <p className="hint">Connect a wallet to activate.</p>
      ) : !mayPrice ? (
        <p className="hint warn-note">
          This drop is priced by {step.pricer}, so only that address or the owner can activate it.
          Yours would be refused on-chain.
        </p>
      ) : isOpen ? (
        <p className="hint warn-note">
          Open pricing: anyone can activate this drop and name any minimum. Only CoW&rsquo;s solver
          competition protects the price.
        </p>
      ) : null}
    </fieldset>
  )
}

/** `m:ss`, for the quote countdown. */
function formatCountdown(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The wrapped native token if the list has it and it is not the buy token, else the first other token. */
function defaultSellToken(tokens: TokenInfo[], chainId: number, buyToken: Address | undefined): Address {
  const other = (token: TokenInfo) => token.address.toLowerCase() !== buyToken?.toLowerCase()
  const wrapped = findToken(tokens, wrappedNative(chainId))
  return (wrapped && other(wrapped) ? wrapped : (tokens.find(other) ?? tokens[0]))?.address ?? wrappedNative(chainId)
}
