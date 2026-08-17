import { DropChainId } from '@cowprotocol/cow-drop-sdk'
import {
  OrderBookApi,
  SupportedChainId,
  getChainInfo,
  getWrappedTokenForChain,
  type EvmChainInfo,
} from '@cowprotocol/cow-sdk'
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
} from 'viem'

/**
 * CoW-facing chain metadata comes from the official SDK rather than being retyped here — it already
 * knows the block explorer, the API path segment and the wrapped native token for every chain it
 * supports, and those are exactly the things that go stale when copied.
 *
 * Everything is per-chain now that the network is selectable. Note that switching network does not
 * move a drop address: every input to the derivation is deployed deterministically at the same address
 * everywhere. What changes is which chain you fund.
 */
export const DEFAULT_CHAIN_ID: number = DropChainId.GNOSIS_CHAIN

/**
 * cow-sdk's chain info, narrowed to the EVM variant.
 *
 * `getChainInfo` returns `ChainInfo | undefined` over a union that includes non-EVM chains (Solana),
 * which have no `rpcUrls`. Every chain cow-drop supports is EVM, so anything else is a programming
 * error rather than a case to handle.
 */
export function chainInfo(chainId: number): EvmChainInfo {
  const info = getChainInfo(chainId as SupportedChainId)
  if (!info || !('rpcUrls' in info)) {
    throw new Error(`no EVM chain info for chain ${chainId}`)
  }
  return info
}

/** RPC endpoint. `VITE_RPC_URL` overrides, but only for the default chain — it names one endpoint. */
export function rpcUrl(chainId: number): string {
  const override = import.meta.env.VITE_RPC_URL
  if (override && chainId === DEFAULT_CHAIN_ID) return override

  const url = chainInfo(chainId).rpcUrls.default.http[0]
  if (!url) throw new Error(`no RPC URL for chain ${chainId}`)
  return url
}

/** A viem chain built from cow-sdk's info, so there is no second chain table to maintain. */
export function viemChain(chainId: number): Chain {
  const info = chainInfo(chainId)
  return defineChain({
    id: chainId,
    name: info.label,
    nativeCurrency: {
      name: info.nativeCurrency.name ?? 'Ether',
      symbol: info.nativeCurrency.symbol ?? 'ETH',
      decimals: info.nativeCurrency.decimals ?? 18,
    },
    rpcUrls: { default: { http: [rpcUrl(chainId)] } },
    blockExplorers: { default: { name: info.blockExplorer.name, url: info.blockExplorer.url } },
  })
}

const publicClients = new Map<number, PublicClient>()

export function getPublicClient(chainId: number): PublicClient {
  const existing = publicClients.get(chainId)
  if (existing) return existing

  const client = createPublicClient({ chain: viemChain(chainId), transport: http(rpcUrl(chainId)) })
  publicClients.set(chainId, client)
  return client
}

const orderBookApis = new Map<number, OrderBookApi>()

/** Quotes and order submission. The SDK owns the base URL per chain. */
export function getOrderBookApi(chainId: number): OrderBookApi {
  const existing = orderBookApis.get(chainId)
  if (existing) return existing

  const api = new OrderBookApi({ chainId: chainId as SupportedChainId })
  orderBookApis.set(chainId, api)
  return api
}

/** Only needed for the copy-pasteable curl; the SDK builds its own URLs internally. */
export function cowApiUrl(chainId: number): string {
  return `https://api.cow.fi/${chainInfo(chainId).internalId}/api/v1`
}

/** The chain's general-purpose explorer: address-centric, so it shows balances and transactions. */
export function blockExplorer(chainId: number): { name: string; url: string } {
  return chainInfo(chainId).blockExplorer
}

/** The wrapped native token's address, so a natively funded drop can trade. */
export function wrappedNative(chainId: number): Address {
  return wrappedNativeToken(chainId).address
}

/** The wrapped native token with its symbol and decimals, as cow-sdk records them. */
export function wrappedNativeToken(chainId: number): {
  symbol: string
  name?: string
  address: Address
  decimals: number
  logoURI?: string
} {
  const token = getWrappedTokenForChain(chainId as SupportedChainId)
  if (!token) throw new Error(`no wrapped native token known for chain ${chainId}`)
  return {
    symbol: token.symbol ?? 'WETH',
    name: token.name,
    address: token.address as Address,
    decimals: token.decimals ?? 18,
    logoURI: token.logoUrl,
  }
}

/**
 * CoW's own explorer: order-centric, so it shows what a drop is trading.
 *
 * Its network slugs are its own (`gc`, `arb1`, …) and cow-sdk does not expose them — `internalId` is
 * `xdai` for Gnosis, which the explorer does not accept — so this one small map stays local. A chain
 * missing from it falls back to no slug, which is mainnet.
 */
const COW_EXPLORER_SLUGS: Record<number, string> = {
  [DropChainId.MAINNET]: '',
  [DropChainId.GNOSIS_CHAIN]: '/gc',
  [DropChainId.ARBITRUM_ONE]: '/arb1',
  [DropChainId.BASE]: '/base',
  [DropChainId.POLYGON]: '/pol',
  [DropChainId.AVALANCHE]: '/avax',
  [DropChainId.BNB]: '/bnb',
  [DropChainId.SEPOLIA]: '/sepolia',
}

export function cowExplorer(chainId: number): string {
  return `https://explorer.cow.fi${COW_EXPLORER_SLUGS[chainId] ?? ''}`
}

function injected(): EIP1193Provider {
  const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum
  if (!provider) {
    throw new Error('No injected wallet found. Install a browser wallet to activate a drop.')
  }
  return provider
}

function hasInjectedWallet(): boolean {
  return Boolean((window as unknown as { ethereum?: EIP1193Provider }).ethereum)
}

/** The wallet's current chain, so the page can default to whatever the user is already on. */
export async function walletChainId(): Promise<number | null> {
  if (!hasInjectedWallet()) return null
  try {
    const hex = (await injected().request({ method: 'eth_chainId' })) as Hex
    return Number.parseInt(hex, 16)
  } catch {
    return null
  }
}

/**
 * Connect an injected wallet. Deliberately minimal: activating a drop is a single unprivileged
 * transaction that anyone can send, so there is nothing here worth a connector framework.
 */
export async function connect(chainId: number): Promise<Address> {
  const provider = injected()
  const [account] = (await provider.request({ method: 'eth_requestAccounts' })) as Address[]
  if (!account) throw new Error('Wallet returned no account')

  const current = (await provider.request({ method: 'eth_chainId' })) as Hex
  if (Number.parseInt(current, 16) !== chainId) {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    })
  }

  return account
}

export async function sendTransaction(params: {
  chainId: number
  account: Address
  to: Address
  data: Hex
  value: bigint
}) {
  const wallet = createWalletClient({
    account: params.account,
    chain: viemChain(params.chainId),
    transport: custom(injected()),
  })
  return wallet.sendTransaction({ to: params.to, data: params.data, value: params.value })
}
