import { DROP_CHAINS, getDropChain } from '@cowprotocol/cow-drop-sdk'

/**
 * Network selector.
 *
 * Switching networks does not change the drop address — every input to the derivation is deployed
 * deterministically at the same address everywhere, so the same recipe resolves identically on every
 * chain. What it changes is which chain you fund, and whether the composable path is available: a
 * chain without ComposableCoW can still pre-sign orders but cannot register a TWAP.
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
  const chain = getDropChain(chainId)

  return (
    <div className="network">
      <label>
        Network
        <select value={chainId} onChange={(event) => onChange(Number(event.target.value))}>
          {DROP_CHAINS.map((option) => (
            <option key={option.chainId} value={option.chainId}>
              {option.name}
              {option.composable ? '' : ' — swaps only'}
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

      {chain && !chain.composable && (
        <p className="hint">
          ComposableCoW is not deployed on {chain.name}, so the TWAP recipe cannot run there. Swap on
          arrival works, since a pre-signed order needs only the settlement contract.
        </p>
      )}
    </div>
  )
}
