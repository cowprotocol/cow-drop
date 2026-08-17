import type { Address } from 'viem'

import { wrappedNativeToken } from './chain.js'
import { GNOSIS_TOKENS, type TokenInfo } from './tokens.js'

export type { TokenInfo }

/**
 * The same source cowswap uses, and the one it gives priority 1 on every chain:
 * `apps/cowswap-frontend` → `libs/tokens/src/const/tokensList.json`. It also loads Honeyswap,
 * Uniswap, CoinGecko and Curve lists on Gnosis, but this one is CoW's own curated list — 34 tokens on
 * Gnosis, every one of them with a logo — which is the right size for a picker rather than a search
 * problem.
 */
const COW_TOKEN_LIST = 'https://files.cow.fi/tokens/CowSwap.json'

interface TokenListResponse {
  name?: string
  tokens: Array<{
    chainId: number
    address: string
    symbol: string
    name?: string
    decimals: number
    logoURI?: string
  }>
}

/**
 * Load the token list for a chain, sorted by symbol as cowswap sorts it.
 *
 * Falls back to the small built-in list rather than throwing: a token list being unreachable should
 * not stop you computing a drop address, which is pure local arithmetic.
 */
export async function fetchTokenList(chainId: number): Promise<TokenInfo[]> {
  try {
    const response = await fetch(COW_TOKEN_LIST)
    if (!response.ok) throw new Error(`token list responded ${response.status}`)

    const list = (await response.json()) as TokenListResponse
    const tokens = list.tokens
      .filter((token) => token.chainId === chainId)
      .map((token) => ({
        symbol: token.symbol,
        name: token.name,
        address: token.address as Address,
        decimals: token.decimals,
        logoURI: token.logoURI,
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol))

    return withWrappedNative(tokens, chainId)
  } catch {
    return withWrappedNative(chainId === 100 ? GNOSIS_TOKENS : [], chainId)
  }
}

/**
 * Guarantee the wrapped native token is present.
 *
 * The CoW list covers no tokens at all on some chains it otherwise supports — Lens and Sepolia today —
 * which would leave the picker empty and the page unusable there. cow-sdk knows the wrapped native for
 * every chain, and it is the most likely thing to be dropping anyway, so it always goes in.
 */
function withWrappedNative(tokens: TokenInfo[], chainId: number): TokenInfo[] {
  let native: TokenInfo
  try {
    native = wrappedNativeToken(chainId)
  } catch {
    return tokens
  }

  if (tokens.some((token) => token.address.toLowerCase() === native.address.toLowerCase())) return tokens
  return [native, ...tokens]
}

/** Case-insensitive lookup, since list addresses are a mix of checksummed and lowercase. */
export function findToken(tokens: TokenInfo[], address: string): TokenInfo | undefined {
  return tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())
}
