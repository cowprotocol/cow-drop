import {
  buildDeployOnlyTx,
  buildRescueForState,
  type CompiledRecipe,
} from '@cowprotocol/cow-drop-sdk'
import { useMemo, useState } from 'react'
import { isAddress, type Address } from 'viem'

import { getPublicClient, sendTransaction } from '../lib/chain.js'
import type { TokenInfo } from '../lib/tokenList.js'

const NATIVE: Address = '0x0000000000000000000000000000000000000000'

/**
 * The escape hatch, for when a drop's recipe cannot or should not run.
 *
 * Deliberately kept behind a details toggle: it is the wrong answer to almost every question, and a
 * prominent "get my money out" button next to "activate" would invite people to use it instead of
 * fixing their recipe. But when it *is* needed, not having it means stranded funds.
 */
export function RescuePanel({
  compiled,
  account,
  deployed,
  sellToken,
  tokens,
}: {
  compiled: CompiledRecipe
  account: Address | null
  deployed: boolean
  sellToken: Address
  tokens: TokenInfo[]
}) {
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<Address[]>([sellToken, NATIVE])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /**
   * Which balances to offer a checkbox for.
   *
   * The picker is fed CoW Swap's whole default token set — several hundred tokens on the busier chains
   * — and one checkbox per token would bury this panel. So only CoW's curated tokens are listed, plus
   * the recipe's sell token: that is the balance most likely to need rescuing, and the one case where a
   * long-tail pick still has to be sweepable. It is listed even when absent from the token list
   * entirely, because it is selected by default, and a selected balance with no checkbox would sweep
   * with nothing on screen to say so.
   */
  const sweepable = useMemo(() => {
    const isSellToken = (address: Address) => address.toLowerCase() === sellToken.toLowerCase()
    const shown = tokens.filter((token) => token.curated || isSellToken(token.address))
    const entries = shown.map((token) => ({ label: token.symbol, address: token.address }))

    if (!shown.some((token) => isSellToken(token.address))) {
      entries.unshift({ label: `${sellToken.slice(0, 10)}… (sell token)`, address: sellToken })
    }
    return [...entries, { label: 'native token', address: NATIVE }]
  }, [tokens, sellToken])

  const isOwner = account !== null && account.toLowerCase() === compiled.owner.toLowerCase()
  const recipient = isAddress(to) ? (to as Address) : account

  const toggle = (token: Address) =>
    setSelected((current) =>
      current.includes(token) ? current.filter((t) => t !== token) : [...current, token],
    )

  const run = async (mode: 'sweep' | 'deploy-only') => {
    if (!account || !recipient) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const tx =
        mode === 'deploy-only'
          ? buildDeployOnlyTx({
              deployment: compiled.deployment,
              owner: compiled.owner,
              setupData: compiled.setupData,
            })
          : buildRescueForState({
              deployment: compiled.deployment,
              owner: compiled.owner,
              setupData: compiled.setupData,
              drop: compiled.address,
              to: recipient,
              tokens: selected,
              deployed,
            }).tx

      const chainId = compiled.deployment.chainId
      const hash = await sendTransaction({ chainId, account, ...tx })
      await getPublicClient(chainId).waitForTransactionReceipt({ hash })
      setMessage(mode === 'deploy-only' ? `Shed deployed in ${hash}` : `Recovered in ${hash}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="rescue">
      <summary>Rescue &amp; manual control</summary>

      <p className="hint">
        A drop is funded before it exists, so a recipe can turn out to be unrunnable — funds arrive too
        late, or a condition stops holding. Both paths are owner-only and need no signature.
      </p>

      <ul className="status">
        <li>
          Path:{' '}
          <strong>
            {deployed
              ? 'drop is deployed — the owner sweeps it directly (trustedExecuteHooks)'
              : 'drop is not deployed — deploy without running the recipe (initializeProxyWithoutSetup)'}
          </strong>
        </li>
        {!isOwner && (
          <li className="warn">
            Only the owner ({compiled.owner}) can do this. Connect that account.
          </li>
        )}
      </ul>

      <p className="hint warn-note">
        A sweep moves balances but does not retire orders already placed, so a drop swept mid-schedule
        will still trade whatever arrives next. Retiring one needs the order hash from the activation
        receipt — the SDK can (<code>buildRevokeCalls</code>), this page cannot yet.
      </p>

      <div className="grid">
        <label>
          Send recovered funds to (blank = connected account)
          <input placeholder="0x…" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
      </div>

      <fieldset className="tokens">
        <legend>Sweep which balances</legend>
        {sweepable.map(
          (token) => (
            <label key={token.address} className="checkbox">
              <input
                type="checkbox"
                checked={selected.includes(token.address)}
                onChange={() => toggle(token.address)}
              />
              {token.label}
            </label>
          ),
        )}
      </fieldset>

      <div className="actions">
        <button onClick={() => void run('sweep')} disabled={!isOwner || busy || selected.length === 0}>
          {busy ? 'Working…' : 'Recover funds'}
        </button>
        {!deployed && (
          <button onClick={() => void run('deploy-only')} disabled={!isOwner || busy}>
            Deploy shed only
          </button>
        )}
      </div>

      <p className="hint">
        <strong>Deploy shed only</strong> skips the recipe and leaves an ordinary cow-shed at the same
        address for you to drive. Empty balances are skipped, so listing a token that is not there is
        harmless.
      </p>

      {message && <p className="ok">{message}</p>}
      {error && <p className="error">{error}</p>}
    </details>
  )
}
