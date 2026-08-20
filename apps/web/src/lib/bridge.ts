import { BungeeDropProvider, type BridgeQuote, type BridgeToken } from '@cowprotocol/cow-drop-bridging'
import {
  bungeeDelivery,
  compileRecipe,
  describeRecipe,
  directDelivery,
  type CompiledRecipe,
  type DropRecipeJson,
  type OnFailure,
} from '@cowprotocol/cow-drop-sdk'
import { erc20Abi, type Address, type Hex } from 'viem'

import { getPublicClient, sendTransaction } from './chain.js'

/**
 * Funding a drop across a bridge.
 *
 * The drop end of this needs nothing special: a drop address is fundable before it exists, so a
 * bridge can simply pay it and a keeper activates when the money lands. What this adds is the atomic
 * path — the bridge delivers to `DropBungeeReceiver` with the recipe as its destination payload, and
 * the CoW order is live in the same transaction as the fill.
 *
 * Bridging is a *funding method*, not a kind of recipe. Any recipe works, including a TWAP or a
 * stop-loss, which is why this takes a recipe rather than building one.
 */

/**
 * Chains a bridge route can start from.
 *
 * Bungee's supported set, narrowed to chains cow-sdk can describe — `chainInfo` needs an entry to
 * build a viem chain from. Note these are *source* chains and need no cow-drop deployment: the drop
 * lives on the destination, and all the source chain does is send one transaction.
 */
export const BRIDGE_SOURCE_CHAINS: readonly number[] = [1, 10, 100, 137, 8453, 42161, 43114]

const provider = new BungeeDropProvider()

export type { BridgeQuote, BridgeToken }

/**
 * How the money is delivered on the destination chain.
 *
 * - `direct` — the bridge pays the drop address itself and nothing runs on arrival. Works with every
 *   bridge, and nothing can be stolen, because a drop address belongs to exactly one recipe. Somebody
 *   still has to activate it; that is the keeper's job.
 * - `atomic` — the bridge pays a shared receiver and carries the recipe as its payload, so the order
 *   goes live inside the fill. Only some bridges can do this, and a delivery that fails to execute
 *   sits in a permissionless contract that anyone may sweep.
 *
 * See `docs/BRIDGING.md`.
 */
export type DeliveryMode = 'direct' | 'atomic'

/**
 * The token the bridge has to deliver, read out of the recipe.
 *
 * This is the recipe's **sell** token, and the distinction matters: a bridge-and-swap has two legs,
 * and the bridge's output is the drop's input. Getting it from the compiled bytes rather than from a
 * form field means it is whatever the drop address actually commits to, however the recipe was
 * written — a hand-built `raw` step included.
 */
export function deliveredTokenOf(compiled: CompiledRecipe): Address | null {
  const described = describeRecipe(compiled.setupData, compiled.deployment)

  for (const step of described.steps) {
    const arg = step.known?.args.find((candidate) => candidate.name === 'sellToken')
    if (typeof arg?.value === 'string') return arg.value as Address
  }
  return null
}

export interface BridgePlan {
  compiled: CompiledRecipe
  /** Where the money lands. */
  drop: Address
  /** The chain the drop lives on — the recipe's, never the wallet's. */
  destinationChainId: number
  /** What the bridge must deliver for the recipe to have anything to sell. */
  deliveredToken: Address
}

/** Everything about the destination, derived from the recipe alone. Cheap, and never quotes. */
export function planFrom(recipe: DropRecipeJson): BridgePlan {
  const compiled = compileRecipe(recipe)
  const deliveredToken = deliveredTokenOf(compiled)

  if (!deliveredToken) {
    throw new Error('this recipe names no sell token, so there is nothing for a bridge to deliver into it')
  }

  return {
    compiled,
    drop: compiled.address,
    destinationChainId: compiled.deployment.chainId,
    deliveredToken,
  }
}

/**
 * The tokens a bridge can actually deliver on the destination chain.
 *
 * Asked before quoting, because in atomic mode the bridges that run a destination payload reach far
 * fewer pairs than the chain list suggests — Across and CCTP do not serve Gnosis at all, and the
 * Gnosis native bridge only runs from Ethereum. Without this the first sign of an unreachable pair is
 * an empty route list, which reads like a failure rather than like a pair that was never going to
 * work. In direct mode the question is much easier and almost everything answers yes.
 */
export async function deliverableTokens(params: {
  sellChainId: number
  sellToken: Address
  buyChainId: number
  mode: DeliveryMode
}): Promise<BridgeToken[] | null> {
  try {
    // Asked for the mode that will actually be quoted. Direct reaches far more pairs, so asking the
    // atomic question would report perfectly good routes as unreachable.
    return await provider.getDeliverableTokens({ ...params, executesPayload: params.mode === 'atomic' })
  } catch {
    // Advisory only. If Bungee will not answer this, quoting is still allowed to try.
    return null
  }
}

/** A route, priced, with the source transaction that starts it. */
export async function quoteBridge(params: {
  plan: BridgePlan
  sender: Address
  sellChainId: number
  sellToken: Address
  sellAmount: bigint
  mode: DeliveryMode
  onFailure: OnFailure
}): Promise<BridgeQuote> {
  const { plan } = params

  return provider.getQuote({
    sender: params.sender,
    sellChainId: params.sellChainId,
    sellToken: params.sellToken,
    sellAmount: params.sellAmount,
    buyChainId: plan.destinationChainId,
    buyToken: plan.deliveredToken,
    // Built here rather than by the provider: the destination is cow-drop's business and the route is
    // the bridge's, and keeping the two apart is what lets a second provider reuse all of this.
    // `onFailure` only exists in atomic mode — direct delivery has no failure branch, because there is
    // no receiver holding anything to fall back with.
    destination:
      params.mode === 'direct'
        ? directDelivery(plan.compiled)
        : bungeeDelivery(plan.compiled, { onFailure: params.onFailure }),
  })
}

/** Where a person watches the bridge leg. */
export function bridgeExplorerUrl(hash: Hex): string {
  return provider.explorerUrl(hash)
}

/**
 * What the bridge is already allowed to move.
 *
 * Returns null when it cannot be read. A source chain here needs no cow-drop deployment and may be
 * served by an RPC this app has no override for, and an unreadable allowance must not block the
 * flow — an approval that turns out to be unnecessary is a wasted click, where a missing one is a
 * failed bridge.
 */
export async function readBridgeAllowance(params: {
  chainId: number
  token: Address
  owner: Address
  spender: Address
}): Promise<bigint | null> {
  try {
    return await getPublicClient(params.chainId).readContract({
      address: params.token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [params.owner, params.spender],
    })
  } catch {
    return null
  }
}

/**
 * The account's balance of the token it is about to bridge.
 *
 * Read through the public RPC, so it does not need the wallet on the source chain — the network only
 * has to match to *send*. Returns null when it cannot be read: a source chain needs no cow-drop
 * deployment and may be served by an endpoint this app has no override for, and an unreadable balance
 * should show as unknown rather than as zero.
 */
export async function readTokenBalance(params: {
  chainId: number
  token: Address
  owner: Address
}): Promise<bigint | null> {
  try {
    return await getPublicClient(params.chainId).readContract({
      address: params.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [params.owner],
    })
  } catch {
    return null
  }
}

/** Approve exactly what this bridge asked for, rather than an unlimited allowance. */
export async function approveBridge(params: {
  account: Address
  chainId: number
  approval: NonNullable<BridgeQuote['approval']>
}): Promise<Hex> {
  const { approval } = params

  return sendTransaction({
    chainId: params.chainId,
    account: params.account,
    to: approval.token,
    data: encodeApprove(approval.spender, approval.amount),
    value: 0n,
  })
}

/** Send the bridge transaction Bungee built. */
export async function sendBridge(params: { account: Address; quote: BridgeQuote }): Promise<Hex> {
  const { transaction } = params.quote

  return sendTransaction({
    chainId: transaction.chainId,
    account: params.account,
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
  })
}

/** `approve(address,uint256)`, hand-encoded to keep this file free of an ABI import cycle. */
function encodeApprove(spender: Address, amount: bigint): Hex {
  return `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`
}
