import type { Address } from 'viem'

/**
 * A token as the UI needs it. Defined here, the leaf module, so `tokenList.ts` can re-export it
 * without the two forming a cycle.
 */
export interface TokenInfo {
  symbol: string
  name?: string
  address: Address
  decimals: number
  logoURI?: string
  /**
   * Whether this came from CoW's own curated list rather than one of the broad aggregator lists
   * behind it.
   *
   * The picker wants everything CoW Swap shows, several hundred tokens on the busier chains. Anything
   * that renders one row per token unconditionally — the rescue panel's checkboxes — wants the short
   * list instead, and this is how it tells them apart.
   */
  curated?: boolean
}

/**
 * Offline fallback for when CoW's token list is unreachable. Symbols and decimals were verified
 * on-chain; logos come from the CDN by convention, so they are omitted here and resolved by the
 * fallback cascade in `tokenLogo.ts`.
 */
export const GNOSIS_TOKENS: TokenInfo[] = [
  { symbol: 'WXDAI', address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', decimals: 18 },
  { symbol: 'USDC.e', address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0', decimals: 6 },
  { symbol: 'COW', address: '0x177127622c4A00F3d409B75571e12cB3c8973d3c', decimals: 18 },
  { symbol: 'GNO', address: '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb', decimals: 18 },
  { symbol: 'WETH', address: '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1', decimals: 18 },
]

/**
 * Sepolia, mirroring `files.cow.fi/token-lists/CowSwapSepolia.json` — the list cowswap points Sepolia
 * at, and the one `tokenList.ts` now loads.
 *
 * This is only the offline fallback, but it is worth keeping complete and correct: without it the
 * picker would hold nothing but the wrapped native token, so the default sell and buy would both be
 * WETH — an order that trades a token for itself, which is invalid.
 *
 * Every symbol and decimal here was read back with `eth_call` rather than trusted from the list. That
 * matters more than usual on a testnet: this USDC has **18** decimals, not the 6 it has everywhere
 * else, and USDT is the only 6-decimal token of the seven.
 */
export const SEPOLIA_TOKENS: TokenInfo[] = [
  { symbol: 'WETH', address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', decimals: 18 },
  { symbol: 'COW', address: '0x0625aFB445C3B6B7B929342a04A22599fd5dBB59', decimals: 18 },
  { symbol: 'DAI', address: '0xB4F1737Af37711e9A5890D9510c9bB60e170CB0D', decimals: 18 },
  { symbol: 'GNO', address: '0xd3f3d46FeBCD4CdAa2B83799b7A5CdcB69d135De', decimals: 18 },
  { symbol: 'UNI', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 },
  { symbol: 'USDC', address: '0xbe72E441BF55620febc26715db68d3494213D8Cb', decimals: 18 },
  { symbol: 'USDT', address: '0x58eb19ef91e8a6327fed391b51ae1887b833cc91', decimals: 6 },
]
