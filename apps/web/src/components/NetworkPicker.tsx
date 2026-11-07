import { DROP_CHAINS, getDropChain } from '@cowprotocol/cow-drop-sdk'
import { useEffect, useMemo, useState } from 'react'

import { probeChainReadiness } from '../lib/drop.js'
import { ChainLogo } from './ChainLogo.js'
import { Select, type SelectOption } from './Select.js'
import { Tooltip } from './Tooltip.js'

/**
 * Network selector.
 *
 * Switching networks does not move the drop address — every input to the derivation is deployed
 * deterministically at the same address everywhere. All it changes is which chain you fund, which is
 * why unready chains stay selectable: the address is already correct there and will not move once the
 * contracts land. Funding is what gets withheld, not the chain.
 *
 * Picking here also asks the wallet to switch, and the page follows the wallet's own changes, so the
 * two cannot drift. The banner is for when that did not take.
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
    // Probing every chain up front, not just the selected one, is what lets the note appear before you
    // switch — the point is to steer the choice, not to explain it afterwards. The probes are
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

  const options = useMemo<SelectOption<number>[]>(
    () =>
      DROP_CHAINS.map((chain) => ({
        value: chain.chainId,
        label: chain.name,
        icon: <ChainLogo chainId={chain.chainId} />,
        note: ready[chain.chainId] === false ? 'not deployed' : undefined,
      })),
    [ready],
  )

  return (
    <div className="network">
      <Select
        label={
          <>
            Network
            <Tooltip title="Network">
              The drop address is the same on every chain — this only picks where you fund it. Chains
              marked <em>not deployed</em> do not have cow-drop's contracts yet, so an address there is
              correct but cannot be activated.
            </Tooltip>
          </>
        }
        value={chainId}
        options={options}
        onChange={onChange}
      />

      {walletChainId !== null && walletChainId !== chainId && (
        <p className="hint warn">
          Wallet is on {getDropChain(walletChainId)?.name ?? `chain ${walletChainId}`}. Switch it to{' '}
          {getDropChain(chainId)?.name ?? `chain ${chainId}`} to activate, or pick the network again to
          be prompted.
        </p>
      )}
    </div>
  )
}
