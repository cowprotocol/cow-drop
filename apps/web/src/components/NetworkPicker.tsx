import { DROP_CHAINS, getDropChain } from '@cowprotocol/cow-drop-sdk'
import { useEffect, useState } from 'react'

import { probeChainReadiness } from '../lib/drop.js'

/**
 * Network selector.
 *
 * Switching networks does not change the drop address — every input to the derivation is deployed
 * deterministically at the same address everywhere, so the same recipe resolves identically on every
 * chain. All it changes is which chain you fund.
 *
 * Picking a network here also asks the wallet to switch, and the page follows the wallet's own changes,
 * so the two cannot drift apart. The banner below is for when that did not take: the prompt was
 * declined, or no wallet is connected to prompt.
 *
 * Both order paths work on every chain listed, so there is nothing to caveat about *order types*. What
 * does differ is whether cow-drop's contracts exist on a chain yet, which is why each option is
 * labelled with the answer. Unready chains stay selectable on purpose: the address a recipe resolves to
 * is already correct there and will not move once the contracts land, and that is a property worth
 * being able to see rather than one to hide. Funding is what gets withheld, not the chain.
 */
export function NetworkPicker({
  chainId,
  onChange,
  walletChainId,
}: {
  chainId: number
  onChange: (chainId: number) => void
  walletChainId: number | null
}) {
  /** `undefined` while a chain is still being probed, so an option is never mislabelled as ready. */
  const [ready, setReady] = useState<Record<number, boolean>>({})

  useEffect(() => {
    let cancelled = false
    // Probing every chain up front, not just the selected one, is what lets the label appear before
    // you switch — the point is to steer the choice, not to explain it afterwards. The probes are
    // memoised, so this costs one sweep per page load.
    for (const chain of DROP_CHAINS) {
      void probeChainReadiness(chain.chainId)
        .then((missing) => {
          if (!cancelled) setReady((previous) => ({ ...previous, [chain.chainId]: missing.length === 0 }))
        })
        .catch(() => {
          // An unreachable RPC is not evidence either way, so the option keeps its neutral label.
        })
    }
    return () => {
      cancelled = true
    }
  }, [])

  const label = (id: number, name: string) => {
    if (ready[id] === undefined) return name
    return ready[id] ? name : `${name} — contracts not deployed yet`
  }

  return (
    <div className="network">
      <label>
        Network
        <select value={chainId} onChange={(event) => onChange(Number(event.target.value))}>
          {DROP_CHAINS.map((option) => (
            <option key={option.chainId} value={option.chainId}>
              {label(option.chainId, option.name)}
            </option>
          ))}
        </select>
      </label>

      {walletChainId !== null && walletChainId !== chainId && (
        <p className="hint warn">
          Your wallet is still on {getDropChain(walletChainId)?.name ?? `chain ${walletChainId}`}.
          Activating needs it on {getDropChain(chainId)?.name ?? `chain ${chainId}`} — switch it in the
          wallet, or pick this network again to be prompted.
        </p>
      )}
    </div>
  )
}
