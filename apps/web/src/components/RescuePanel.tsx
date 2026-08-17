import {
  buildDeployOnlyTx,
  buildRescueForState,
  type CompiledRecipe,
} from '@cowprotocol/cow-drop-sdk'
import { useState } from 'react'
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
        A drop is funded before it exists, so the recipe can turn out to be unrunnable — funds arrive
        too late, or a condition it depends on stops holding. These are owner-only, and neither needs
        a signature.
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

      <div className="grid">
        <label>
          Send recovered funds to (blank = connected account)
          <input placeholder="0x…" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
      </div>

      <fieldset className="tokens">
        <legend>Sweep which balances</legend>
        {[...tokens.map((t) => ({ label: t.symbol, address: t.address })), { label: 'native token', address: NATIVE }].map(
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
        <strong>Deploy shed only</strong> skips the recipe and hands you an ordinary cow-shed at the
        same address, which you can then drive however you like. An empty balance is skipped rather
        than failing, so listing a token that isn&apos;t there is harmless.
      </p>

      {message && <p className="ok">{message}</p>}
      {error && <p className="error">{error}</p>}
    </details>
  )
}
