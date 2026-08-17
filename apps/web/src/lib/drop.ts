import {
  buildActivateTx,
  compileRecipe,
  parseDropOrderPlaced,
  toOrderBookPayload,
  type CompiledRecipe,
  type DropRecipeJson,
} from '@cowprotocol/defi-drop-sdk'
import type { Address, Hex, TransactionReceipt } from 'viem'

import { COW_API, publicClient, sendTransaction } from './chain.js'

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

export interface DropStatus {
  deployed: boolean
  /** Whether the on-chain executor exists at all — false until the stack is deployed on this chain. */
  executorDeployed: boolean
  balance: bigint
  nativeBalance: bigint
}

export async function readDropStatus(compiled: CompiledRecipe, sellToken: Address): Promise<DropStatus> {
  const [code, executorCode, balance, nativeBalance] = await Promise.all([
    publicClient.getCode({ address: compiled.address }),
    publicClient.getCode({ address: compiled.deployment.executor }),
    publicClient
      .readContract({ address: sellToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [compiled.address] })
      .catch(() => 0n),
    publicClient.getBalance({ address: compiled.address }),
  ])

  return {
    deployed: Boolean(code && code !== '0x'),
    executorDeployed: Boolean(executorCode && executorCode !== '0x'),
    balance,
    nativeBalance,
  }
}

/**
 * Activate a drop: deploy it if needed and run its recipe.
 *
 * The connected wallet is only paying gas here — it is not authorising anything, because the recipe
 * was authorised by being committed into the address. Any other account could send the same call.
 */
export async function activateDrop(params: {
  account: Address
  recipe: DropRecipeJson
}): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const compiled = compileRecipe(params.recipe)
  const tx = buildActivateTx({
    deployment: compiled.deployment,
    owner: params.recipe.owner,
    setupData: compiled.setupData,
  })

  const hash = await sendTransaction({ account: params.account, ...tx })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  return { hash, receipt }
}

/**
 * Forward any pre-signed orders the activation placed to the CoW order book.
 *
 * The pre-signature is already on-chain, so this is purely making the order visible to solvers —
 * exactly the job the keeper does unattended. Returns the order UIDs the API accepted.
 */
export async function postPlacedOrders(receipt: TransactionReceipt, drop: Address): Promise<string[]> {
  const posted: string[] = []

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== drop.toLowerCase()) continue

    let order
    try {
      order = parseDropOrderPlaced(log)
    } catch {
      continue // not a DropOrderPlaced log
    }

    const response = await fetch(`${COW_API}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toOrderBookPayload(order, drop)),
    })

    const body = await response.text()
    if (!response.ok) {
      // A duplicate is a success: someone else already posted this order.
      if (body.includes('DuplicatedOrder')) {
        posted.push(order.orderUid)
        continue
      }
      throw new Error(`order book rejected the order (${response.status}): ${body}`)
    }
    posted.push(JSON.parse(body) as string)
  }

  return posted
}
