import { DropChainId } from '@cowprotocol/cow-drop-sdk'
import {
  OrderBookApi,
  OrderBookApiError,
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

/**
 * Public RPC endpoints where cow-sdk's default does not answer.
 *
 * cow-sdk names one RPC per chain, and three of them were unreachable or erroring when tested from a
 * browser context: mainnet (`eth.merkle.io`), Polygon (`polygon-rpc.com`) and Sepolia
 * (`sepolia.drpc.org`). Left as-is those chains would appear broken — no balances, no simulation — so
 * these are overridden with endpoints that were verified to answer `eth_blockNumber`.
 *
 * Only the chains that needed it are listed, so this is a patch over cow-sdk rather than a second
 * chain table. For anything beyond a demo, set `VITE_RPC_URL`.
 */
const RPC_OVERRIDES: Record<number, string> = {
  [DropChainId.MAINNET]: 'https://ethereum-rpc.publicnode.com',
  [DropChainId.POLYGON]: 'https://polygon-bor-rpc.publicnode.com',
  [DropChainId.SEPOLIA]: 'https://ethereum-sepolia-rpc.publicnode.com',
}

/** RPC endpoint. `VITE_RPC_URL` overrides, but only for the default chain — it names one endpoint. */
export function rpcUrl(chainId: number): string {
  const override = import.meta.env.VITE_RPC_URL
  if (override && chainId === DEFAULT_CHAIN_ID) return override

  const url = RPC_OVERRIDES[chainId] ?? chainInfo(chainId).rpcUrls.default.http[0]
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

/**
 * A readable message out of an orderbook API failure.
 *
 * The SDK's `OrderBookApiError` builds its `message` from `response.statusText`, which browsers report
 * as the empty string for every HTTP/2 response — and the CoW API is HTTP/2. So `error.message` is
 * literally nothing, while the part worth reading (`{"errorType":"NoLiquidity","description":"no route
 * found"}`) sits untouched on `body`. A failed quote rendered as a blank banner because of it.
 *
 * Anything that is not an API error is passed through, so callers can use this as their only
 * error-to-string step.
 */
export function describeOrderBookError(cause: unknown): string {
  if (!(cause instanceof OrderBookApiError)) {
    return cause instanceof Error ? cause.message : String(cause)
  }

  const status = `HTTP ${cause.response.status}`
  const detail = orderBookErrorDetail(cause.body) ?? cause.message.trim()
  return detail ? `${status}: ${detail}` : status
}

/** The API answers errors as `{ errorType, description }`, but non-JSON responses come through as text. */
function orderBookErrorDetail(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim() || undefined
  if (typeof body !== 'object' || body === null) return undefined

  const { errorType, description } = body as { errorType?: unknown; description?: unknown }
  const parts = [errorType, description].filter((part): part is string => typeof part === 'string' && part !== '')
  return parts.length > 0 ? parts.join(': ') : undefined
}

/** The API's own name for the failure (`NoLiquidity`, `DuplicatedOrder`, …), when it gave one. */
export function orderBookErrorType(cause: unknown): string | undefined {
  if (!(cause instanceof OrderBookApiError)) return undefined
  const { errorType } = (cause.body ?? {}) as { errorType?: unknown }
  return typeof errorType === 'string' ? errorType : undefined
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

/** Thrown when the user declines a wallet prompt. Not an error worth shouting about. */
export const USER_REJECTED = 4001

function errorCode(cause: unknown): number | undefined {
  return typeof cause === 'object' && cause !== null && 'code' in cause
    ? (cause as { code?: number }).code
    : undefined
}

export function isUserRejection(cause: unknown): boolean {
  return errorCode(cause) === USER_REJECTED
}

/**
 * Ask the wallet to switch chains, adding the chain first if it does not know it.
 *
 * A wallet that has never seen the chain answers `wallet_switchEthereumChain` with 4902; the recovery
 * is `wallet_addEthereumChain`, whose parameters we can fill entirely from cow-sdk's chain info plus
 * the RPC this app would use anyway.
 *
 * Throws on rejection so the caller can tell "declined" from "failed" — see `isUserRejection`.
 */
export async function switchChain(chainId: number): Promise<void> {
  const provider = injected()
  const hexChainId: Hex = `0x${chainId.toString(16)}`

  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId }] })
    return
  } catch (cause) {
    // 4902: the wallet does not have this chain configured.
    if (errorCode(cause) !== 4902) throw cause
  }

  const info = chainInfo(chainId)
  await provider.request({
    method: 'wallet_addEthereumChain',
    params: [
      {
        chainId: hexChainId,
        chainName: info.label,
        nativeCurrency: {
          name: info.nativeCurrency.name ?? 'Ether',
          symbol: info.nativeCurrency.symbol ?? 'ETH',
          decimals: info.nativeCurrency.decimals ?? 18,
        },
        rpcUrls: [rpcUrl(chainId)],
        blockExplorerUrls: [info.blockExplorer.url],
      },
    ],
  } as Parameters<EIP1193Provider['request']>[0])
}

/**
 * Follow the wallet's own network changes, so the page and the wallet cannot silently disagree.
 *
 * Returns an unsubscribe function, or a no-op when there is no wallet.
 */
export function onChainChanged(listener: (chainId: number) => void): () => void {
  if (!hasInjectedWallet()) return () => {}

  const provider = injected() as EIP1193Provider & {
    on?: (event: string, handler: (value: unknown) => void) => void
    removeListener?: (event: string, handler: (value: unknown) => void) => void
  }

  const handler = (value: unknown) => {
    const parsed = typeof value === 'string' ? Number.parseInt(value, 16) : Number(value)
    if (Number.isFinite(parsed)) listener(parsed)
  }

  provider.on?.('chainChanged', handler)
  return () => provider.removeListener?.('chainChanged', handler)
}

/**
 * The already-authorised account, if there is one, without prompting.
 *
 * `eth_accounts` answers from the permission the wallet already holds, where `eth_requestAccounts`
 * would pop a dialog. Without this a reload forgets the account — the page would still read the
 * wallet's *chain* on mount, so it looked connected while every action that needs an account stayed
 * disabled.
 */
export async function readAccount(): Promise<Address | null> {
  if (!hasInjectedWallet()) return null
  const [account] = (await injected().request({ method: 'eth_accounts' })) as Address[]
  return account ?? null
}

/** Follow the wallet's account, so locking it or switching accounts moves the page too. */
export function onAccountsChanged(listener: (account: Address | null) => void): () => void {
  if (!hasInjectedWallet()) return () => {}

  const provider = injected() as EIP1193Provider & {
    on?: (event: string, handler: (value: unknown) => void) => void
    removeListener?: (event: string, handler: (value: unknown) => void) => void
  }

  const handler = (value: unknown) => {
    const accounts = Array.isArray(value) ? (value as Address[]) : []
    listener(accounts[0] ?? null)
  }

  provider.on?.('accountsChanged', handler)
  return () => provider.removeListener?.('accountsChanged', handler)
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
    await switchChain(chainId)
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
