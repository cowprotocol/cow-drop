import { compileRecipe, swapOnArrival, twapOnArrival, type DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import { formatUnits, isAddress, type Address } from 'viem'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { BLOCK_EXPLORER, CHAIN, COW_EXPLORER, WRAPPED_NATIVE, connect } from './lib/chain.js'
import { applySlippage, quoteMarketPrice, type MarketQuote } from './lib/quote.js'
import { activateDrop, postPlacedOrders, readDropStatus, type DropStatus } from './lib/drop.js'
import { GNOSIS_TOKENS, findToken } from './lib/tokens.js'
import { DropAddress } from './components/DropAddress.js'
import { RecipeJson } from './components/RecipeJson.js'
import { RescuePanel } from './components/RescuePanel.js'
import { TerminalPanel } from './components/TerminalPanel.js'
import { StepTable } from './components/StepTable.js'

/**
 * Which recipe to build. Named for what the user sees: the SDK calls these templates, because
 * there a template is a function that produces a recipe — a distinction worth keeping in code and
 * not worth making a user learn.
 */
type RecipeKind = 'swap' | 'twap'

const PLACEHOLDER_OWNER: Address = '0x0000000000000000000000000000000000000001'

interface FormState {
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
function toRecipe(form: FormState): DropRecipeJson {
  const owner = (isAddress(form.owner) ? form.owner : PLACEHOLDER_OWNER) as Address
  const receiver = isAddress(form.receiver) ? (form.receiver as Address) : undefined
  const sellDecimals = findToken(form.sellToken)?.decimals ?? 18
  const buyDecimals = findToken(form.buyToken)?.decimals ?? 18
  const limitPrice = { price: form.limitPrice, sellDecimals, buyDecimals }
  const wrapNative = form.wrapNative ? (WRAPPED_NATIVE.address as Address) : undefined

  if (form.recipeKind === 'twap') {
    return twapOnArrival({
      chainId: CHAIN.id,
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
    chainId: CHAIN.id,
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
  /** Set when the JSON panel supplies a recipe, which then takes precedence over the form. */
  const [imported, setImported] = useState<DropRecipeJson | null>(null)
  /**
   * Quote state. Deliberately *not* part of FormState: the reference amount exists only to get a
   * price out of the API and must never leak into the recipe, since a drop cannot commit to an amount.
   */
  const [referenceAmount, setReferenceAmount] = useState('100')
  const [quote, setQuote] = useState<MarketQuote | null>(null)
  const [quoting, setQuoting] = useState(false)

  const recipe = useMemo(() => imported ?? toRecipe(form), [imported, form])

  const compiled = useMemo(() => {
    try {
      return { ok: true as const, value: compileRecipe(recipe) }
    } catch (cause) {
      return { ok: false as const, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [recipe])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setImported(null)
    setForm((previous) => ({ ...previous, [key]: value }))
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

  const onConnect = async () => {
    setError(null)
    try {
      const connected = await connect()
      setAccount(connected)
      // Default the owner to the connected account, so the user keeps the recovery escape hatch.
      if (!isAddress(form.owner)) set('owner', connected)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const onActivate = async () => {
    if (!account || !compiled.ok) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const { hash, receipt } = await activateDrop({ account, recipe })
      setMessage(`Activated in ${hash}`)

      const posted = await postPlacedOrders(receipt, compiled.value.address)
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

  const sellToken = findToken(form.sellToken)
  const buyToken = findToken(form.buyToken)

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
        <div className="grid">
          <label>
            Owner (can always recover the funds)
            <input
              placeholder={PLACEHOLDER_OWNER}
              value={form.owner}
              onChange={(event) => set('owner', event.target.value)}
            />
          </label>
          <label>
            Sell token
            <select value={form.sellToken} onChange={(event) => set('sellToken', event.target.value as Address)}>
              {GNOSIS_TOKENS.map((token) => (
                <option key={token.address} value={token.address}>
                  {token.symbol}
                </option>
              ))}
            </select>
          </label>
          <label>
            Buy token
            <select value={form.buyToken} onChange={(event) => set('buyToken', event.target.value as Address)}>
              {GNOSIS_TOKENS.map((token) => (
                <option key={token.address} value={token.address}>
                  {token.symbol}
                </option>
              ))}
            </select>
          </label>
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
            Wrap native xDAI first
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
          <section>
            <h2>3 &middot; Your drop address</h2>
            <DropAddress address={compiled.value.address} />
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
                {!status.executorDeployed && (
                  <li className="warn">
                    The cow-drop contracts are not deployed on {CHAIN.name} yet, so the address is a
                    prediction and activation will fail. Addresses are deterministic, so this one will
                    not change once they are.
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
                disabled={!account || busy || status?.executorDeployed === false}
              >
                {busy ? 'Activating…' : 'Activate drop'}
              </button>
              <a
                href={`${COW_EXPLORER}/address/${compiled.value.address}`}
                target="_blank"
                rel="noreferrer"
              >
                Orders on CoW Explorer
              </a>
              <a
                href={`${BLOCK_EXPLORER.url}/address/${compiled.value.address}`}
                target="_blank"
                rel="noreferrer"
              >
                Balances on {BLOCK_EXPLORER.name}
              </a>
            </div>

            {message && <p className="ok">{message}</p>}
            {error && <p className="error">{error}</p>}

            <TerminalPanel compiled={compiled.value} />
          </section>

          <section>
            <h2>6 &middot; If something goes wrong</h2>
            <RescuePanel
              compiled={compiled.value}
              account={account}
              deployed={status?.deployed ?? false}
              sellToken={form.sellToken}
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
            />
          </section>
        </>
      ) : (
        <section>
          <p className="error">{compiled.error}</p>
        </section>
      )}
    </main>
  )
}
