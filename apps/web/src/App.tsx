import {
  compileRecipe,
  getDropChain,
  swapOnArrival,
  twapOnArrival,
  type DropRecipeJson,
} from '@cowprotocol/cow-drop-sdk'
import { formatUnits, isAddress, type Address } from 'viem'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  DEFAULT_CHAIN_ID,
  blockExplorer,
  connect,
  cowExplorer,
  isUserRejection,
  onChainChanged,
  switchChain,
  walletChainId,
  wrappedNative,
} from './lib/chain.js'
import { applySlippage, quoteMarketPrice, type MarketQuote } from './lib/quote.js'
import {
  activateDrop,
  postPlacedOrders,
  forgetChainReadiness,
  probeChainReadiness,
  readDropStatus,
  type DropStatus,
} from './lib/drop.js'
import { GNOSIS_TOKENS } from './lib/tokens.js'
import { fetchTokenList, findToken, type TokenInfo } from './lib/tokenList.js'
import { NetworkPicker } from './components/NetworkPicker.js'
import { isSaved, recipeFromHash, recipeToHash, saveDrop } from './lib/storage.js'
import { TokenPicker } from './components/TokenPicker.js'
import { DropAddress } from './components/DropAddress.js'
import { RecipeJson } from './components/RecipeJson.js'
import { RescuePanel } from './components/RescuePanel.js'
import { SavedDrops } from './components/SavedDrops.js'
import { TerminalPanel } from './components/TerminalPanel.js'
import { StepTable } from './components/StepTable.js'

/**
 * Which recipe to build. Named for what the user sees: the SDK calls these templates, because
 * there a template is a function that produces a recipe — a distinction worth keeping in code and
 * not worth making a user learn.
 */
type RecipeKind = 'swap' | 'twap'

const PLACEHOLDER_OWNER: Address = '0x0000000000000000000000000000000000000001'

/**
 * Owners that make a drop unrecoverable, which the UI must never hand out an address for.
 *
 * Both rescue paths are `msg.sender == owner` checks, and nothing can transact as either of these:
 * `0x…0001` is the ecrecover precompile, `0x0` is nobody. A drop owned by one of them can only ever
 * run its recipe — no sweep, no hatch, not for anyone. And since the owner also defaults to being the
 * order's receiver, the bought tokens land there too.
 *
 * `compileRecipe` cannot catch this: both are well-formed addresses, indistinguishable at the SDK
 * layer from an owner the user meant. Only the form knows the field was left empty, so only the form
 * can refuse.
 */
const UNUSABLE_OWNERS: ReadonlySet<string> = new Set([
  PLACEHOLDER_OWNER.toLowerCase(),
  '0x0000000000000000000000000000000000000000',
])

interface FormState {
  chainId: number
  recipeKind: RecipeKind
  owner: string
  sellToken: Address
  buyToken: Address
  receiver: string
  limitPrice: string
  validityMinutes: string
  parts: string
  partMinutes: string
  wrapNative: boolean
}

const INITIAL: FormState = {
  chainId: DEFAULT_CHAIN_ID,
  recipeKind: 'swap',
  owner: '',
  sellToken: GNOSIS_TOKENS[0]!.address,
  buyToken: GNOSIS_TOKENS[2]!.address,
  receiver: '',
  limitPrice: '0.02',
  validityMinutes: '30',
  parts: '12',
  partMinutes: '60',
  wrapNative: false,
}

/** Build the recipe JSON from the form. Pure, so the address updates as the user types. */
function toRecipe(form: FormState, tokens: TokenInfo[]): DropRecipeJson {
  const owner = (isAddress(form.owner) ? form.owner : PLACEHOLDER_OWNER) as Address
  const receiver = isAddress(form.receiver) ? (form.receiver as Address) : undefined
  const sellDecimals = findToken(tokens, form.sellToken)?.decimals ?? 18
  const buyDecimals = findToken(tokens, form.buyToken)?.decimals ?? 18
  const limitPrice = { price: form.limitPrice, sellDecimals, buyDecimals }
  const wrapNative = form.wrapNative ? wrappedNative(form.chainId) : undefined

  if (form.recipeKind === 'twap') {
    return twapOnArrival({
      chainId: form.chainId,
      owner,
      sellToken: form.sellToken,
      buyToken: form.buyToken,
      receiver,
      parts: Number(form.parts),
      partDuration: Number(form.partMinutes) * 60,
      limitPrice,
      wrapNative,
    })
  }

  return swapOnArrival({
    chainId: form.chainId,
    owner,
    sellToken: form.sellToken,
    buyToken: form.buyToken,
    receiver,
    validitySeconds: Number(form.validityMinutes) * 60,
    limitPrice,
    wrapNative,
  })
}

export function App() {
  const [form, setForm] = useState<FormState>(INITIAL)
  const [account, setAccount] = useState<Address | null>(null)
  const [status, setStatus] = useState<DropStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * Set when the JSON panel, the URL fragment or a saved drop supplies a recipe, which then takes
   * precedence over the form.
   */
  const [imported, setImported] = useState<DropRecipeJson | null>(() => recipeFromHash(window.location.hash))
  const [saved, setSaved] = useState(false)
  /**
   * Quote state. Deliberately *not* part of FormState: the reference amount exists only to get a
   * price out of the API and must never leak into the recipe, since a drop cannot commit to an amount.
   */
  const [referenceAmount, setReferenceAmount] = useState('100')
  const [quote, setQuote] = useState<MarketQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  /** Loaded from CoW's token list; the built-in list is the offline fallback. */
  const [tokens, setTokens] = useState<TokenInfo[]>(GNOSIS_TOKENS)
  const [walletChain, setWalletChain] = useState<number | null>(null)
  /**
   * Which required contracts are missing on the selected chain — `null` while the answer is still
   * being fetched.
   *
   * Separate from `status`, which needs a compiled recipe and a sell token before it will read
   * anything. Readiness has to be known *before* we are willing to render an address, so it cannot
   * depend on the recipe being complete.
   */
  const [chainMissing, setChainMissing] = useState<string[] | null>(null)
  /**
   * Why the readiness probe failed, if it did.
   *
   * Without this an unreachable RPC is indistinguishable from a slow one, and the page sits on
   * "checking…" forever — which it did, because the only error output on the page lived inside a
   * section that this very check was hiding.
   */
  const [probeError, setProbeError] = useState<string | null>(null)
  /** Bumped by the retry button to re-run the probe after clearing its cached answer. */
  const [probeAttempt, setProbeAttempt] = useState(0)

  const recipe = useMemo(() => imported ?? toRecipe(form, tokens), [imported, form, tokens])

  const compiled = useMemo(() => {
    try {
      return { ok: true as const, value: compileRecipe(recipe) }
    } catch (cause) {
      return { ok: false as const, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [recipe])

  /**
   * The chain the drop actually resolves on.
   *
   * Not always `form.chainId`: an imported recipe carries its own, and it is the recipe that decides
   * where the address lives. Readiness must follow the recipe, or we could vet one chain and show an
   * address for another.
   */
  const dropChainId = compiled.ok ? compiled.value.deployment.chainId : form.chainId
  const chainName = getDropChain(dropChainId)?.name ?? `chain ${dropChainId}`

  /**
   * Whether the recipe's owner is one nobody can act as.
   *
   * Read off the *recipe*, not the form, so an imported file is checked too — this is exactly how the
   * first bad recipe would come back if it were re-opened.
   */
  const ownerUnusable = UNUSABLE_OWNERS.has(recipe.owner.toLowerCase())

  /**
   * What is wrong with the owner *field*, as opposed to with the recipe.
   *
   * The section-3 gate is the backstop that stops the money moving; this is the part that says which
   * input caused it. Reported against `form.owner` rather than the recipe, because an imported recipe
   * does not come from this field and blaming it would be wrong.
   */
  const ownerError = imported
    ? null
    : form.owner.trim() === ''
      ? 'Required. Without it the drop has no owner, and an unowned drop can never be recovered by anyone.'
      : !isAddress(form.owner)
        ? 'Not a valid address.'
        : UNUSABLE_OWNERS.has(form.owner.toLowerCase())
          ? 'Nobody can transact as this address, so a drop owned by it could never be recovered.'
          : null

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setImported(null)
    setForm((previous) => ({ ...previous, [key]: value }))
  }

  /**
   * Change network, and ask the wallet to come along.
   *
   * The selection changes either way: the page is useful without a wallet, since computing an address
   * needs nothing on-chain. A declined prompt is not an error — the mismatch banner already says the
   * wallet is elsewhere — so only real failures surface.
   */
  const onNetworkChange = async (chainId: number) => {
    set('chainId', chainId)
    setError(null)
    if (!account) return

    try {
      await switchChain(chainId)
      setWalletChain(chainId)
    } catch (cause) {
      if (isUserRejection(cause)) return
      setError(`Could not switch the wallet's network: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const refresh = useCallback(async () => {
    if (!compiled.ok) return
    const sellStep = recipe.steps.find((step) => 'sellToken' in step)
    const sellToken = sellStep && 'sellToken' in sellStep ? sellStep.sellToken : undefined
    if (!sellToken) return
    try {
      setStatus(await readDropStatus(compiled.value, sellToken))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [compiled, recipe])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    setChainMissing(null)
    setProbeError(null)
    probeChainReadiness(dropChainId)
      .then((missing) => {
        if (!cancelled) setChainMissing(missing)
      })
      .catch((cause) => {
        if (!cancelled) setProbeError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [dropChainId, probeAttempt])

  const retryProbe = () => {
    forgetChainReadiness(dropChainId)
    setProbeAttempt((attempt) => attempt + 1)
  }

  /**
   * Keep the form in step with an imported recipe.
   *
   * The recipe is mirrored into the URL, so a reload comes back as an import while the form is still
   * at its initial values — which showed an empty owner field next to an address derived from the
   * owner you had set before the reload. Only the fields the form can represent faithfully are
   * hydrated; the rest is why `imported` overrides the form in the first place.
   */
  useEffect(() => {
    if (!imported) return
    setForm((previous) => ({ ...previous, owner: imported.owner, chainId: imported.chainId }))
  }, [imported])

  // The recipe lives in the URL, so a bookmark or a reload is enough to get it back. Uses replaceState
  // rather than a hash assignment, to avoid filling the back button with every keystroke.
  useEffect(() => {
    window.history.replaceState(null, '', `#${recipeToHash(recipe)}`)
  }, [recipe])

  useEffect(() => {
    if (compiled.ok) setSaved(isSaved(compiled.value.address, form.chainId))
  }, [compiled, form.chainId])

  useEffect(() => {
    void fetchTokenList(form.chainId).then((loaded) => {
      setTokens(loaded)

      // Token addresses are chain-specific, so the previous chain's selection is meaningless here.
      // Left alone, the picker would read blank while the recipe silently compiled with an address
      // that does not exist on this chain — a valid-looking order for a token that isn't there.
      setForm((previous) => {
        if (loaded.length === 0) return previous

        const known = (address: string) => loaded.some((t) => t.address.toLowerCase() === address.toLowerCase())
        if (known(previous.sellToken) && known(previous.buyToken)) return previous

        const sell = findToken(loaded, wrappedNative(form.chainId)) ?? loaded[0]!
        const buy = loaded.find((t) => t.address !== sell.address) ?? sell
        return { ...previous, sellToken: sell.address, buyToken: buy.address }
      })
    })
  }, [form.chainId])

  // Default to whatever network the wallet is already on, when we support it.
  useEffect(() => {
    void walletChainId().then((chain) => {
      setWalletChain(chain)
      if (chain !== null && getDropChain(chain)) {
        setForm((previous) => (previous.chainId === DEFAULT_CHAIN_ID ? { ...previous, chainId: chain } : previous))
      }
    })
  }, [])

  // And keep following it, so switching in the wallet moves the page rather than leaving the two
  // disagreeing. Switching here asks the wallet too, so this closes the loop from both directions.
  useEffect(
    () =>
      onChainChanged((chain) => {
        setWalletChain(chain)
        if (getDropChain(chain)) setForm((previous) => ({ ...previous, chainId: chain }))
      }),
    [],
  )

  const onConnect = async () => {
    setError(null)
    try {
      const connected = await connect(form.chainId)
      setAccount(connected)
      // Default the owner to the connected account, so the user keeps the recovery escape hatch.
      if (!isAddress(form.owner)) set('owner', connected)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /**
   * Remember a recipe, since its address is useless without it.
   *
   * Called wherever the next step might plausibly be sending money — copying the address, downloading
   * the file, activating — rather than only on an explicit save, because the failure this prevents is
   * someone funding an address and closing the tab.
   */
  const remember = () => {
    if (!compiled.ok) return
    saveDrop({ address: compiled.value.address, recipe })
    setSaved(true)
  }

  const onActivate = async () => {
    if (!account || !compiled.ok) return
    remember()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const { hash, receipt } = await activateDrop({ account, recipe })
      setMessage(`Activated in ${hash}`)

      const posted = await postPlacedOrders(receipt, compiled.value.address, form.chainId)
      if (posted.length > 0) {
        setMessage(`Activated, and posted ${posted.length} order(s): ${posted.join(', ')}`)
      }
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const sellToken = findToken(tokens, form.sellToken)
  const buyToken = findToken(tokens, form.buyToken)

  const onQuote = async () => {
    setQuoting(true)
    setError(null)
    setQuote(null)
    try {
      const decimals = sellToken?.decimals ?? 18
      const [whole, fraction = ''] = referenceAmount.trim().split('.')
      const atomic = BigInt(`${whole || '0'}${fraction.padEnd(decimals, '0').slice(0, decimals)}`)
      if (atomic <= 0n) throw new Error('Reference amount must be greater than zero')

      setQuote(
        await quoteMarketPrice({
          sellToken: form.sellToken,
          buyToken: form.buyToken,
          sellAmount: atomic,
          sellDecimals: decimals,
          buyDecimals: buyToken?.decimals ?? 18,
          // The drop is the order's owner, so quote it as the drop.
          from: compiled.ok ? compiled.value.address : PLACEHOLDER_OWNER,
          chainId: form.chainId,
        }),
      )
    } catch (cause) {
      setError(`Quote failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setQuoting(false)
    }
  }

  return (
    <main>
      {/*
        Top level on purpose. This used to live inside the status section, which meant any gate that
        hid that section also swallowed every error it was supposed to explain.
      */}
      {error && (
        <p className="error banner" role="alert">
          {error}
        </p>
      )}
      <header>
        <div className="brand">
          {/* Served from public/ rather than imported, so the favicon and og:image can share it. */}
          <img src="/logo.png" alt="" width={96} height={96} className="brand-mark" />
          <div>
            <h1>cow-drop</h1>
            <p className="tagline">
              Drop your tokens into an address and the cow does the rest. The recipe is committed
              into the address itself, so anyone can trigger it and nobody has to sign anything.
            </p>
          </div>
        </div>
        <div className="wallet">
          {account ? (
            <span className="pill">{account}</span>
          ) : (
            <button onClick={onConnect}>Connect wallet</button>
          )}
        </div>
      </header>

      <SavedDrops
        currentAddress={compiled.ok ? compiled.value.address : null}
        onLoad={(loaded) => {
          setImported(loaded)
          setError(null)
        }}
      />

      <section>
        <h2>1 &middot; Pick a recipe</h2>
        <div className="tabs">
          <button
            className={form.recipeKind === 'swap' ? 'active' : ''}
            onClick={() => set('recipeKind', 'swap')}
          >
            Swap on arrival
          </button>
          <button
            className={form.recipeKind === 'twap' ? 'active' : ''}
            onClick={() => set('recipeKind', 'twap')}
          >
            TWAP on arrival
          </button>
        </div>
        <p className="hint">
          {form.recipeKind === 'swap'
            ? 'Sells whatever lands at the address once, at your limit price. Uses the pre-sign path: no watch tower needed, but the order is posted to the API after activation.'
            : 'Splits whatever lands at the address into parts and sells them over time. Uses ComposableCoW: after one activation the watch tower posts each part unattended.'}
        </p>
      </section>

      <section>
        <h2>2 &middot; Parameters</h2>
        <NetworkPicker
          chainId={form.chainId}
          walletChainId={walletChain}
          onChange={(chainId) => void onNetworkChange(chainId)}
        />
        <div className="grid">
          <label>
            Owner (can always recover the funds)
            <input
              placeholder="Paste your address, or connect a wallet"
              value={form.owner}
              onChange={(event) => set('owner', event.target.value)}
              aria-invalid={ownerError !== null}
              aria-describedby={ownerError ? 'owner-error' : undefined}
            />
            {ownerError && (
              <span className="field-error" id="owner-error">
                {ownerError}
              </span>
            )}
          </label>
          <TokenPicker
            label="Sell token"
            tokens={tokens}
            value={form.sellToken}
            chainId={form.chainId}
            onChange={(address) => set('sellToken', address)}
          />
          <TokenPicker
            label="Buy token"
            tokens={tokens}
            value={form.buyToken}
            chainId={form.chainId}
            onChange={(address) => set('buyToken', address)}
          />
          <label>
            Limit price (buy per sell)
            <input value={form.limitPrice} onChange={(event) => set('limitPrice', event.target.value)} />
          </label>
          <label>
            Receiver (blank = the owner)
            <input
              placeholder="0x…"
              value={form.receiver}
              onChange={(event) => set('receiver', event.target.value)}
            />
          </label>
          {form.recipeKind === 'swap' ? (
            <label>
              Order validity (minutes)
              <input value={form.validityMinutes} onChange={(event) => set('validityMinutes', event.target.value)} />
            </label>
          ) : (
            <>
              <label>
                Parts
                <input value={form.parts} onChange={(event) => set('parts', event.target.value)} />
              </label>
              <label>
                Minutes per part
                <input value={form.partMinutes} onChange={(event) => set('partMinutes', event.target.value)} />
              </label>
            </>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.wrapNative}
              onChange={(event) => set('wrapNative', event.target.checked)}
            />
            Wrap the native token first
          </label>
        </div>
        <div className="quote">
          <label>
            Reference amount (for the quote only, never part of the recipe)
            <input value={referenceAmount} onChange={(event) => setReferenceAmount(event.target.value)} />
          </label>
          <div className="actions">
            <button onClick={() => void onQuote()} disabled={quoting}>
              {quoting ? 'Quoting…' : 'Get market price'}
            </button>
            {quote && (
              <>
                <span className="quote-price">
                  market <strong>{quote.price}</strong> {buyToken?.symbol ?? ''} per {sellToken?.symbol ?? ''}
                </span>
                {[0.5, 1, 5].map((slippage) => (
                  <button key={slippage} onClick={() => set('limitPrice', applySlippage(quote.price, slippage))}>
                    −{slippage}%
                  </button>
                ))}
              </>
            )}
          </div>
          <p className="hint">
            A drop cannot know its amount in advance, so only the quote&apos;s <em>price</em> is used —
            but the amount still matters, because quoting too little lets the fee dominate and makes the
            market look worse than it is. The −% buttons set the limit price below market.
          </p>
        </div>

        <p className="hint">
          Bought tokens go to the <strong>receiver</strong>, defaulting to the owner. Set it to the
          zero address to leave them in the drop instead — it can&apos;t default to the drop&apos;s own
          address, because that address is derived from these parameters and naming it here would be
          circular.
        </p>
      </section>

      {compiled.ok ? (
        <>
          {probeError !== null ? (
            <section>
              <h2>3 &middot; Could not check {chainName}</h2>
              <p className="warn">
                The address is withheld because we could not confirm the contracts are there, not
                because they are missing. Unverified is not the same as unsafe, but it is not a good
                enough reason to show you somewhere to send money.
              </p>
              <p className="error">{probeError}</p>
              <div className="actions">
                <button onClick={retryProbe}>Try again</button>
              </div>
            </section>
          ) : chainMissing === null ? (
            <section>
              <h2>3 &middot; Your drop address</h2>
              <p className="hint">
                Checking whether {chainName} has the contracts a drop needs&hellip;
              </p>
            </section>
          ) : chainMissing.length > 0 ? (
            <section>
              <h2>3 &middot; Not available on {chainName} yet</h2>
              <p className="warn">
                <strong>{chainMissing.join(', ')}</strong>{' '}
                {chainMissing.length > 1 ? 'are' : 'is'} not deployed on {chainName}, so the drop
                address is withheld here rather than shown.
              </p>
              <p className="hint">
                Withheld because an address is only worth having if something can act on it. Funding
                one on this chain would strand the money: activation needs{' '}
                <code>DropExecutor</code> and <code>DropRecipes</code>, and the owner&apos;s rescue
                hatch needs <code>COWShedExecutorFactory</code> — so with these missing there is no
                path out, not even for you. Nothing is lost forever, since the addresses are
                deterministic and deploying the stack later would unstick it, but that is a wait with
                no deadline attached to it.
              </p>
              <p className="hint">
                The recipe itself is fine. It resolves to the same address on every chain, so this one
                is already correct here and will not move once the contracts land — switch the network
                above to a chain without this label to see it and fund it.
              </p>
            </section>
          ) : ownerUnusable ? (
            <section>
              <h2>3 &middot; Set an owner first</h2>
              <p className="warn">
                The owner field is empty, so the drop address is withheld until you fill it in.
              </p>
              <p className="hint">
                The owner is the only party who can ever recover a funded drop: both rescue paths are{' '}
                <code>msg.sender == owner</code> checks. Left empty it would fall back to{' '}
                <code>{PLACEHOLDER_OWNER}</code>, which is the ecrecover precompile — an address nobody
                holds the key to. It would also become the order&apos;s receiver by default, so the
                bought tokens would go there too. A drop like that can still be funded and still
                activate, and the money would be unreachable from the first transfer onward.
              </p>
              <p className="hint">
                Paste an address above, or connect a wallet and it fills itself in. Note the owner is
                part of the address derivation, so setting it produces a <em>different</em> drop
                address — it cannot be added to one you have already funded.
              </p>
            </section>
          ) : (
            <>
              <section>
                <h2>3 &middot; Your drop address</h2>
                <DropAddress
                  address={compiled.value.address}
                  saved={saved}
                  onRemember={remember}
                  recipe={recipe}
                />
              </section>

              <section>
                <h2>4 &middot; What the address commits to</h2>
                <StepTable calls={compiled.value.recipe.calls} setupData={compiled.value.setupData} />
              </section>

              <section>
                <h2>5 &middot; Status</h2>
                {status ? (
                  <ul className="status">
                    <li>
                      Balance at drop:{' '}
                      <strong>
                        {formatUnits(status.balance, sellToken?.decimals ?? 18)} {sellToken?.symbol ?? ''}
                      </strong>
                      {status.nativeBalance > 0n ? ` (+ ${formatUnits(status.nativeBalance, 18)} xDAI)` : ''}
                    </li>
                    <li>Drop deployed: <strong>{status.deployed ? 'yes' : 'not yet'}</strong></li>
                    {status.missing.length > 0 && (
                      <li className="warn">
                        {status.missing.join(' and ')} {status.missing.length > 1 ? 'are' : 'is'} not
                        deployed on {getDropChain(form.chainId)?.name ?? form.chainId} yet, so activation
                        will revert. The cow-shed contracts a drop is derived from are already live, and
                        the addresses are deterministic — so this drop address is correct now and will not
                        change once the missing pieces are deployed.
                      </li>
                    )}
                  </ul>
                ) : (
                  <p className="hint">Reading chain state…</p>
                )}

                <div className="actions">
                  <button onClick={() => void refresh()}>Refresh</button>
                  <button
                    onClick={() => void onActivate()}
                    disabled={!account || busy || (status?.missing.length ?? 0) > 0}
                  >
                    {busy ? 'Activating…' : 'Activate drop'}
                  </button>
                  <a
                    href={`${cowExplorer(form.chainId)}/address/${compiled.value.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Orders on CoW Explorer
                  </a>
                  <a
                    href={`${blockExplorer(form.chainId).url}/address/${compiled.value.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Balances on {blockExplorer(form.chainId).name}
                  </a>
                </div>

                {message && <p className="ok">{message}</p>}

                <TerminalPanel compiled={compiled.value} />
              </section>

              <section>
                <h2>6 &middot; If something goes wrong</h2>
                <RescuePanel
                  compiled={compiled.value}
                  account={account}
                  deployed={status?.deployed ?? false}
                  sellToken={form.sellToken}
                  tokens={tokens}
                />
              </section>

              <section>
                <h2>7 &middot; Recipe file</h2>
                <RecipeJson
                  recipe={recipe}
                  address={compiled.value.address}
                  onImport={(next) => {
                    setImported(next)
                    setError(null)
                  }}
                  onError={setError}
                  onRemember={remember}
                />
              </section>
            </>
          )}
        </>
      ) : (
        <section>
          <p className="error">{compiled.error}</p>
        </section>
      )}
    </main>
  )
}
