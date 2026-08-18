import { DropChainId } from '@cowprotocol/cow-drop-sdk'
import type { Address } from 'viem'

import { wrappedNativeToken } from './chain.js'
import { GNOSIS_TOKENS, SEPOLIA_TOKENS, type TokenInfo } from './tokens.js'

export type { TokenInfo }

/**
 * The token lists cowswap enables by default, per chain, in its own priority order.
 *
 * Mirrors the `enabledByDefault: true` entries of `libs/tokens/src/const/tokensList.json` in the
 * cowswap frontend. This file used to load a single URL — `files.cow.fi/tokens/CowSwap.json` — on the
 * assumption that it was what cowswap shows. It is not, in two separate ways, and both made the picker
 * far smaller than CoW Swap's:
 *
 * - Priority 1 is not the whole default set. `CowSwap.json` is CoW's own curated list, and it is tiny
 *   on the newer chains — 11 tokens on Arbitrum, 5 on Polygon and Avalanche — while cowswap also
 *   enables the CoinGecko and Uniswap lists out of the box, reaching ~660 and ~620 there.
 * - Sepolia does not use `CowSwap.json` at all. That file carries no Sepolia tokens whatsoever, so
 *   loading it there produced an empty list every time; cowswap points Sepolia at a dedicated list.
 *
 * The opt-in lists cowswap ships behind a toggle — Curve, Balancer, Ondo, xStocks — are deliberately
 * left out, so this matches a fresh CoW Swap install rather than every list it can be made to load.
 */
const TOKEN_LIST_SOURCES: Record<number, readonly string[]> = {
  [DropChainId.MAINNET]: [
    'https://files.cow.fi/tokens/CowSwap.json',
    'https://files.cow.fi/token-lists/CoinGecko.1.json',
  ],
  [DropChainId.GNOSIS_CHAIN]: [
    'https://files.cow.fi/tokens/CowSwap.json',
    'https://tokens.honeyswap.org',
    'https://files.cow.fi/token-lists/Uniswap.100.json',
    'https://files.cow.fi/token-lists/CoinGecko.100.json',
  ],
  [DropChainId.BNB]: [
    'https://files.cow.fi/tokens/CowSwap.json',
    'https://files.cow.fi/token-lists/CoinGecko.56.json',
    'https://files.cow.fi/token-lists/Uniswap.56.json',
  ],
  [DropChainId.PLASMA]: [
    'https://files.cow.fi/tokens/CowSwap.json',
    'https://files.cow.fi/token-lists/CoinGecko.9745.json',
  ],
  [DropChainId.ARBITRUM_ONE]: [
    'https://files.cow.fi/tokens/CowSwap.json',
    'https://files.cow.fi/token-lists/Uniswap.42161.json',
    'https://files.cow.fi/token-lists/CoinGecko.42161.json',
  ],
  [DropChainId.BASE]: [
    'https://files.cow.fi/tokens/CowSwap.json',
    'https://files.cow.fi/token-lists/CoinGecko.8453.json',
    'https://files.cow.fi/token-lists/Uniswap.8453.json',
  ],
  [DropChainId.POLYGON]: [
    'https://files.cow.fi/tokens/CowSwap.json',
    'https://files.cow.fi/token-lists/CoinGecko.137.json',
    'https://files.cow.fi/token-lists/Uniswap.137.json',
  ],
  [DropChainId.AVALANCHE]: [
    'https://files.cow.fi/tokens/CowSwap.json',
    'https://files.cow.fi/token-lists/CoinGecko.43114.json',
    'https://files.cow.fi/token-lists/Uniswap.43114.json',
  ],
  [DropChainId.LINEA]: [
    'https://files.cow.fi/tokens/CowSwap.json',
    'https://files.cow.fi/token-lists/CoinGecko.59144.json',
  ],
  [DropChainId.SEPOLIA]: ['https://files.cow.fi/token-lists/CowSwapSepolia.json'],
}

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
 * Lists already fetched this session, keyed by chain.
 *
 * A chain now costs up to four requests and a couple of megabytes of JSON, and switching network back
 * and forth is a normal thing to do, so the result is held for the session. The promise rather than
 * the value is cached, which also collapses the double invocation React's strict mode does in dev.
 */
const cache = new Map<number, Promise<TokenInfo[]>>()

/**
 * Load the token list for a chain: CoW's curated tokens first, then the broader lists behind them.
 *
 * Never rejects, and never leaves the picker empty. A token list being unreachable should not stop you
 * computing a drop address, which is pure local arithmetic.
 */
export function fetchTokenList(chainId: number): Promise<TokenInfo[]> {
  const cached = cache.get(chainId)
  if (cached) return cached

  const pending = load(chainId).then((result) => {
    // A fully degraded answer is not worth remembering: one flaky moment would otherwise pin the
    // picker to the built-in list for the rest of the session.
    if (!result.loaded) cache.delete(chainId)
    return result.tokens
  })
  cache.set(chainId, pending)
  return pending
}

/** `loaded` is false only when a list was expected and none arrived, i.e. when a retry might help. */
async function load(chainId: number): Promise<{ tokens: TokenInfo[]; loaded: boolean }> {
  const sources = TOKEN_LIST_SOURCES[chainId] ?? []
  const lists = await Promise.all(sources.map((source) => fetchSource(source, chainId)))
  const merged = mergeByPriority(lists)

  if (merged.length > 0) return { tokens: withWrappedNative(merged, chainId), loaded: true }

  // The built-in lists are short and hand-checked, so all of them count as curated.
  const fallback = builtIn(chainId).map((token) => ({ ...token, curated: true }))
  return { tokens: withWrappedNative(fallback, chainId), loaded: sources.length === 0 }
}

/** One list, narrowed to this chain. A source that fails contributes nothing rather than failing all. */
async function fetchSource(source: string, chainId: number): Promise<TokenInfo[]> {
  try {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`${source} responded ${response.status}`)

    const list = (await response.json()) as TokenListResponse
    return list.tokens
      .filter((token) => token.chainId === chainId)
      .map((token) => ({
        symbol: token.symbol,
        name: token.name,
        address: token.address as Address,
        decimals: token.decimals,
        logoURI: token.logoURI,
      }))
  } catch {
    return []
  }
}

/**
 * Concatenate the lists in priority order, dropping addresses a higher-priority list already claimed.
 *
 * Sorting is per list rather than across the whole set, which keeps CoW's curated tokens — the ones
 * with logos, and the ones someone is most likely to drop — at the top of the picker instead of
 * scattering them alphabetically through several hundred others. First list wins on a duplicate, so
 * CoW's symbol and decimals beat an aggregator's.
 *
 * The first list is CoW's own on every chain, so that is what `curated` marks.
 */
function mergeByPriority(lists: TokenInfo[][]): TokenInfo[] {
  const seen = new Set<string>()
  const merged: TokenInfo[] = []

  for (const [priority, list] of lists.entries()) {
    const fresh = list.filter((token) => {
      const key = token.address.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    fresh.sort((a, b) => a.symbol.localeCompare(b.symbol))
    merged.push(...fresh.map((token) => ({ ...token, curated: priority === 0 })))
  }

  return merged
}

/** Built-in lists for chains no CoW list covers, or as an offline fallback. */
function builtIn(chainId: number): TokenInfo[] {
  if (chainId === DropChainId.GNOSIS_CHAIN) return GNOSIS_TOKENS
  if (chainId === DropChainId.SEPOLIA) return SEPOLIA_TOKENS
  return []
}

/**
 * Guarantee the wrapped native token is present.
 *
 * Lens has no cowswap list at all, which would leave the picker empty and the page unusable there.
 * cow-sdk knows the wrapped native for every chain, and it is the most likely thing to be dropping
 * anyway, so it always goes in.
 */
function withWrappedNative(tokens: TokenInfo[], chainId: number): TokenInfo[] {
  let native: TokenInfo
  try {
    native = wrappedNativeToken(chainId)
  } catch {
    return tokens
  }

  if (tokens.some((token) => token.address.toLowerCase() === native.address.toLowerCase())) return tokens
  return [{ ...native, curated: true }, ...tokens]
}

/** Case-insensitive lookup, since list addresses are a mix of checksummed and lowercase. */
export function findToken(tokens: TokenInfo[], address: string): TokenInfo | undefined {
  return tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())
}
