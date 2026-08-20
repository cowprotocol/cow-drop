import { ON_FAILURE, type DropRecipeJson, type OnFailure } from '@cowprotocol/cow-drop-sdk'
import { formatUnits, parseUnits, type Address, type Hex } from 'viem'
import { useEffect, useMemo, useState } from 'react'

import { BridgeHistory } from '../components/BridgeHistory.js'
import { BridgeProviderPicker } from '../components/BridgeProviderPicker.js'
import { BridgeReview } from '../components/BridgeReview.js'
import { BridgeRouteList } from '../components/BridgeRouteList.js'
import { TokenPicker } from '../components/TokenPicker.js'
import {
  BRIDGE_SOURCE_CHAINS,
  DEFAULT_BRIDGE_PROVIDER,
  approveBridge,
  bridgeExplorerUrl,
  buildAndVerifyRoute,
  capabilityOf,
  deliverableTokens,
  describeBridgeError,
  describeExecution,
  isQuoteExpired,
  listBridgeRoutes,
  summarise,
  planFrom,
  providerInfo,
  readBridgeAllowance,
  readTokenBalance,
  sendBridge,
  simulationCheck,
  walletChecks,
  type BridgePlan,
  type BridgeQuote,
  type BridgeRoutes,
  type CheckOutcome,
  type DeliveryMode,
} from '../lib/bridge.js'
import {
  blockExplorer,
  chainLabel,
  cowExplorer,
  isUserRejection,
  onChainChanged,
  switchChain,
  walletChainId,
} from '../lib/chain.js'
import { keeperUrl, readKeeperDrop, registerWithKeeper } from '../lib/keeper.js'
import { markSentToKeeper, readBridgeForm, saveBridge, saveBridgeForm, saveDrop } from '../lib/storage.js'
import { fetchTokenList, findToken, type TokenInfo } from '../lib/tokenList.js'

/**
 * Fund a drop from another chain.
 *
 * This tab builds no recipe. Bridging is a way of *funding* a drop, not a kind of drop, so the recipe
 * arrives from the builder and any of them works — a swap, a TWAP, a stop-loss. What is chosen here is
 * only where the money comes from, which route carries it, and — the part this tab now spends most of
 * its space on — whether the transaction the bridge built actually does what it says.
 *
 * The order of operations is load-bearing twice over. The keeper must hold the recipe *before* the
 * money leaves: it is the only holder of the appData pre-images the order book needs. And nothing may
 * be signed before it has been checked, which is why routes are listed before one is built, and built
 * before it is reviewed.
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
  /**
   * Everything about the destination comes from the recipe, and never from a quote.
   *
   * Hoisted out of the form below so it can key the remount. It is pure and cheap, so computing it
   * here costs nothing and buys the guarantee that no form state outlives the drop it was typed for.
   */
  const plan = useMemo<{ ok: true; value: BridgePlan } | { ok: false; error: string } | null>(() => {
    if (!recipe) return null
    try {
      return { ok: true, value: planFrom(recipe) }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [recipe])

  if (!recipe || !plan) return <EmptyState onBuildRecipe={onBuildRecipe} />

  if (!plan.ok) {
    return (
      <section>
        <h2>Bridge &amp; Swap</h2>
        <p className="error">{plan.error}</p>
        <button onClick={onBuildRecipe}>Back to Recipes</button>
      </section>
    )
  }

  // A quote is priced for a sender, and the transaction is sent from one, so there is nothing useful
  // to show before there is an account — unlike the builder, which is pure arithmetic without a wallet.
  if (!account) {
    return (
      <>
        <BridgeHistory revision={0} />

        <section>
          <h2>Bridge &amp; Swap</h2>
          <p>Connect a wallet to list routes and send the bridge transaction.</p>
        </section>
      </>
    )
  }

  return (
    /*
     * Keyed on the drop, so changing which recipe is being funded remounts the whole form.
     *
     * Without it, `readBridgeForm` runs once for whichever drop was first and every field keeps the
     * previous drop's value — which the save effect then writes back under the *new* drop's key. One
     * line here is worth more than seven careful resets.
     */
    <Bridge
      key={plan.value.drop}
      account={account}
      plan={plan.value}
      recipe={recipe}
      onBuildRecipe={onBuildRecipe}
    />
  )
}

function EmptyState({ onBuildRecipe }: { onBuildRecipe: () => void }) {
  return (
    <>
      <BridgeHistory revision={0} />

      <section>
        <h2>Bridge &amp; Swap</h2>
        <p className="hint">
          Bring tokens from another chain straight into a drop. The bridge delivers to the drop address
          itself and the keeper activates it on arrival, so nothing needs to be open and nothing of
          yours pays gas on the destination chain.
        </p>
        <p>
          There is no recipe to fund yet. Build one on the Recipes tab, then press{' '}
          <em>Fund by bridging</em>.
        </p>
        <button onClick={onBuildRecipe}>Go to Recipes</button>
      </section>
    </>
  )
}

/** Where the registration with the destination keeper has got to. */
type KeeperState = 'none' | 'unknown' | 'checking' | 'registered' | 'failed'

function Bridge({
  account,
  plan,
  recipe,
  onBuildRecipe,
}: {
  account: Address
  plan: BridgePlan
  recipe: DropRecipeJson
  onBuildRecipe: () => void
}) {
  const { compiled, drop, deliveredToken } = plan
  const destinationChain = plan.destinationChainId

  /**
   * What this browser was last setting up for *this* drop.
   *
   * Read once during the first render, so the fields never flash a default before being corrected —
   * and so the token-list effect below sees the restored token rather than racing it. Safe to read once
   * now that the component is keyed on the drop.
   */
  const [restored] = useState(() => readBridgeForm(drop))

  const [providerKey, setProviderKey] = useState<string>(() =>
    restored?.provider && providerInfo(restored.provider) ? restored.provider : DEFAULT_BRIDGE_PROVIDER,
  )
  const [sourceChainId, setSourceChainId] = useState<number>(
    () => restored?.sourceChainId ?? BRIDGE_SOURCE_CHAINS.find((id) => id !== recipe.chainId) ?? 1,
  )
  const [tokens, setTokens] = useState<TokenInfo[]>([])
  const [sourceToken, setSourceToken] = useState<Address | null>(restored?.sourceToken ?? null)
  const [amountText, setAmountText] = useState(restored?.amountText ?? '')
  const [onFailure, setOnFailure] = useState<OnFailure>(
    restored?.onFailure === 'refund-owner' ? 'refund-owner' : 'leave-at-drop',
  )

  /**
   * Always direct until deliberately changed, and never restored from storage.
   *
   * The delivery mode is a safety posture rather than a half-typed form field. Restoring `atomic`
   * because it was chosen once, silently, would re-arm the riskier path without anyone deciding to.
   */
  const [mode, setMode] = useState<DeliveryMode>('direct')

  const capability = useMemo(() => capabilityOf(providerKey), [providerKey])

  const [routes, setRoutes] = useState<BridgeRoutes | null>(null)
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null)
  const [built, setBuilt] = useState<BridgeQuote | null>(null)
  const [expired, setExpired] = useState(false)
  const [simulation, setSimulation] = useState<CheckOutcome | null>(null)
  const [listing, setListing] = useState(false)
  const [building, setBuilding] = useState(false)

  /**
   * Failures stay next to the button that caused them.
   *
   * Each is an answer to a control a few lines away — "no route for that pair", "the quote expired" —
   * and the fix is always to change something right there. Reporting them at the top of the page put
   * the diagnosis a scroll away from its cause.
   */
  const [routesError, setRoutesError] = useState<string | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [allowance, setAllowance] = useState<bigint | null>(null)
  const [busy, setBusy] = useState(false)
  const [bridgeHash, setBridgeHash] = useState<Hex | null>(null)
  const [keeperState, setKeeperState] = useState<KeeperState>('unknown')
  const [walletChain, setWalletChain] = useState<number | null>(null)
  /** null while unread — an unreadable balance must not read as zero. */
  const [balance, setBalance] = useState<bigint | null>(null)
  /** true/false once the provider has answered, null while unknown or unasked. */
  const [reachable, setReachable] = useState<boolean | null>(null)
  /** Bumped on a send, so the list below re-reads without polling localStorage. */
  const [historyRevision, setHistoryRevision] = useState(0)

  const decimals = findToken(tokens, sourceToken ?? '')?.decimals ?? 18
  const symbol = findToken(tokens, sourceToken ?? '')?.symbol ?? ''

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
      // Token addresses are chain-specific, so a choice this chain does not have means nothing here —
      // but one it *does* have is either the user's or their restored one, and must survive the load.
      setSourceToken((current) => {
        const known = current && loaded.some((token) => token.address.toLowerCase() === current.toLowerCase())
        return known ? current : (loaded[0]?.address ?? null)
      })
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
   * unanswered lookup leaves this null and listing routes still goes ahead.
   */
  useEffect(() => {
    if (!sourceToken) return
    let cancelled = false
    setReachable(null)
    void deliverableTokens({
      sellChainId: sourceChainId,
      sellToken: sourceToken,
      buyChainId: destinationChain,
      mode,
      providerKey,
    }).then((delivered) => {
      if (cancelled || delivered === null) return
      const wanted = deliveredToken.toLowerCase()
      setReachable(delivered.some((token) => token.address.toLowerCase() === wanted))
    })
    return () => {
      cancelled = true
    }
  }, [sourceChainId, sourceToken, destinationChain, deliveredToken, mode, providerKey])

  /** Remember the choices, so a reload mid-setup does not start over. Never the delivery mode. */
  useEffect(() => {
    if (!sourceToken) return
    saveBridgeForm(drop, { sourceChainId, sourceToken, amountText, onFailure, provider: providerKey })
  }, [drop, sourceChainId, sourceToken, amountText, onFailure, providerKey])

  /**
   * A route set is for one provider, pair, amount and destination. Any of them moving makes it stale.
   *
   * `account` is in here for two independent reasons, and its absence was a real defect: the routes are
   * priced for a sender, and the built transaction is the transaction *that account* sends. The wallet
   * can switch accounts without remounting this component, so nothing else would have cleared it.
   */
  useEffect(() => {
    setRoutes(null)
    setSelectedRouteId(null)
    setBuilt(null)
    setExpired(false)
    setSimulation(null)
    setAllowance(null)
    setBridgeHash(null)
    setRoutesError(null)
    setBuildError(null)
    setSendError(null)
  }, [providerKey, sourceChainId, sourceToken, amountText, onFailure, mode, account])

  /**
   * Build and check the selected route.
   *
   * Selecting is what triggers this, so only the route a person actually chose is ever built — and a
   * disabled route is refused by the library before any request goes out.
   */
  useEffect(() => {
    if (!routes || !selectedRouteId) return

    let cancelled = false
    setBuilding(true)
    setBuildError(null)
    setBuilt(null)
    setSimulation(null)
    setExpired(false)

    void buildAndVerifyRoute({ routes, routeId: selectedRouteId, providerKey })
      .then((quote) => {
        if (cancelled) return
        setBuilt(quote)
        setExpired(isQuoteExpired(quote))
      })
      .catch((cause: unknown) => {
        if (!cancelled) setBuildError(describeBridgeError(cause))
      })
      .finally(() => {
        if (!cancelled) setBuilding(false)
      })

    return () => {
      cancelled = true
    }
  }, [routes, selectedRouteId, providerKey])

  /** The allowance for whatever the built route actually asked for, which is per-route. */
  useEffect(() => {
    const approval = built?.approval
    if (!approval) {
      setAllowance(null)
      return
    }

    let cancelled = false
    void readBridgeAllowance({
      chainId: sourceChainId,
      token: approval.token,
      owner: account,
      spender: approval.spender,
    }).then((allowed) => {
      if (!cancelled) setAllowance(allowed)
    })
    return () => {
      cancelled = true
    }
  }, [built, sourceChainId, account])

  /** Does the source chain accept it? Advisory, and it says nothing about the destination chain. */
  useEffect(() => {
    if (!built) return
    let cancelled = false
    void simulationCheck({ quote: built, account }).then((check) => {
      if (!cancelled) setSimulation(check)
    })
    return () => {
      cancelled = true
    }
  }, [built, account])

  /**
   * Notice the moment the quote goes stale.
   *
   * One timeout at the expiry instant rather than a ticking interval — nothing else in this app polls,
   * and a single timer honours that. `onBridge` re-checks at click time anyway, because a laptop that
   * sleeps through the timer wakes up with a stale quote and a live button.
   */
  useEffect(() => {
    if (!built) return
    const remaining = built.expiresAt * 1000 - Date.now()
    if (remaining <= 0) {
      setExpired(true)
      return
    }
    const timer = setTimeout(() => setExpired(true), remaining)
    return () => clearTimeout(timer)
  }, [built])

  /**
   * Does the destination keeper already hold this recipe?
   *
   * Asked on the destination chain, never the wallet's — that is the whole reason `keeperUrl` takes a
   * chain id. A keeper that cannot be reached leaves this `unknown` rather than `none`: "we could not
   * ask" and "there is nobody to ask" lead to different sentences, and only one of them is worth
   * blocking on.
   */
  useEffect(() => {
    if (keeperUrl(destinationChain) === null) {
      setKeeperState('none')
      return
    }

    let cancelled = false
    setKeeperState('checking')
    void readKeeperDrop(drop, destinationChain)
      .then((held) => {
        if (!cancelled) setKeeperState(held ? 'registered' : 'unknown')
      })
      .catch(() => {
        if (!cancelled) setKeeperState('unknown')
      })
    return () => {
      cancelled = true
    }
  }, [destinationChain, drop])

  const wrongNetwork = walletChain !== null && walletChain !== sourceChainId
  const overBalance = amount !== null && balance !== null && amount > balance

  /**
   * The whole verdict, library and app together, through the library's own `summarise`.
   *
   * Merged rather than displayed in two places because a person deciding whether to sign should read
   * one list — three of these can only be answered with an RPC or the wallet, which is why they cannot
   * live in the library, not a reason to put them somewhere else on screen.
   *
   * Re-summarised rather than re-derived. Spelling the rule out here as `state !== 'pass'` is what made
   * every direct-mode send impossible: it counted `not-applicable` — "this mode has no payload, so
   * there is nothing to look for" — as a failure, while the library called the same quote sendable. One
   * function owns the rule, so the button and the evidence beside it cannot tell different stories.
   */
  const verification = useMemo(() => {
    if (!built) return null
    return summarise([
      ...built.verification.checks,
      ...walletChecks({
        quote: built,
        walletChainId: walletChain,
        balance,
        sellAmount: amount ?? 0n,
        allowance,
        symbol,
      }),
      ...(simulation ? [simulation] : []),
    ])
  }, [built, walletChain, balance, amount, allowance, symbol, simulation])

  const checks: readonly CheckOutcome[] = verification?.checks ?? []
  const blocking = verification?.blocking ?? []
  const approval = built?.approval ?? null
  const needsApproval = approval !== null && allowance !== null && allowance < approval.amount
  /**
   * An unreadable allowance is not permission.
   *
   * This used to require `allowance !== null` to be true before it could ask for an approval, so an RPC
   * that would not answer enabled a send that then reverted. Unknown blocks the bridge and *offers* the
   * approval: approving unnecessarily costs a click, and not approving costs a failed bridge.
   */
  const allowanceUnknown = approval !== null && allowance === null

  const canSend =
    built !== null &&
    blocking.length === 0 &&
    !expired &&
    !busy &&
    !wrongNetwork &&
    !needsApproval &&
    !allowanceUnknown &&
    bridgeHash === null

  const onFindRoutes = async () => {
    if (!amount || !sourceToken) return
    setRoutesError(null)
    setListing(true)
    setRoutes(null)
    setSelectedRouteId(null)
    setBuilt(null)
    try {
      const found = await listBridgeRoutes({
        plan,
        sender: account,
        sellChainId: sourceChainId,
        sellToken: sourceToken,
        sellAmount: amount,
        mode,
        onFailure,
        providerKey,
      })
      setRoutes(found)
      // Pre-select the best allowed one, because that is the choice a person would make anyway — but
      // only after they can see what was refused and why.
      setSelectedRouteId(found.routes.find((route) => route.allowed)?.id ?? null)
    } catch (cause) {
      setRoutesError(describeBridgeError(cause))
    } finally {
      setListing(false)
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
    if (!approval) return
    setSendError(null)
    setBusy(true)
    try {
      await approveBridge({ account, chainId: sourceChainId, approval })
      setAllowance(approval.amount)
    } catch (cause) {
      if (!isUserRejection(cause)) setSendError(describeBridgeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const onRebuild = () => {
    // Re-selecting the same route re-runs the build effect, which is the natural refresh gesture.
    const current = selectedRouteId
    setSelectedRouteId(null)
    setTimeout(() => setSelectedRouteId(current), 0)
  }

  const onBridge = async () => {
    if (!built) return
    setSendError(null)
    setBusy(true)
    try {
      // Before the money moves, never after: the keeper holds the appData pre-images the order book
      // needs, and in direct mode it is the only thing that will activate the drop at all.
      await ensureRegistered()
      const hash = await sendBridge({ account, quote: built })
      setBridgeHash(hash)

      // Written straight after the wallet returns, so a reload before the bridge fills still finds it.
      saveBridge({
        hash,
        mode,
        provider: providerKey,
        sourceChainId,
        destinationChainId: destinationChain,
        drop,
        label: recipe.label,
        route: built.route.name,
        sent: {
          symbol: built.input.token.symbol,
          amount: formatUnits(built.input.amount, built.input.token.decimals),
        },
        expected: {
          symbol: built.output.token.symbol,
          amount: formatUnits(built.output.amount, built.output.token.decimals),
        },
        sentAt: Date.now(),
      })
      setHistoryRevision((n) => n + 1)
    } catch (cause) {
      if (!isUserRejection(cause)) setSendError(describeBridgeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const explorer = blockExplorer(destinationChain)

  return (
    <>
      <BridgeHistory revision={historyRevision} />

      <section className="bridge">
        <h2>Bridge &amp; Swap</h2>
        <p className="hint">
          {mode === 'direct'
            ? `The bridge pays the drop address on ${chainLabel(destinationChain)} directly. The keeper activates it once the money lands, and your order goes live then.`
            : `The bridge pays a receiver contract on ${chainLabel(destinationChain)}, which forwards the tokens to the drop and runs its recipe in the same transaction.`}
        </p>

        <BridgeProviderPicker value={providerKey} onChange={setProviderKey} busy={busy} />

        <h3>1 · The drop you are funding</h3>
        <dl className="facts">
          <dt>Recipe</dt>
          <dd>{recipe.label}</dd>
          <dt>Lands on</dt>
          <dd>{chainLabel(destinationChain)}</dd>
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
                {chainLabel(id)}
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
            'Balance unavailable — this chain’s public RPC did not answer. You can still enter an amount.'
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
        {overBalance && <p className="error">That is more than you hold on {chainLabel(sourceChainId)}.</p>}

        {reachable === false && (
          <p className="error">
            {providerInfo(providerKey)?.name ?? 'This bridge'} cannot deliver <code>{deliveredToken}</code>{' '}
            on {chainLabel(destinationChain)} from {chainLabel(sourceChainId)} through any bridge. Pick
            another source chain, or a recipe whose sell token can be delivered there.
          </p>
        )}

        {/*
          Here rather than only beside the send button. The source chain is chosen just above, and the
          switch is a precondition of everything below it — finding that out at the last step means
          going back up to understand why.
        */}
        {wrongNetwork && (
          <p className="hint">
            Your wallet is on {chainLabel(walletChain as number)}, so the bridge transaction cannot be
            sent yet.{' '}
            <button className="link" onClick={() => void switchChain(sourceChainId)}>
              Switch to {chainLabel(sourceChainId)}
            </button>
          </p>
        )}

        <h3>3 · How it is delivered</h3>
        <label className="radio">
          <input
            type="radio"
            name="mode"
            checked={mode === 'direct'}
            onChange={() => setMode('direct')}
            disabled={busy}
          />
          <span>
            <strong>Straight to the drop.</strong> The bridge pays the drop address and the keeper
            activates it once the money lands — usually within a minute of the fill. Works with every
            bridge, so far more routes are available, and nothing can go wrong on arrival: the address
            belongs to this recipe alone.
          </span>
        </label>
        <label className="radio">
          <input
            type="radio"
            name="mode"
            checked={mode === 'atomic'}
            onChange={() => setMode('atomic')}
            disabled={busy || !capability.atomicAvailable}
          />
          <span>
            <strong>Activate inside the bridge transaction.</strong>{' '}
            {!capability.atomicAvailable && <em>Not available.</em>} The order would be live the instant
            the bridge fills, and the relayer would pay the activation gas — but that needs a bridge
            that really runs a destination payload, and no quote can tell you whether one does: a route
            that ignores the payload quotes identically to one that honours it.
          </span>
        </label>

        {!capability.atomicAvailable && (
          <div className="hint warn-box">
            <p>
              No bridge has been watched running a destination payload on-chain, so there is nothing
              here we can offer honestly. A delivery that is not executed sits in a contract shared by
              everyone, which forwards its whole balance to whichever drop its caller names — so anyone
              may sweep it, and they do.
            </p>
            <ul className="hint hint-list">
              {capability.known.map(({ name, execution }) => (
                <li key={name}>{describeExecution(name, execution)}</li>
              ))}
            </ul>
            <p>
              Deliver straight to the drop instead. It reaches more routes, and there is nothing in the
              path to redirect. See <code>docs/BRIDGING.md</code>.
            </p>
          </div>
        )}

        {mode === 'atomic' && (
          <fieldset className="subsection delivery-failure">
            <legend>If the recipe will not run</legend>
            <p className="hint">
              A recipe can legitimately decline — a minimum-balance guard refusing a bridge&apos;s first
              tranche is the guard working. The tokens have arrived either way, so this is where they go.
            </p>
            {ON_FAILURE.map((option) => (
              <label key={option} className="radio">
                <input
                  type="radio"
                  name="onFailure"
                  checked={onFailure === option}
                  onChange={() => setOnFailure(option)}
                  disabled={busy}
                />
                {option === 'leave-at-drop' ? (
                  <span>
                    <strong>Leave at the drop.</strong> They wait at the drop address for the rest to
                    arrive, and a keeper activates once the recipe can run. The safe choice with any
                    recipe.
                  </span>
                ) : (
                  <span>
                    <strong>Send back to me.</strong> Returned to <code>{recipe.owner}</code>. Do not use
                    this with a minimum-balance guard — every tranche would bounce instead of
                    accumulating.
                  </span>
                )}
              </label>
            ))}
          </fieldset>
        )}

        <h3>4 · Routes</h3>
        <button
          onClick={() => void onFindRoutes()}
          disabled={!amount || !sourceToken || overBalance || listing || busy}
        >
          {listing ? 'Finding routes…' : routes ? 'Find routes again' : 'Find routes'}
        </button>

        {routesError && <p className="error">{routesError}</p>}

        {routes && (
          <BridgeRouteList
            listing={routes}
            selectedId={selectedRouteId}
            onSelect={setSelectedRouteId}
            busy={busy || building}
          />
        )}

        <h3>5 · Review what you are signing</h3>
        {!routes ? (
          <p className="hint">Find routes first, then pick one to see exactly what it would do.</p>
        ) : building ? (
          <p className="hint">Building the transaction and checking it…</p>
        ) : buildError ? (
          <p className="error">{buildError}</p>
        ) : !built ? (
          <p className="hint">Pick a route above.</p>
        ) : (
          <BridgeReview quote={built} checks={checks} compiled={compiled} expired={expired} />
        )}

        {expired && built && (
          <p className="hint">
            <button className="link" onClick={onRebuild} disabled={busy}>
              Get a fresh transaction
            </button>{' '}
            for the same route. Nothing else on this page changes.
          </p>
        )}

        <h3>6 · Send it</h3>
        <KeeperNote state={keeperState} chainId={destinationChain} mode={mode} />

        {(needsApproval || allowanceUnknown) && (
          <button onClick={() => void onApprove()} disabled={busy || wrongNetwork}>
            Approve {symbol}
          </button>
        )}

        <button onClick={() => void onBridge()} disabled={!canSend}>
          {busy ? 'Sending…' : 'Bridge and activate'}
        </button>

        {built && blocking.length > 0 && (
          <p className="error">
            {blocking.length === 1 ? 'One check did not pass' : `${blocking.length} checks did not pass`}
            , so this cannot be sent. There is no override: a check that fails means the bytes above do
            not do what this page says they do.
          </p>
        )}

        {sendError && <p className="error">{sendError}</p>}

        {bridgeHash && (
          <>
            <p>
              {mode === 'direct'
                ? 'Sent. The bridge fills in a few minutes; the keeper then activates the drop and places the order. Nothing else is needed from you.'
                : 'Sent. The bridge fills in a few minutes, and the order is placed in the same transaction as the fill.'}
            </p>
            {/* Three links because they are three different questions: has the bridge filled, did the
                money land, and is the order live. The last is the one that says it worked. */}
            <ul className="hint hint-list">
              <li>
                <a href={bridgeExplorerUrl(bridgeHash, providerKey)} target="_blank" rel="noreferrer">
                  Track the bridge
                </a>{' '}
                — the source transaction, until it fills on {chainLabel(destinationChain)}.
              </li>
              <li>
                <a href={`${explorer.url}/address/${drop}`} target="_blank" rel="noreferrer">
                  The drop on {explorer.name}
                </a>{' '}
                — the tokens arriving, and the activation that spends them.
                {mode === 'direct' && ' The balance sitting here briefly is expected and safe.'}
              </li>
              <li>
                <a href={`${cowExplorer(destinationChain)}/address/${drop}`} target="_blank" rel="noreferrer">
                  The order in CoW Explorer
                </a>{' '}
                — appears once the drop has been activated.
              </li>
            </ul>
          </>
        )}
      </section>
    </>
  )
}

function KeeperNote({ state, chainId, mode }: { state: KeeperState; chainId: number; mode: DeliveryMode }) {
  if (state === 'registered') {
    return <p className="hint">The {chainLabel(chainId)} keeper already holds this recipe.</p>
  }
  if (state === 'none') {
    // In direct mode the keeper is the *only* thing that will activate, so this stops being a caveat
    // and becomes the reason nothing will happen.
    return mode === 'direct' ? (
      <p className="error">
        No keeper is configured for {chainLabel(chainId)}, and in this mode the keeper is the only thing
        that activates the drop. The money will arrive safely and then sit there until you press
        Activate yourself.
      </p>
    ) : (
      <p className="hint">
        No keeper is configured for {chainLabel(chainId)}. The bridge still activates the drop on
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
      The recipe is handed to the {chainLabel(chainId)} keeper first, before anything is sent.
    </p>
  )
}
