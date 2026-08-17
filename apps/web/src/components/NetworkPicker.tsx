import { DROP_CHAINS } from '@cowprotocol/cow-drop-sdk'

/**
 * Network selector.
 *
 * Switching networks does not change the drop address — every input to the derivation is deployed
 * deterministically at the same address everywhere, so the same recipe resolves identically on every
 * chain. All it changes is which chain you fund.
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
          Your wallet is on chain {walletChainId}. Switch it, or pick that network here, before
          activating.
        </p>
      )}
    </div>
  )
}
