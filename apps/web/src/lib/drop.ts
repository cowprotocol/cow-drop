import {
  buildActivateTx,
  compileRecipe,
  getDeployment,
  parseDropOrderPlaced,
  toOrderBookPayload,
  type CompiledRecipe,
  type DropDeployment,
  type DropRecipeJson,
} from '@cowprotocol/cow-drop-sdk'
import type { OrderCreation } from '@cowprotocol/cow-sdk'
import type { Address, Hex, TransactionReceipt } from 'viem'

import { getOrderBookApi, getPublicClient, sendTransaction } from './chain.js'

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

/**
 * Every contract a drop depends on, and what its absence costs.
 *
 * All four matter, and it is worth being precise about why, because two of them are cow-shed's rather
 * than ours and it is tempting to assume they are simply there:
 *
 * - `COWShedExecutorFactory` is the CREATE2 deployer *and* the home of `initializeProxyWithoutSetup`,
 *   the owner's pre-deployment rescue hatch. Without it a funded drop can be neither activated nor
 *   rescued.
 * - `COWShedWithExecutorSigner` is the implementation every drop proxies to, so nothing runs without it.
 * - `DropRecipes` matters in a way that is easy to miss: a delegatecall to a codeless address succeeds
 *   silently, so a missing one would let an activation appear to work while placing no order.
 *   `DropExecutor` rejects that on-chain, but the UI should not offer the button in the first place.
 * - `DropExecutor` is the trusted executor and the commitment check.
 *
 * Listed deepest-dependency first, so a chain with nothing deployed reads in the order things must
 * arrive rather than in the order we happen to check them.
 */
const REQUIRED_CONTRACTS: readonly { name: string; at: (deployment: DropDeployment) => Address }[] = [
  { name: 'COWShedWithExecutorSigner', at: (d) => d.shedImplementation },
  { name: 'COWShedExecutorFactory', at: (d) => d.factory },
  { name: 'DropRecipes', at: (d) => d.recipes },
  { name: 'DropExecutor', at: (d) => d.executor },
]

const hasCode = (value: string | undefined) => Boolean(value && value !== '0x')

/**
 * Which of the required contracts are missing on a chain.
 *
 * This is a question about the *chain*, not about a recipe: the addresses are identical everywhere, so
 * readiness depends on nothing but the chain id. That is what lets the network picker ask it about
 * chains the user has not selected.
 */
export async function readMissingContracts(chainId: number): Promise<string[]> {
  const deployment = getDeployment(chainId)
  const client = getPublicClient(chainId)
  const codes = await Promise.all(
    REQUIRED_CONTRACTS.map((contract) => client.getCode({ address: contract.at(deployment) })),
  )
  return REQUIRED_CONTRACTS.filter((_, index) => !hasCode(codes[index])).map((contract) => contract.name)
}

/**
 * The same question, memoised, for the network picker's background sweep across every chain.
 *
 * Cached for the life of the page because contracts do not un-deploy, and the picker would otherwise
 * re-probe every chain on each render. The authoritative read for the *selected* chain stays
 * uncached in `readDropStatus`, so the Refresh button genuinely refreshes.
 */
const readinessProbes = new Map<number, Promise<string[]>>()

/** Drop a cached answer so the next probe genuinely re-reads. Used by the retry button. */
export function forgetChainReadiness(chainId: number): void {
  readinessProbes.delete(chainId)
}

export function probeChainReadiness(chainId: number): Promise<string[]> {
  const existing = readinessProbes.get(chainId)
  if (existing) return existing

  const probe = readMissingContracts(chainId)
  // A failed probe must not be cached as an answer, or one flaky RPC response marks a chain
  // permanently unknown for the rest of the session.
  probe.catch(() => readinessProbes.delete(chainId))
  readinessProbes.set(chainId, probe)
  return probe
}

export interface DropStatus {
  deployed: boolean
  /** Which of the contracts in `REQUIRED_CONTRACTS` are missing on this chain. */
  missing: string[]
  balance: bigint
  nativeBalance: bigint
}

export async function readDropStatus(compiled: CompiledRecipe, sellToken: Address): Promise<DropStatus> {
  const client = getPublicClient(compiled.deployment.chainId)
  const [code, missing, balance, nativeBalance] = await Promise.all([
    client.getCode({ address: compiled.address }),
    readMissingContracts(compiled.deployment.chainId),
    client
      .readContract({ address: sellToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [compiled.address] })
      .catch(() => 0n),
    client.getBalance({ address: compiled.address }),
  ])

  return { deployed: hasCode(code), missing, balance, nativeBalance }
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

  const chainId = compiled.deployment.chainId
  const hash = await sendTransaction({ chainId, account: params.account, ...tx })
  const receipt = await getPublicClient(chainId).waitForTransactionReceipt({ hash })
  return { hash, receipt }
}

/**
 * Forward any pre-signed orders the activation placed to the CoW order book.
 *
 * The pre-signature is already on-chain, so this is purely making the order visible to solvers —
 * exactly the job the keeper does unattended. Returns the order UIDs the API accepted.
 *
 * Submitted through `OrderBookApi` rather than a hand-rolled fetch, so the base URL, the payload type
 * and the error shapes are the SDK's problem rather than ours.
 */
export async function postPlacedOrders(
  receipt: TransactionReceipt,
  drop: Address,
  chainId: number,
): Promise<string[]> {
  const posted: string[] = []

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== drop.toLowerCase()) continue

    let order
    try {
      order = parseDropOrderPlaced(log)
    } catch {
      continue // not a DropOrderPlaced log
    }

    try {
      posted.push(await getOrderBookApi(chainId).sendOrder(toOrderBookPayload(order, drop) as OrderCreation))
    } catch (cause) {
      // A duplicate is a success: someone else already posted this order.
      if (JSON.stringify(cause).includes('DuplicatedOrder')) {
        posted.push(order.orderUid)
        continue
      }
      throw cause
    }
  }

  return posted
}
