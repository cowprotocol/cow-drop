import { DROP_CHAINS, getDropChain } from '@cowprotocol/cow-drop-sdk'

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
 * Both order paths work on every chain listed, so there is nothing to caveat here.
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
  return (
    <div className="network">
      <label>
        Network
        <select value={chainId} onChange={(event) => onChange(Number(event.target.value))}>
          {DROP_CHAINS.map((option) => (
            <option key={option.chainId} value={option.chainId}>
              {option.name}
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
