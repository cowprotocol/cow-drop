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
 * Sepolia, which CoW's token list does not cover at all.
 *
 * Without these the picker would hold only the wrapped native token, so the default sell and buy would
 * both be WETH — an order that trades a token for itself, which is invalid. Verified on-chain.
 */
export const SEPOLIA_TOKENS: TokenInfo[] = [
  { symbol: 'WETH', address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', decimals: 18 },
  { symbol: 'COW', address: '0x0625aFB445C3B6B7B929342a04A22599fd5dBB59', decimals: 18 },
  { symbol: 'UNI', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 },
]
