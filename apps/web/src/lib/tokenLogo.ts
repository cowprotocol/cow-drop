import { SupportedChainId } from '@cowprotocol/cow-sdk'

import type { TokenInfo } from './tokenList.js'

/**
 * Where to look for a token's logo, in order.
 *
 * Mirrors cowswap's `getTokenLogoUrls` (`libs/tokens/src/utils/getTokenLogoUrls.ts`). The important
 * part is that it is a *cascade*, not a single URL: CoW's CDN answers 403 for addresses it does not
 * have, so any one source will fail regularly and the consumer has to fall through to the next.
 */
export function tokenLogoUrls(token: TokenInfo, chainId: number): string[] {
  const key = token.address.toLowerCase()

  const fallbacks = [
    cowProtocolLogoUrl(key, chainId),
    // Many tokens are only in the CDN under mainnet, even when bridged elsewhere.
    cowProtocolLogoUrl(key, SupportedChainId.MAINNET),
  ]

  const trust = trustWalletLogoUrl(token.address, chainId)
  if (trust) fallbacks.push(trust)

  if (!token.logoURI) return fallbacks

  const fromList = uriToHttp(token.logoURI)
  return [...fromList, ...fallbacks.filter((url) => !fromList.includes(url))]
}

const COW_CDN = 'https://files.cow.fi'

function cowProtocolLogoUrl(address: string, chainId: number): string {
  return `${COW_CDN}/token-lists/images/${chainId}/${address}/logo.png`
}

/** Trust Wallet's per-chain directory names, from cowswap's `trustTokenLogoUrl`. */
const TRUST_CHAIN_NAMES: Record<number, string> = {
  [SupportedChainId.MAINNET]: 'ethereum',
  [SupportedChainId.GNOSIS_CHAIN]: 'xdai',
  [SupportedChainId.ARBITRUM_ONE]: 'arbitrum',
  [SupportedChainId.BASE]: 'base',
  [SupportedChainId.SEPOLIA]: 'ethereum',
}

function trustWalletLogoUrl(address: string, chainId: number): string | null {
  const name = TRUST_CHAIN_NAMES[chainId]
  if (!name) return null
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${name}/assets/${address}/logo.png`
}

/**
 * Resolve a token list's `logoURI` to something a browser will fetch.
 *
 * Token lists carry `ipfs://`, `ipns://` and bare `http://` URIs, none of which a page should use as
 * given. A subset of cowswap's `uriToHttp`, covering the schemes that actually appear.
 */
export function uriToHttp(uri: string): string[] {
  const protocol = uri.split(':')[0]?.toLowerCase()

  switch (protocol) {
    case 'data':
    case 'https':
      return [uri]
    case 'http':
      return [`https${uri.slice(4)}`, uri]
    case 'ipfs': {
      const hash = uri.match(/^ipfs:(\/\/)?(ipfs\/)?(.*)$/i)?.[3]
      return hash ? [`https://ipfs.io/ipfs/${hash}/`] : []
    }
    case 'ipns': {
      const name = uri.match(/^ipns:(\/\/)?(.*)$/i)?.[2]
      return name ? [`https://ipfs.io/ipns/${name}/`] : []
    }
    default:
      return []
  }
}
