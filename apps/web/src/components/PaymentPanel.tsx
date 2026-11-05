import type { DropDeployment, DropRecipeJson, DropStepJson } from '@cowprotocol/cow-drop-sdk'
import { formatUnits, type Address } from 'viem'
import { useCallback, useEffect, useState } from 'react'

import { activatePaymentDrop, postPlacedOrders, readTokenBalance, sendPayment } from '../lib/drop.js'
import { quotePayment, type PaymentQuote } from '../lib/quote.js'
import {
  connect,
  isUserRejection,
  onAccountsChanged,
  readAccount,
  switchChain,
  walletChainId,
  wrappedNative,
} from '../lib/chain.js'
import { findToken, type TokenInfo } from '../lib/tokenList.js'
import { TokenPicker } from './TokenPicker.js'

type PaymentStep = Extract<DropStepJson, { type: 'payment' }>

/** Re-quote this long before the order book's expiry, so the amount on screen is never a lapsed one. */
const REFRESH_LEAD_MS = 3_000
/** After a failed quote, try again this soon. */
const RETRY_MS = 15_000
/** A payment in the price token has no quote to expire; its balances are re-read this often. */
const FIXED_REFRESH_MS = 30_000

/** The payment step of a recipe, if it has one. */
export function paymentStepOf(recipe: DropRecipeJson): PaymentStep | undefined {
  return recipe.steps.find((step): step is PaymentStep => step.type === 'payment')
}

/**
 * "Pay with": what a payer should send to a payment drop, in the token they choose to pay with.
 *
 * The recipe commits to what the owner receives, not to what the payer sends, so the amount is a live
 * quote rather than a number in the recipe: a CoW buy quote for the price, plus 50 bps. That margin is
 * what lets the keeper still find the payment covers the price a little later, and because the drop
 * sells the whole balance, whatever the margin does not use reaches the receiver.
 *
 * The quote carries the order book's own expiry. The panel counts it down and re-quotes just before it
 * lapses, so the amount offered is always one the market still stands behind.
 *
 * **Pay** transfers that amount from the connected wallet. The share card has no wallet button of its
 * own — and it is where a payer usually lands — so the panel finds or connects a wallet itself.
 *
 * With `account`, it also offers to activate the drop with that token — the same call the keeper makes.
 */
export function PaymentPanel({
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
  const step = paymentStepOf(recipe)
  const chainId = recipe.chainId
  const buyToken = step ? findToken(tokens, step.buyToken) : undefined

  const [payWith, setPayWith] = useState<Address>(() => defaultPayToken(tokens, chainId, step?.buyToken))
  const [quote, setQuote] = useState<PaymentQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [balance, setBalance] = useState<bigint | null>(null)
  /** The wallet found on its own, for pages that do not pass `account` (the share card). */
  const [detected, setDetected] = useState<Address | null>(null)
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [sending, setSending] = useState(false)
  /** Kept in the panel rather than handed up: the share card has no banner to hand it to. */
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null)

  const wallet = account ?? detected

  // A token list for another chain arriving makes the selection meaningless; pick again.
  useEffect(() => {
    if (tokens.length > 0 && !findToken(tokens, payWith)) {
      setPayWith(defaultPayToken(tokens, chainId, step?.buyToken))
    }
  }, [tokens, chainId, payWith, step?.buyToken])

  // An already-authorised wallet, without prompting, and following it if the user switches accounts.
  useEffect(() => {
    if (account !== undefined) return
    void readAccount().then(setDetected)
    return onAccountsChanged(setDetected)
  }, [account])

  // One clock for the countdown. A second is the finest grain it shows.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const receiver = (step?.receiver ?? recipe.owner) as Address

  const load = useCallback(async () => {
    if (!step) return
    setRefreshing(true)
    try {
      const [next, held] = await Promise.all([
        quotePayment({
          sellToken: payWith,
          buyToken: step.buyToken,
          buyAmount: BigInt(step.buyAmount),
          drop: address,
          receiver,
          chainId,
        }),
        readTokenBalance(chainId, payWith, address),
      ])
      setQuote(next)
      setQuoteError(null)
      setBalance(held)
    } catch (cause) {
      setQuote(null)
      setQuoteError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRefreshing(false)
    }
  }, [step, payWith, address, receiver, chainId])

  const readWalletBalance = useCallback(async () => {
    setWalletBalance(wallet ? await readTokenBalance(chainId, payWith, wallet) : null)
  }, [wallet, chainId, payWith])

  // A different token or drop is a different quote: start over rather than show the old one.
  useEffect(() => {
    setQuote(null)
    setQuoteError(null)
    setBalance(null)
    void load()
  }, [load])

  useEffect(() => {
    void readWalletBalance()
  }, [readWalletBalance])

  /*
   * Re-quote just before the order book's expiry, rather than on a fixed timer: the amount on screen
   * is then always one the market still stands behind. A failed quote is retried on its own, slower,
   * schedule; a fixed amount in the price token only needs its balances re-read now and then.
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

  const pay = findToken(tokens, payWith)
  const payDecimals = pay?.decimals ?? 18
  const paySymbol = pay?.symbol ?? 'tokens'
  const price = formatUnits(BigInt(step.buyAmount), buyToken?.decimals ?? 18)
  const covered = quote !== null && balance !== null && balance > 0n && balance >= quote.atMarket

  const remainingMs = quote?.expiresAt == null ? null : Math.max(0, quote.expiresAt - now)
  const lifetimeMs = quote?.expiresAt == null ? null : quote.expiresAt - quote.quotedAt
  const expired = remainingMs !== null && remainingMs <= REFRESH_LEAD_MS
  const shortOfFunds = quote !== null && walletBalance !== null && walletBalance < quote.send
  const amountText = quote ? `${formatUnits(quote.send, payDecimals)} ${paySymbol}` : ''

  const copyAmount = async () => {
    if (!quote) return
    await navigator.clipboard.writeText(formatUnits(quote.send, payDecimals))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const onConnect = async () => {
    setSendResult(null)
    try {
      setDetected(await connect(chainId))
    } catch (cause) {
      if (isUserRejection(cause)) return
      setSendResult({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  /**
   * Pay the amount on screen, as quoted when the button was pressed.
   *
   * The wallet is moved to the drop's chain first: a transfer signed on another chain would go to the
   * same address there, where no recipe runs and nobody is watching.
   */
  const onPay = async () => {
    if (!quote || !wallet) return
    const amount = quote.send
    setSending(true)
    setSendResult(null)
    try {
      if ((await walletChainId()) !== chainId) await switchChain(chainId)
      const { hash } = await sendPayment({ chainId, account: wallet, token: payWith, drop: address, amount })
      setSendResult({
        ok: true,
        text: `Paid ${formatUnits(amount, payDecimals)} ${paySymbol}. Transaction ${hash}`,
      })
      await Promise.all([load(), readWalletBalance()])
    } catch (cause) {
      if (isUserRejection(cause)) return
      setSendResult({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setSending(false)
    }
  }

  const onActivate = async () => {
    if (!account) return
    setBusy(true)
    try {
      const { hash, receipt } = await activatePaymentDrop({ account, recipe, sellToken: payWith })
      const posted = await postPlacedOrders(receipt, address, chainId, deployment.settlement)
      onMessage?.(
        posted.length > 0
          ? `Activated with ${paySymbol} in ${hash}, and posted the order: ${posted.join(', ')}`
          : `Activated with ${paySymbol} in ${hash}`,
      )
      await load()
    } catch (cause) {
      onError?.(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset className="subsection payment">
      <legend>Pay</legend>
      <p>
        Amount due: <strong>{price} {buyToken?.symbol ?? step.buyToken}</strong>, payable in any token.
      </p>
      <TokenPicker label="Pay with" tokens={tokens} value={payWith} chainId={chainId} onChange={setPayWith} />

      {quote ? (
        <>
          <p className="payment-amount">
            You pay <strong>{amountText}</strong>{' '}
            <button onClick={() => void copyAmount()}>{copied ? 'Copied' : 'Copy amount'}</button>
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
          Can&rsquo;t pay with {paySymbol} right now. Try another token.
        </p>
      ) : (
        <p className="hint">Quoting&hellip;</p>
      )}

      <div className="actions">
        {wallet ? (
          <button
            onClick={() => void onPay()}
            disabled={!quote || sending || refreshing || expired || shortOfFunds}
          >
            {sending ? 'Paying…' : quote ? `Pay ${amountText}` : 'Pay'}
          </button>
        ) : (
          <button onClick={() => void onConnect()}>
            Connect wallet to pay
          </button>
        )}
        {account && (
          <button onClick={() => void onActivate()} disabled={busy || balance === null || balance === 0n}>
            {busy ? 'Activating…' : `Activate with ${paySymbol}`}
          </button>
        )}
      </div>
      {wallet && walletBalance !== null && (
        <p className={shortOfFunds ? 'hint warn-note' : 'hint'}>
          Your balance: {formatUnits(walletBalance, payDecimals)} {paySymbol}
          {shortOfFunds && ' — not enough'}
        </p>
      )}

      {sendResult && (
        <p className={sendResult.ok ? 'ok' : 'error'} role={sendResult.ok ? undefined : 'alert'}>
          {sendResult.text}
        </p>
      )}

      {balance !== null && balance > 0n && (
        <p className={covered ? 'ok' : 'hint warn-note'}>
          Received {formatUnits(balance, payDecimals)} {paySymbol}
          {quote && (covered ? ' — paid.' : ` — ${formatUnits(quote.atMarket, payDecimals)} needed.`)}
        </p>
      )}

    </fieldset>
  )
}

/** `m:ss`, for the quote countdown. */
function formatCountdown(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The wrapped native token if the list has it and it is not the price token, else the first other token. */
function defaultPayToken(tokens: TokenInfo[], chainId: number, buyToken: Address | undefined): Address {
  const other = (token: TokenInfo) => token.address.toLowerCase() !== buyToken?.toLowerCase()
  const wrapped = findToken(tokens, wrappedNative(chainId))
  return (wrapped && other(wrapped) ? wrapped : (tokens.find(other) ?? tokens[0]))?.address ?? wrappedNative(chainId)
}
