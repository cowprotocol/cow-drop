import { compileRecipe, swapOnArrival, twapOnArrival, type DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import { formatUnits, isAddress, type Address } from 'viem'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { CHAIN, EXPLORER, connect } from './lib/chain.js'
import { activateDrop, postPlacedOrders, readDropStatus, type DropStatus } from './lib/drop.js'
import { GNOSIS_TOKENS, WRAPPED_NATIVE, findToken } from './lib/tokens.js'
import { DropAddress } from './components/DropAddress.js'
import { RecipeJson } from './components/RecipeJson.js'
import { RescuePanel } from './components/RescuePanel.js'
import { StepTable } from './components/StepTable.js'

type Template = 'swap' | 'twap'

const PLACEHOLDER_OWNER: Address = '0x0000000000000000000000000000000000000001'

interface FormState {
  template: Template
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
  template: 'swap',
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
  const wrapNative = form.wrapNative ? WRAPPED_NATIVE : undefined

  if (form.template === 'twap') {
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
        <h2>1 &middot; Pick a template</h2>
        <div className="tabs">
          <button
            className={form.template === 'swap' ? 'active' : ''}
            onClick={() => set('template', 'swap')}
          >
            Swap on arrival
          </button>
          <button
            className={form.template === 'twap' ? 'active' : ''}
            onClick={() => set('template', 'twap')}
          >
            TWAP on arrival
          </button>
        </div>
        <p className="hint">
          {form.template === 'swap'
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
            Receiver (blank = keep in the drop)
            <input
              placeholder="0x…"
              value={form.receiver}
              onChange={(event) => set('receiver', event.target.value)}
            />
          </label>
          {form.template === 'swap' ? (
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
              <a href={`${EXPLORER}/address/${compiled.value.address}`} target="_blank" rel="noreferrer">
                View on CoW Explorer
              </a>
            </div>

            {message && <p className="ok">{message}</p>}
            {error && <p className="error">{error}</p>}
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
