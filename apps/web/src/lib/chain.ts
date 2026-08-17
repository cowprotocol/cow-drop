import { OrderBookApi, SupportedChainId, getWrappedTokenForChain, gnosisChain } from '@cowprotocol/cow-sdk'
import { createPublicClient, custom, createWalletClient, http, type Address, type EIP1193Provider, type Hex } from 'viem'
import { gnosis } from 'viem/chains'

/**
 * CoW-facing chain metadata comes from the official SDK rather than being retyped here — it already
 * knows the block explorer, the API path segment and the wrapped native token for every chain it
 * supports, and those are exactly the things that go stale when copied.
 *
 * viem's chain object is still what the clients take, since that is the type they want.
 */
export const CHAIN_ID = SupportedChainId.GNOSIS_CHAIN
/**
 * The chain object itself rather than `getChainInfo(id)`: that returns `ChainInfo | undefined` over a
 * union that includes non-EVM chains, so it would need narrowing for something already known here.
 */
export const CHAIN_INFO = gnosisChain
export const CHAIN = gnosis

/**
 * Public RPC is fine for a demo; override with VITE_RPC_URL for anything real.
 *
 * Exported so the copy-pasteable commands quote the same endpoint the page is reading from —
 * otherwise a user could get a different answer from the terminal than from the UI.
 */
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? CHAIN_INFO.rpcUrls.default.http[0]

export const publicClient = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL),
})

/** Quotes and order submission. The SDK owns the base URL per chain. */
export const orderBookApi = new OrderBookApi({ chainId: CHAIN_ID })

/** Only needed for the copy-pasteable curl; the SDK builds its own URLs internally. */
export const COW_API = `https://api.cow.fi/${CHAIN_INFO.internalId}/api/v1`

/** The chain's general-purpose explorer: address-centric, so it shows balances and transactions. */
export const BLOCK_EXPLORER = CHAIN_INFO.blockExplorer

/**
 * The wrapped native token, so a natively funded drop can trade. Asserted non-null: every EVM chain
 * the SDK supports has one, and a missing entry here would be a broken build rather than a runtime
 * case to handle.
 */
const wrappedNative = getWrappedTokenForChain(CHAIN_ID)
if (!wrappedNative) throw new Error(`no wrapped native token known for chain ${CHAIN_ID}`)
export const WRAPPED_NATIVE = wrappedNative

/**
 * CoW's own explorer: order-centric, so it shows what a drop is trading.
 *
 * Its network slugs are its own (`gc`, `arb1`, …) and cow-sdk does not expose them — `internalId`
 * is `xdai`, which the explorer does not accept — so this one small map stays local.
 */
const COW_EXPLORER_SLUGS: Partial<Record<SupportedChainId, string>> = {
  [SupportedChainId.MAINNET]: '',
  [SupportedChainId.GNOSIS_CHAIN]: '/gc',
  [SupportedChainId.ARBITRUM_ONE]: '/arb1',
  [SupportedChainId.BASE]: '/base',
  [SupportedChainId.SEPOLIA]: '/sepolia',
}

export const COW_EXPLORER = `https://explorer.cow.fi${COW_EXPLORER_SLUGS[CHAIN_ID] ?? ''}`

function injected(): EIP1193Provider {
  const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum
  if (!provider) {
    throw new Error('No injected wallet found. Install a browser wallet to activate a drop.')
  }
  return provider
}

/**
 * Connect an injected wallet. Deliberately minimal: activating a drop is a single unprivileged
 * transaction that anyone can send, so there is nothing here worth a connector framework.
 */
export async function connect(): Promise<Address> {
  const provider = injected()
  const [account] = (await provider.request({ method: 'eth_requestAccounts' })) as Address[]
  if (!account) throw new Error('Wallet returned no account')

  const currentChain = (await provider.request({ method: 'eth_chainId' })) as Hex
  if (Number.parseInt(currentChain, 16) !== CHAIN.id) {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${CHAIN.id.toString(16)}` }],
    })
  }

  return account
}

export async function sendTransaction(params: { account: Address; to: Address; data: Hex; value: bigint }) {
  const wallet = createWalletClient({ account: params.account, chain: CHAIN, transport: custom(injected()) })
  return wallet.sendTransaction({ to: params.to, data: params.data, value: params.value })
}
