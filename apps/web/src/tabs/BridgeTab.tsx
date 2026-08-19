import { SUPPORTED_BRIDGES, type BridgeQuote } from '@cowprotocol/cow-drop-bridging'
import { ON_FAILURE, type DropRecipeJson, type OnFailure } from '@cowprotocol/cow-drop-sdk'
import { formatUnits, parseUnits, type Address, type Hex } from 'viem'
import { useEffect, useMemo, useState } from 'react'

import { TokenPicker } from '../components/TokenPicker.js'
import {
  BRIDGE_SOURCE_CHAINS,
  approveBridge,
  bridgeExplorerUrl,
  deliverableTokens,
  planFrom,
  quoteBridge,
  readBridgeAllowance,
  readTokenBalance,
  sendBridge,
  type BridgePlan,
} from '../lib/bridge.js'
import { blockExplorer, chainInfo, isUserRejection, onChainChanged, switchChain, walletChainId } from '../lib/chain.js'
import { keeperUrl, readKeeperDrop, registerWithKeeper } from '../lib/keeper.js'
import { markSentToKeeper, saveDrop } from '../lib/storage.js'
import { fetchTokenList, findToken, type TokenInfo } from '../lib/tokenList.js'

/**
 * Fund a drop from another chain.
 *
 * This tab builds no recipe. Bridging is a way of *funding* a drop, not a kind of drop, so the recipe
 * arrives from the builder and any of them works — a swap, a TWAP, a stop-loss. What is chosen here is
 * only where the money comes from.
 *
 * The order of operations is the load-bearing part, and it is why the bridge button does more than one
 * thing: the keeper must hold the recipe *before* the money leaves. It is the only holder of the
 * appData pre-images the order book needs, and it is the fallback that activates when the atomic path
 * declines — and neither is any use if it learns about the drop after the fill.
 */
export function BridgeTab({
  account,
  recipe,
  onBuildRecipe,
}: {
  account: Address | null
  recipe: DropRecipeJson | null
  onBuildRecipe: () => void
}) {
  if (!recipe) return <EmptyState onBuildRecipe={onBuildRecipe} />
  // A quote is priced for a sender, and the transaction is sent from one, so there is nothing useful
  // to show before there is an account — unlike the builder, which is pure arithmetic without a wallet.
  if (!account) {
    return (
      <section>
        <h2>Bridge &amp; Swap</h2>
        <p>Connect a wallet to quote a route and send the bridge transaction.</p>
      </section>
    )
  }
  return <Bridge account={account} recipe={recipe} onBuildRecipe={onBuildRecipe} />
}

function EmptyState({ onBuildRecipe }: { onBuildRecipe: () => void }) {
  return (
    <section>
      <h2>Bridge &amp; Swap</h2>
      <p className="hint">
        Bring tokens from another chain straight into a drop. The bridge delivers to the drop and
        triggers its recipe in the same transaction, so the CoW order is live the moment the bridge
        fills — no keeper wait, and no gas of yours on the destination chain.
      </p>
      <p>
        There is no recipe to fund yet. Build one on the Recipes tab, then press <em>Fund by bridging</em>.
      </p>
      <button onClick={onBuildRecipe}>Go to Recipes</button>
    </section>
  )
}

/** Where the registration with the destination keeper has got to. */
type KeeperState = 'none' | 'unknown' | 'checking' | 'registered' | 'failed'

function Bridge({
  account,
  recipe,
  onBuildRecipe,
}: {
  account: Address
  recipe: DropRecipeJson
  onBuildRecipe: () => void
}) {
  /** Everything about the destination comes from the recipe, and never quotes. */
  const plan = useMemo<{ ok: true; value: BridgePlan } | { ok: false; error: string }>(() => {
    try {
      return { ok: true, value: planFrom(recipe) }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [recipe])

  const destinationChainId = plan.ok ? plan.value.destinationChainId : null

  const [sourceChainId, setSourceChainId] = useState<number>(
    () => BRIDGE_SOURCE_CHAINS.find((id) => id !== recipe.chainId) ?? 1,
  )
  const [tokens, setTokens] = useState<TokenInfo[]>([])
  const [sourceToken, setSourceToken] = useState<Address | null>(null)
  const [amountText, setAmountText] = useState('')
  const [onFailure, setOnFailure] = useState<OnFailure>('leave-at-drop')

  const [quote, setQuote] = useState<BridgeQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  /**
   * Quote and send failures stay in this tab rather than going to the page banner.
   *
   * Both are answers to a button a few lines away — "no route for that pair", "the quote expired" —
   * and the fix is always to change something right there. Reporting them at the top of the page put
   * the diagnosis a scroll away from the control that caused it.
   */
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [allowance, setAllowance] = useState<bigint | null>(null)
  const [busy, setBusy] = useState(false)
  const [bridgeHash, setBridgeHash] = useState<Hex | null>(null)
  const [keeperState, setKeeperState] = useState<KeeperState>('unknown')
  const [walletChain, setWalletChain] = useState<number | null>(null)
  /** null while unread — an unreadable balance must not read as zero. */
  const [balance, setBalance] = useState<bigint | null>(null)
  /** true/false once Bungee has answered, null while unknown or unasked. */
  const [reachable, setReachable] = useState<boolean | null>(null)

  const decimals = findToken(tokens, sourceToken ?? '')?.decimals ?? 18

  /** The amount, or null while it is unparseable — an empty box is not an error to shout about. */
  const amount = useMemo(() => {
    const text = amountText.trim()
    if (text === '') return null
    try {
      const parsed = parseUnits(text, decimals)
      return parsed > 0n ? parsed : null
    } catch {
      return null
    }
  }, [amountText, decimals])

  useEffect(() => onChainChanged(setWalletChain), [])
  useEffect(() => {
    void walletChainId().then(setWalletChain)
  }, [])

  /** The source chain's token list. Guarded against the slower of two in-flight loads winning. */
  useEffect(() => {
    let cancelled = false
    void fetchTokenList(sourceChainId).then((loaded) => {
      if (cancelled) return
      setTokens(loaded)
      // Token addresses are chain-specific, so the previous chain's choice means nothing here.
      setSourceToken(loaded[0]?.address ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [sourceChainId])

  /**
   * The balance of the token about to be bridged.
   *
   * Deliberately not gated on the wallet being on the source chain: this reads through the public RPC,
   * and making it wait for a network switch would hide the one number you need in order to decide
   * whether to switch at all.
   */
  useEffect(() => {
    if (!sourceToken) return
    let cancelled = false
    setBalance(null)
    void readTokenBalance({ chainId: sourceChainId, token: sourceToken, owner: account }).then((held) => {
      if (!cancelled) setBalance(held)
    })
    return () => {
      cancelled = true
    }
  }, [sourceChainId, sourceToken, account])

  /**
   * Can this bridge deliver the token the recipe needs, on the chain the drop lives on?
   *
   * The chain list is far more permissive than the routes behind it, so this is asked up front rather
   * than discovered as an empty route list after the user has picked an amount. Advisory: an
   * unanswered lookup leaves this null and quoting still goes ahead.
   */
  useEffect(() => {
    if (!sourceToken || destinationChainId === null) return
    let cancelled = false
    setReachable(null)
    void deliverableTokens({
      sellChainId: sourceChainId,
      sellToken: sourceToken,
      buyChainId: destinationChainId,
    }).then((tokens) => {
      if (cancelled || tokens === null) return
      const wanted = plan.ok ? plan.value.deliveredToken.toLowerCase() : ''
      setReachable(tokens.some((token) => token.address.toLowerCase() === wanted))
    })
    return () => {
      cancelled = true
    }
  }, [sourceChainId, sourceToken, destinationChainId, plan])

  /** A quote is for one route, amount and destination. Any of them moving makes it stale. */
  useEffect(() => {
    setQuote(null)
    setAllowance(null)
    setBridgeHash(null)
    setQuoteError(null)
    setSendError(null)
  }, [sourceChainId, sourceToken, amountText, onFailure, recipe])

  /**
   * Does the destination keeper already hold this recipe?
   *
   * Asked on the destination chain, never the wallet's — that is the whole reason `keeperUrl` takes a
   * chain id. A keeper that cannot be reached leaves this `unknown` rather than `none`: "we could not
   * ask" and "there is nobody to ask" lead to different sentences, and only one of them is worth
   * blocking on.
   */
  useEffect(() => {
    if (destinationChainId === null) return
    if (keeperUrl(destinationChainId) === null) {
      setKeeperState('none')
      return
    }

    let cancelled = false
    setKeeperState('checking')
    void readKeeperDrop(plan.ok ? plan.value.drop : '0x', destinationChainId)
      .then((held) => {
        if (!cancelled) setKeeperState(held ? 'registered' : 'unknown')
      })
      .catch(() => {
        if (!cancelled) setKeeperState('unknown')
      })
    return () => {
      cancelled = true
    }
  }, [destinationChainId, plan])

  if (!plan.ok) {
    return (
      <section>
        <h2>Bridge &amp; Swap</h2>
        <p className="error">{plan.error}</p>
        <button onClick={onBuildRecipe}>Back to Recipes</button>
      </section>
    )
  }

  const { compiled, drop, deliveredToken } = plan.value
  const destinationChain = destinationChainId as number
  const wrongNetwork = walletChain !== null && walletChain !== sourceChainId
  const symbol = findToken(tokens, sourceToken ?? '')?.symbol ?? ''
  const overBalance = amount !== null && balance !== null && amount > balance
  const needsApproval =
    quote?.approval != null && allowance !== null && allowance < quote.approval.amount

  const onQuote = async () => {
    if (!amount || !sourceToken) return
    setQuoteError(null)
    setQuoting(true)
    try {
      const quoted = await quoteBridge({
        plan: plan.value,
        sender: account,
        sellChainId: sourceChainId,
        sellToken: sourceToken,
        sellAmount: amount,
        onFailure,
      })
      setQuote(quoted)

      if (quoted.approval) {
        setAllowance(
          await readBridgeAllowance({
            chainId: sourceChainId,
            token: quoted.approval.token,
            owner: account,
            spender: quoted.approval.spender,
          }),
        )
      }
    } catch (cause) {
      setQuoteError(describeBridgeError(cause))
    } finally {
      setQuoting(false)
    }
  }

  /**
   * Hand the recipe to the destination keeper.
   *
   * Idempotent at the server — a repeat is a 200 — so this is safe to run again on a retry, which is
   * exactly what makes it safe to fold into the bridge button rather than making it a separate step
   * the user can forget.
   */
  const ensureRegistered = async (): Promise<void> => {
    if (keeperState === 'registered' || keeperUrl(destinationChain) === null) return

    const held = await registerWithKeeper({ recipe, address: drop })
    saveDrop({ address: drop, recipe })
    markSentToKeeper({ address: drop, chainId: destinationChain, url: keeperUrl(destinationChain) ?? '' })
    setKeeperState(held.watching ? 'registered' : 'failed')
  }

  const onApprove = async () => {
    if (!quote?.approval) return
    setSendError(null)
    setBusy(true)
    try {
      await approveBridge({ account, chainId: sourceChainId, approval: quote.approval })
      setAllowance(quote.approval.amount)
    } catch (cause) {
      if (!isUserRejection(cause)) setSendError(describeBridgeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const onBridge = async () => {
    if (!quote) return
    setSendError(null)
    setBusy(true)
    try {
      // Before the money moves, never after: the keeper holds the appData pre-images the order book
      // needs, and is the fallback if the atomic activation declines.
      await ensureRegistered()
      setBridgeHash(await sendBridge({ account, quote }))
    } catch (cause) {
      if (!isUserRejection(cause)) setSendError(describeBridgeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const explorer = blockExplorer(destinationChain)

  return (
    <section className="bridge">
      <h2>Bridge &amp; Swap</h2>
      <p className="hint">
        The bridge pays a receiver contract on {chainName(destinationChain)}, which forwards the tokens
        to the drop and runs its recipe in the same transaction. Your order is live as soon as the
        bridge fills.
      </p>

      <h3>1 · The drop you are funding</h3>
      <dl className="facts">
        <dt>Recipe</dt>
        <dd>{recipe.label}</dd>
        <dt>Lands on</dt>
        <dd>{chainName(destinationChain)}</dd>
        <dt>Drop address</dt>
        <dd>
          <a href={`${explorer.url}/address/${drop}`} target="_blank" rel="noreferrer">
            <code>{drop}</code>
          </a>
        </dd>
        <dt>Must receive</dt>
        <dd>
          <code>{deliveredToken}</code>
          <span className="hint"> — the token the recipe sells. The bridge has to deliver this one.</span>
        </dd>
        <dt>Generation</dt>
        <dd>{compiled.deployment.generation}</dd>
      </dl>
      <p className="hint">
        Built on the Recipes tab. <button className="link" onClick={onBuildRecipe}>Change it</button>.
      </p>

      <h3>2 · What you are sending</h3>
      <label>
        From chain
        <select
          value={sourceChainId}
          onChange={(event) => setSourceChainId(Number(event.target.value))}
          disabled={busy}
        >
          {BRIDGE_SOURCE_CHAINS.filter((id) => id !== destinationChain).map((id) => (
            <option key={id} value={id}>
              {chainName(id)}
            </option>
          ))}
        </select>
      </label>

      {sourceToken && (
        <TokenPicker
          label="Token"
          tokens={tokens}
          value={sourceToken}
          chainId={sourceChainId}
          onChange={setSourceToken}
        />
      )}

      <label>
        Amount
        <input
          value={amountText}
          onChange={(event) => setAmountText(event.target.value)}
          placeholder="0.0"
          inputMode="decimal"
          disabled={busy}
        />
      </label>
      <p className="hint">
        {balance === null ? (
          'Balance unavailable — this chain\u2019s public RPC did not answer. You can still enter an amount.'
        ) : (
          <>
            Balance {formatUnits(balance, decimals)} {symbol}
            {balance > 0n && (
              <>
                {' · '}
                <button
                  className="link"
                  onClick={() => setAmountText(formatUnits(balance, decimals))}
                  disabled={busy}
                >
                  Max
                </button>
              </>
            )}
          </>
        )}
      </p>
      {overBalance && <p className="error">That is more than you hold on {chainName(sourceChainId)}.</p>}

      {reachable === false && (
        <p className="error">
          Bungee cannot deliver that token on {chainName(destinationChain)} from{' '}
          {chainName(sourceChainId)}. Only {SUPPORTED_BRIDGES.join(', ')} are enabled here, and they do
          not all serve every chain — try another source chain.
        </p>
      )}

      {/*
        Here rather than only beside the send button. The source chain is chosen just above, and the
        switch is a precondition of everything below it — finding that out at the last step means
        going back up to understand why.
      */}
      {wrongNetwork && (
        <p className="hint">
          Your wallet is on {chainName(walletChain as number)}, so the bridge transaction cannot be
          sent yet.{' '}
          <button className="link" onClick={() => void switchChain(sourceChainId)}>
            Switch to {chainName(sourceChainId)}
          </button>
        </p>
      )}

      <h3>3 · If the recipe will not run</h3>
      <p className="hint">
        A recipe can legitimately decline — a minimum-balance guard refusing a bridge&apos;s first
        tranche is the guard working. The tokens have arrived either way, so this is where they go.
      </p>
      {ON_FAILURE.map((mode) => (
        <label key={mode} className="radio">
          <input
            type="radio"
            name="onFailure"
            checked={onFailure === mode}
            onChange={() => setOnFailure(mode)}
            disabled={busy}
          />
          {mode === 'leave-at-drop' ? (
            <span>
              <strong>Leave at the drop.</strong> They wait at the drop address for the rest to arrive,
              and a keeper activates once the recipe can run. The safe choice with any recipe.
            </span>
          ) : (
            <span>
              <strong>Send back to me.</strong> Returned to <code>{recipe.owner}</code>. Do not use this
              with a minimum-balance guard — every tranche would bounce instead of accumulating.
            </span>
          )}
        </label>
      ))}

      <h3>4 · Route</h3>
      <button onClick={onQuote} disabled={!amount || !sourceToken || overBalance || quoting || busy}>
        {quoting ? 'Getting a quote…' : quote ? 'Re-quote' : 'Get a quote'}
      </button>

      {quoteError && <p className="error">{quoteError}</p>}

      {quote && (
        <>
          <dl className="facts">
            <dt>Bridge</dt>
            <dd>
              {quote.route.name} · about {Math.round(quote.route.estimatedSeconds / 60)} min
            </dd>
            <dt>Sending</dt>
            <dd>
              {formatUnits(quote.input.amount, quote.input.token.decimals)} {quote.input.token.symbol}
            </dd>
            <dt>Delivered</dt>
            <dd>
              ~{formatUnits(quote.output.amount, quote.output.token.decimals)} {quote.output.token.symbol}
              <span className="hint">
                {' '}
                (at least {formatUnits(quote.output.minAmount, quote.output.token.decimals)})
              </span>
            </dd>
          </dl>
          <p className="hint">
            The drop&apos;s own minimum lives in the recipe, not in this quote — it is part of the drop
            address, so taking it from a route that changes on every refresh would move the address the
            bridge is aimed at.
          </p>
        </>
      )}

      <h3>5 · Send it</h3>
      <KeeperNote state={keeperState} chainId={destinationChain} />

      {needsApproval && (
        <button onClick={() => void onApprove()} disabled={busy || wrongNetwork}>
          Approve {quote?.input.token.symbol}
        </button>
      )}

      <button
        onClick={() => void onBridge()}
        disabled={!quote || busy || wrongNetwork || needsApproval || bridgeHash !== null}
      >
        {busy ? 'Sending…' : 'Bridge and activate'}
      </button>

      {sendError && <p className="error">{sendError}</p>}

      {bridgeHash && (
        <p>
          Sent.{' '}
          <a href={bridgeExplorerUrl(bridgeHash)} target="_blank" rel="noreferrer">
            Track the bridge
          </a>
          , then watch{' '}
          <a href={`${explorer.url}/address/${drop}`} target="_blank" rel="noreferrer">
            the drop
          </a>{' '}
          on {chainName(destinationChain)}.
        </p>
      )}
    </section>
  )
}

function KeeperNote({ state, chainId }: { state: KeeperState; chainId: number }) {
  if (state === 'registered') {
    return <p className="hint">The {chainName(chainId)} keeper already holds this recipe.</p>
  }
  if (state === 'none') {
    return (
      <p className="hint">
        No keeper is configured for {chainName(chainId)}. The bridge still activates the drop on
        arrival, but nothing will retry if the recipe declines, and an order with custom appData may be
        rejected by the order book because nobody holds the pre-image.
      </p>
    )
  }
  if (state === 'failed') {
    return <p className="error">The keeper took the recipe but is not watching it. Check the Drops tab.</p>
  }
  return (
    <p className="hint">
      The recipe is handed to the {chainName(chainId)} keeper first, before anything is sent.
    </p>
  )
}

/** cow-sdk knows every chain here; fall back to the number rather than throwing inside a render. */
function chainName(chainId: number): string {
  try {
    return chainInfo(chainId).label
  } catch {
    return `chain ${chainId}`
  }
}

function describeBridgeError(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code: unknown }).code
    // Bungee answering "no routes" is a successful response, not a failed one — say so, or the next
    // move looks like "retry" when it is actually "pick a different chain or token".
    if (code === 'no-routes') {
      return `Bungee has no route for this pair and amount. It answered, with nothing to offer: only ${SUPPORTED_BRIDGES.join(', ')} are enabled here, and they do not all serve every chain. Try another source chain, another token, or a larger amount.`
    }
    if (code === 'quote-failed') return 'Bungee rejected the quote request — the pair or amount may be unsupported'
    if (code === 'build-failed') return 'the quote expired before it could be built — get a fresh one'
    if (code === 'unreachable') return 'the bridge API could not be reached'
  }
  return cause instanceof Error ? cause.message : String(cause)
}
