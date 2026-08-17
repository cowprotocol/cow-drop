import type { Address } from 'viem'

import { CHAIN_ID } from './chain.js'
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
export async function fetchTokenList(chainId: number = CHAIN_ID): Promise<TokenInfo[]> {
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

    return tokens.length > 0 ? tokens : GNOSIS_TOKENS
  } catch {
    return GNOSIS_TOKENS
  }
}

/** Case-insensitive lookup, since list addresses are a mix of checksummed and lowercase. */
export function findToken(tokens: TokenInfo[], address: string): TokenInfo | undefined {
  return tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())
}
