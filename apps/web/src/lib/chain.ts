import { createPublicClient, custom, createWalletClient, http, type Address, type EIP1193Provider, type Hex } from 'viem'
import { gnosis } from 'viem/chains'

export const CHAIN = gnosis

/**
 * Public RPC is fine for a demo; override with VITE_RPC_URL for anything real.
 *
 * Exported so the copy-pasteable commands quote the same endpoint the page is reading from —
 * otherwise a user could get a different answer from the terminal than from the UI.
 */
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? CHAIN.rpcUrls.default.http[0]

export const publicClient = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL),
})

export const COW_API = `https://api.cow.fi/xdai/api/v1`

/** CoW's own explorer: order-centric, so it shows what a drop is trading. */
export const COW_EXPLORER = `https://explorer.cow.fi/gc`

/** The chain's general-purpose explorer: address-centric, so it shows balances and transactions. */
export const BLOCK_EXPLORER = CHAIN.blockExplorers.default

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
