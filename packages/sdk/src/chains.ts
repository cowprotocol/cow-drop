/**
 * Which chains cow-drop can work on, and with which order paths.
 *
 * Drop addresses are **chain-independent**: every input to the CREATE2 derivation — the executor
 * factory, the shed implementation, `DropExecutor`, the step contracts — is itself CREATE2-deployed with a
 * zero salt from addresses that are the same everywhere, so the same recipe resolves to the same
 * address on every chain. Verified by running the deploy script against Gnosis and mainnet forks and
 * diffing the output. Only *whether the contracts are deployed there yet* differs, which is a runtime
 * question the UI answers with `getCode`.
 *
 * So this file is policy rather than data: the addresses come from the build, and this is the list of
 * chains we claim to work on.
 */

/** Chain ids, matching cow-sdk's `SupportedChainId` without importing it — see the note below. */
export const DropChainId = {
  MAINNET: 1,
  GNOSIS_CHAIN: 100,
  BNB: 56,
  LENS: 232,
  PLASMA: 9745,
  ARBITRUM_ONE: 42161,
  BASE: 8453,
  POLYGON: 137,
  AVALANCHE: 43114,
  LINEA: 59144,
  SEPOLIA: 11155111,
} as const

export type DropChainId = (typeof DropChainId)[keyof typeof DropChainId]

export interface DropChain {
  chainId: DropChainId
  name: string
}

/**
 * Both order paths work on all of these.
 *
 * There was briefly a per-chain `composable` flag here, marking chains where a TWAP could not run.
 * It was wrong: it came from composable-cow's `networks.json`, which is missing entries for chains the
 * contracts are in fact deployed on. Checked against the chains instead — ComposableCoW, the TWAP
 * handler and `CurrentBlockTimestampFactory` are all present at their usual addresses on every chain
 * listed here, so there is nothing to warn about and the flag is gone.
 */
export const DROP_CHAINS: readonly DropChain[] = [
  { chainId: DropChainId.MAINNET, name: 'Ethereum' },
  { chainId: DropChainId.GNOSIS_CHAIN, name: 'Gnosis' },
  { chainId: DropChainId.ARBITRUM_ONE, name: 'Arbitrum One' },
  { chainId: DropChainId.BASE, name: 'Base' },
  { chainId: DropChainId.BNB, name: 'BNB Chain' },
  { chainId: DropChainId.LINEA, name: 'Linea' },
  { chainId: DropChainId.PLASMA, name: 'Plasma' },
  { chainId: DropChainId.POLYGON, name: 'Polygon' },
  { chainId: DropChainId.AVALANCHE, name: 'Avalanche' },
  { chainId: DropChainId.SEPOLIA, name: 'Sepolia' },
]

/**
 * Lens (232) is deliberately absent despite having ComposableCoW: CoW's token list carries no tokens
 * for it and cow-sdk knows no wrapped native token there, so the UI would offer an empty token picker.
 * Nothing about the contracts prevents it — add it here once either of those exists.
 */
export function getDropChain(chainId: number): DropChain | undefined {
  return DROP_CHAINS.find((chain) => chain.chainId === chainId)
}
