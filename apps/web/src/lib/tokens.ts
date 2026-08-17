import type { Address } from 'viem'

/** A small curated list, enough for the demo. The address fields stay editable in the UI. */
export interface TokenInfo {
  symbol: string
  address: Address
  decimals: number
}

export const GNOSIS_TOKENS: TokenInfo[] = [
  { symbol: 'WXDAI', address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', decimals: 18 },
  { symbol: 'USDC.e', address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0', decimals: 6 },
  { symbol: 'COW', address: '0x177127622c4A00F3d409B75571e12cB3c8973d3c', decimals: 18 },
  { symbol: 'GNO', address: '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb', decimals: 18 },
  { symbol: 'WETH', address: '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1', decimals: 18 },
]

export function findToken(address: string): TokenInfo | undefined {
  return GNOSIS_TOKENS.find((token) => token.address.toLowerCase() === address.toLowerCase())
}
