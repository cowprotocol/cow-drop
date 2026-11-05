import type { DropDeployment, DropRecipeJson, DropStepJson } from '@cowprotocol/cow-drop-sdk'
import { formatUnits, type Address } from 'viem'
import { useCallback, useEffect, useState } from 'react'

import { activatePaymentDrop, postPlacedOrders, readTokenBalance, sendPayment } from '../lib/drop.js'
import { quotePayment, type PaymentQuote } from '../lib/quote.js'
import { connect, isUserRejection, switchChain, walletChainId, wrappedNative } from '../lib/chain.js'
import { findToken, type TokenInfo } from '../lib/tokenList.js'
import { TokenPicker } from './TokenPicker.js'

type PaymentStep = Extract<DropStepJson, { type: 'payment' }>

/** How often the amount to send is re-quoted while the panel is on screen. */
const REQUOTE_MS = 30_000

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
 * **Send** transfers the quoted amount from the payer's wallet, connecting one first if the page has
 * none — the share card has no wallet button, and it is where a payer usually lands.
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
  const [balance, setBalance] = useState<bigint | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [sending, setSending] = useState(false)
  /** Kept in the panel rather than handed up: the share card has no banner to hand it to. */
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null)

  // A token list for another chain arriving makes the selection meaningless; pick again.
  useEffect(() => {
    if (tokens.length > 0 && !findToken(tokens, payWith)) {
      setPayWith(defaultPayToken(tokens, chainId, step?.buyToken))
    }
  }, [tokens, chainId, payWith, step?.buyToken])

  const receiver = (step?.receiver ?? recipe.owner) as Address

  const load = useCallback(async () => {
    if (!step) return
    setQuoteError(null)
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
      setBalance(held)
    } catch (cause) {
      setQuote(null)
      setQuoteError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [step, payWith, address, receiver, chainId])

  useEffect(() => {
    setQuote(null)
    setBalance(null)
    void load()
    const timer = setInterval(() => void load(), REQUOTE_MS)
    return () => clearInterval(timer)
  }, [load])

  if (!step) return null

  const pay = findToken(tokens, payWith)
  const payDecimals = pay?.decimals ?? 18
  const paySymbol = pay?.symbol ?? 'tokens'
  const price = formatUnits(BigInt(step.buyAmount), buyToken?.decimals ?? 18)
  const covered = quote !== null && balance !== null && balance > 0n && balance >= quote.atMarket

  const copyAmount = async () => {
    if (!quote) return
    await navigator.clipboard.writeText(formatUnits(quote.send, payDecimals))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  /**
   * Send the amount on screen, as quoted when the button was pressed.
   *
   * The wallet is moved to the drop's chain first: a transfer signed on another chain would go to the
   * same address there, where no recipe runs and nobody is watching.
   */
  const onSend = async () => {
    if (!quote) return
    const amount = quote.send
    setSending(true)
    setSendResult(null)
    try {
      const from = account ?? (await connect(chainId))
      if ((await walletChainId()) !== chainId) await switchChain(chainId)
      const { hash } = await sendPayment({ chainId, account: from, token: payWith, drop: address, amount })
      setSendResult({
        ok: true,
        text:
          `Sent ${formatUnits(amount, payDecimals)} ${paySymbol} in ${hash}. ` +
          'Once a keeper sees it, it is swapped and paid on.',
      })
      await load()
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
      <legend>Pay this address</legend>
      <p>
        It pays <strong>{price} {buyToken?.symbol ?? step.buyToken}</strong> to the receiver. Pay in any
        token:
      </p>
      <TokenPicker label="Pay with" tokens={tokens} value={payWith} chainId={chainId} onChange={setPayWith} />

      {quote ? (
        <p className="payment-amount">
          Send exactly <strong>{formatUnits(quote.send, payDecimals)} {paySymbol}</strong>{' '}
          <button onClick={() => void onSend()} disabled={sending}>
            {sending ? 'Sending…' : `Send ${formatUnits(quote.send, payDecimals)} ${paySymbol}`}
          </button>{' '}
          <button onClick={() => void copyAmount()}>{copied ? 'Copied' : 'Copy amount'}</button>
        </p>
      ) : quoteError ? (
        <p className="error" role="alert">
          Cannot price {paySymbol} against {buyToken?.symbol ?? 'the price token'}: {quoteError}
        </p>
      ) : (
        <p className="hint">Quoting&hellip;</p>
      )}

      {sendResult && (
        <p className={sendResult.ok ? 'ok' : 'error'} role={sendResult.ok ? undefined : 'alert'}>
          {sendResult.text}
        </p>
      )}

      {balance !== null && balance > 0n && (
        <p className={covered ? 'ok' : 'hint warn-note'}>
          The address holds {formatUnits(balance, payDecimals)} {paySymbol}
          {quote &&
            (covered
              ? ', which covers the price.'
              : `, short of the ${formatUnits(quote.atMarket, payDecimals)} the price needs at the market.`)}
        </p>
      )}

      {account && (
        <div className="actions">
          <button onClick={() => void onActivate()} disabled={busy || balance === null || balance === 0n}>
            {busy ? 'Activating…' : `Activate with ${paySymbol}`}
          </button>
        </div>
      )}

      <p className="hint">
        A live quote for the price plus 0.5%, refreshed every 30 seconds. The address sells everything that
        arrives in one order that must buy at least the price, so anything above it goes to the receiver
        too. A token the market cannot price is never sold — the owner can sweep it back.
      </p>
    </fieldset>
  )
}

/** The wrapped native token if the list has it and it is not the price token, else the first other token. */
function defaultPayToken(tokens: TokenInfo[], chainId: number, buyToken: Address | undefined): Address {
  const other = (token: TokenInfo) => token.address.toLowerCase() !== buyToken?.toLowerCase()
  const wrapped = findToken(tokens, wrappedNative(chainId))
  return (wrapped && other(wrapped) ? wrapped : (tokens.find(other) ?? tokens[0]))?.address ?? wrappedNative(chainId)
}
