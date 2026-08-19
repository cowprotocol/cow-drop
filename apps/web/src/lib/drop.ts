import {
  buildActivateTx,
  compileRecipe,
  getDeployment,
  parseCowOrderPlaced,
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
 * The contracts every drop depends on whatever its recipe, and what their absence costs.
 *
 * Worth being precise about, because two of them are cow-shed's rather than ours and it is tempting to
 * assume they are simply there:
 *
 * - `COWShedExecutorFactory` is the CREATE2 deployer *and* the home of `initializeProxyWithoutSetup`,
 *   the owner's pre-deployment rescue hatch. Without it a funded drop can be neither activated nor
 *   rescued.
 * - `COWShedWithExecutorSigner` is the implementation every drop proxies to, so nothing runs without it.
 * - `DropExecutor` is the trusted executor and the commitment check.
 *
 * Listed deepest-dependency first, so a chain with nothing deployed reads in the order things must
 * arrive rather than in the order we happen to check them.
 *
 * The step contracts are deliberately *not* here — see `STEP_CONTRACTS`.
 */
const CORE_CONTRACTS: readonly { name: string; at: (deployment: DropDeployment) => Address }[] = [
  { name: 'COWShedWithExecutorSigner', at: (d) => d.shedImplementation },
  { name: 'COWShedExecutorFactory', at: (d) => d.factory },
  { name: 'DropExecutor', at: (d) => d.executor },
]

/**
 * The step contracts, which matter in a way that is easy to miss: a delegatecall to a codeless address
 * *succeeds silently*, so a missing one would let an activation appear to work while placing no order.
 * `DropExecutor._requireDelegateTargetsHaveCode` rejects that on-chain, but the UI should not offer the
 * button in the first place.
 *
 * Which of them a given drop needs depends on its recipe — a pre-sign drop never touches
 * `TwapSteps` — so these are resolved per recipe by `readMissingForRecipe`, and only used as a
 * whole for the coarse per-chain question the network picker asks.
 */
const STEP_CONTRACTS: readonly { name: string; at: (deployment: DropDeployment) => Address }[] = [
  { name: 'GuardSteps', at: (d) => d.guardSteps },
  { name: 'TokenSteps', at: (d) => d.tokenSteps },
  { name: 'PresignSteps', at: (d) => d.presignSteps },
  { name: 'TwapSteps', at: (d) => d.twapSteps },
  { name: 'StopLossSteps', at: (d) => d.stopLossSteps },
]

const hasCode = (value: string | undefined) => Boolean(value && value !== '0x')

/** Probe a list of named addresses and return the names of the ones with no code. */
async function readMissing(
  chainId: number,
  contracts: readonly { name: string; address: Address }[],
): Promise<string[]> {
  const client = getPublicClient(chainId)
  const codes = await Promise.all(contracts.map((contract) => client.getCode({ address: contract.address })))
  return contracts.filter((_, index) => !hasCode(codes[index])).map((contract) => contract.name)
}

/**
 * Which contracts are missing on a chain, asking about the whole generation.
 *
 * This is a question about the *chain*, not about a recipe: the addresses are identical everywhere, so
 * readiness depends on nothing but the chain id. That is what lets the network picker ask it about
 * chains the user has not selected — and why it has to check every step contract rather than the ones
 * some particular recipe happens to use.
 */
export async function readMissingContracts(chainId: number): Promise<string[]> {
  const deployment = getDeployment(chainId)
  return readMissing(
    chainId,
    [...CORE_CONTRACTS, ...STEP_CONTRACTS].map((contract) => ({
      name: contract.name,
      address: contract.at(deployment),
    })),
  )
}

/**
 * The same question narrowed to one recipe: the core contracts, plus exactly the contracts this
 * recipe delegatecalls into.
 *
 * The narrowing is the point. A pre-sign recipe does not care whether `TwapSteps` exists, and
 * gating its Activate button on a contract it never reaches would be a false negative. Conversely a
 * `raw` step that delegatecalls somewhere unexpected is checked too, named by its bare address —
 * delegatecalling a codeless address is the one thing that fails silently, so it is the one thing the
 * UI must not let the user walk into.
 */
export async function readMissingForRecipe(compiled: CompiledRecipe): Promise<string[]> {
  const deployment = compiled.deployment
  const named = new Map(STEP_CONTRACTS.map((contract) => [contract.at(deployment).toLowerCase(), contract.name]))

  const targets = new Map<string, string>()
  for (const call of compiled.recipe.calls) {
    if (!call.isDelegateCall) continue
    const key = call.target.toLowerCase()
    targets.set(key, named.get(key) ?? `the step contract at ${call.target}`)
  }

  return readMissing(deployment.chainId, [
    ...CORE_CONTRACTS.map((contract) => ({ name: contract.name, address: contract.at(deployment) })),
    ...[...targets].map(([address, name]) => ({ name, address: address as Address })),
  ])
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
  /** Which contracts this recipe needs but cannot find on this chain. */
  missing: string[]
  balance: bigint
  nativeBalance: bigint
}

export async function readDropStatus(compiled: CompiledRecipe, sellToken: Address): Promise<DropStatus> {
  const client = getPublicClient(compiled.deployment.chainId)
  const [code, missing, balance, nativeBalance] = await Promise.all([
    client.getCode({ address: compiled.address }),
    readMissingForRecipe(compiled),
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
      order = parseCowOrderPlaced(log)
    } catch {
      continue // not a CowOrderPlaced log
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
