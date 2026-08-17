/**
 * Which chains cow-drop can work on, and with which order paths.
 *
 * Drop addresses are **chain-independent**: every input to the CREATE2 derivation — the executor
 * factory, the shed implementation, `DropExecutor`, `DropRecipes` — is itself CREATE2-deployed with a
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
  /**
   * Whether the composable path (TWAP) is available.
   *
   * `DropRecipes` bakes in ComposableCoW, the TWAP handler and the value factory as immutables. Those
   * are at the same addresses on every chain they exist on — but they do not exist everywhere, and on
   * a chain without them a `twapFromBalance` step reverts while pre-signed orders still work fine.
   *
   * Sourced from composable-cow's `networks.json`.
   */
  composable: boolean
}

export const DROP_CHAINS: readonly DropChain[] = [
  { chainId: DropChainId.MAINNET, name: 'Ethereum', composable: true },
  { chainId: DropChainId.GNOSIS_CHAIN, name: 'Gnosis', composable: true },
  { chainId: DropChainId.ARBITRUM_ONE, name: 'Arbitrum One', composable: true },
  { chainId: DropChainId.BASE, name: 'Base', composable: false },
  { chainId: DropChainId.BNB, name: 'BNB Chain', composable: true },
  { chainId: DropChainId.LINEA, name: 'Linea', composable: true },
  { chainId: DropChainId.PLASMA, name: 'Plasma', composable: true },
  { chainId: DropChainId.POLYGON, name: 'Polygon', composable: false },
  { chainId: DropChainId.AVALANCHE, name: 'Avalanche', composable: false },
  { chainId: DropChainId.SEPOLIA, name: 'Sepolia', composable: true },
]

/**
 * Lens (232) is deliberately absent despite having ComposableCoW: CoW's token list carries no tokens
 * for it and cow-sdk knows no wrapped native token there, so the UI would offer an empty token picker.
 * Nothing about the contracts prevents it — add it here once either of those exists.
 */
export function getDropChain(chainId: number): DropChain | undefined {
  return DROP_CHAINS.find((chain) => chain.chainId === chainId)
}
