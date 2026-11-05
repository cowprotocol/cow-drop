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
  /**
   * The chain's path segment in CoW's order book API — `api.cow.fi/<network>/…` — and so the name a
   * multi-chain keeper serves it under: `<keeper>/<network>/v1/…`. One vocabulary for both, so a
   * keeper URL reads like the API it posts to.
   */
  network: string
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
  { chainId: DropChainId.MAINNET, name: 'Ethereum', network: 'mainnet' },
  { chainId: DropChainId.GNOSIS_CHAIN, name: 'Gnosis', network: 'xdai' },
  { chainId: DropChainId.ARBITRUM_ONE, name: 'Arbitrum One', network: 'arbitrum_one' },
  { chainId: DropChainId.BASE, name: 'Base', network: 'base' },
  { chainId: DropChainId.BNB, name: 'BNB Chain', network: 'bnb' },
  { chainId: DropChainId.LINEA, name: 'Linea', network: 'linea' },
  { chainId: DropChainId.PLASMA, name: 'Plasma', network: 'plasma' },
  { chainId: DropChainId.POLYGON, name: 'Polygon', network: 'polygon' },
  { chainId: DropChainId.AVALANCHE, name: 'Avalanche', network: 'avalanche' },
  { chainId: DropChainId.SEPOLIA, name: 'Sepolia', network: 'sepolia' },
]

/**
 * Lens (232) is deliberately absent despite having ComposableCoW: CoW's token list carries no tokens
 * for it and cow-sdk knows no wrapped native token there, so the UI would offer an empty token picker.
 * Nothing about the contracts prevents it — add it here once either of those exists.
 */
export function getDropChain(chainId: number): DropChain | undefined {
  return DROP_CHAINS.find((chain) => chain.chainId === chainId)
}

/** The chain a CoW network name stands for — `xdai` is Gnosis — or undefined. */
export function getDropChainByNetwork(network: string): DropChain | undefined {
  return DROP_CHAINS.find((chain) => chain.network === network)
}
