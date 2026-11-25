import {
  buildActivateConvertTx,
  buildActivatePaymentTx,
  buildActivateTx,
  buildHookOrder,
  buildHookPaymentOrder,
  compileRecipe,
  COW_VAULT_RELAYER,
  findHookPayment,
  findSellBalanceOrders,
  hookNeeded,
  getDeployment,
  parseOrderPlacement,
  toOrderBookPayload,
  type CompiledRecipe,
  type DropDeployment,
  type HookOrder,
  type DropRecipeJson,
} from '@cowprotocol/cow-drop-sdk'
import type { OrderCreation } from '@cowprotocol/cow-sdk'
import { encodeFunctionData, type Address, type Hex, type TransactionReceipt } from 'viem'

import {
  describeOrderBookError,
  getOrderBookApi,
  getPublicClient,
  orderBookErrorType,
  sendTransaction,
} from './chain.js'

const COW_SHED_PROXY_ABI = [
  { type: 'function', name: 'admin', stateMutability: 'nonpayable', inputs: [], outputs: [{ type: 'address' }] },
] as const

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
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
const ERC20_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

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

  // A handler is registered by a plain call, so the loop above never sees it. Without its code the
  // activation still succeeds and the drop then refuses every order, which is the quiet failure.
  const handlers: { name: string; address: Address }[] = []
  if (deployment.sellBalanceHandler && findSellBalanceOrders(deployment, compiled.setupData).length > 0) {
    handlers.push({ name: 'SellBalanceHandler', address: deployment.sellBalanceHandler })
  }
  if (deployment.paymentHandler && findHookPayment(deployment, compiled.setupData)) {
    handlers.push({ name: 'PaymentHandler', address: deployment.paymentHandler })
  }

  return readMissing(deployment.chainId, [
    ...CORE_CONTRACTS.map((contract) => ({ name: contract.name, address: contract.at(deployment) })),
    ...[...targets].map(([address, name]) => ({ name, address: address as Address })),
    ...handlers,
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

/**
 * Which of this generation's contracts are missing from a chain, read once per session and shared
 * by every caller.
 */
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

/**
 * Everything the drop panel shows about one address: whether it exists yet, what it is missing, and
 * what has arrived. Read uncached, so Refresh means refresh.
 */
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
 * Activate a payment drop, paying with its balance of `sellToken`.
 *
 * A payment recipe names no sell token, so plain `activate` reverts with `NoPaymentToken`; this goes
 * through `PaymentSteps.activatePayment` instead. As with `activateDrop`, the wallet only pays gas:
 * whichever token is named, the order still guarantees the owner's price.
 */
export async function activatePaymentDrop(params: {
  account: Address
  recipe: DropRecipeJson
  sellToken: Address
}): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const compiled = compileRecipe(params.recipe)
  const tx = buildActivatePaymentTx({
    deployment: compiled.deployment,
    owner: params.recipe.owner,
    setupData: compiled.setupData,
    sellToken: params.sellToken,
  })

  const chainId = compiled.deployment.chainId
  const hash = await sendTransaction({ chainId, account: params.account, ...tx })
  const receipt = await getPublicClient(chainId).waitForTransactionReceipt({ hash })
  return { hash, receipt }
}

/**
 * Activate a convert drop: sell its balance of `sellToken` for at least `minBuyAmount`.
 *
 * A convert recipe commits to no price, so the minimum is supplied here and goes through
 * `ConvertSteps.activateConvert` — plain `activate` records no minimum and is refused. Whether this
 * wallet is allowed to name it is the recipe's business: the step reverts with `NotThePricer` unless
 * the caller is the committed pricer, the owner, or the pricer is zero.
 */
export async function activateConvertDrop(params: {
  account: Address
  recipe: DropRecipeJson
  sellToken: Address
  minBuyAmount: bigint
}): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const compiled = compileRecipe(params.recipe)
  const tx = buildActivateConvertTx({
    deployment: compiled.deployment,
    owner: params.recipe.owner,
    setupData: compiled.setupData,
    sellToken: params.sellToken,
    minBuyAmount: params.minBuyAmount,
  })

  const chainId = compiled.deployment.chainId
  const hash = await sendTransaction({ chainId, account: params.account, ...tx })
  const receipt = await getPublicClient(chainId).waitForTransactionReceipt({ hash })
  return { hash, receipt }
}

/**
 * Pay a payment drop: a plain ERC20 `transfer` of `amount` from the connected wallet to the drop.
 *
 * Nothing drop-specific happens here, on purpose. The drop does not exist yet and needs no call: a
 * transfer is all a payer does, from this page or from any wallet or exchange, and the keeper takes it
 * from there. Resolves once the transfer is mined, so the balance read after it is the paid one.
 */
export async function sendPayment(params: {
  chainId: number
  account: Address
  token: Address
  drop: Address
  amount: bigint
}): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const hash = await sendTransaction({
    chainId: params.chainId,
    account: params.account,
    to: params.token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [params.drop, params.amount] }),
    value: 0n,
  })
  const receipt = await getPublicClient(params.chainId).waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`The transfer reverted in ${hash}`)
  return { hash, receipt }
}

/** One ERC20 balance of an address. A token that does not answer reads as zero. */
/**
 * The native balance of an address.
 *
 * Its own read because native is not an ERC20 and `balanceOf` cannot see it — which is exactly why a
 * natively-funded drop looked empty before `ConvertSteps` learned to wrap.
 */
export async function readNativeBalance(chainId: number, holder: Address): Promise<bigint> {
  return getPublicClient(chainId)
    .getBalance({ address: holder })
    .catch(() => 0n)
}

export async function readTokenBalance(chainId: number, token: Address, holder: Address): Promise<bigint> {
  return getPublicClient(chainId)
    .readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [holder] })
    .catch(() => 0n)
}

/**
 * Who owns a deployed drop, read from the chain rather than derived from a recipe.
 *
 * Recovery needs this for an address someone pasted, where there is no recipe to read the owner off.
 * `COWShedProxy.admin()` answers only when the caller is the proxy itself — it proxies transparently
 * for everyone else — so the call is made *as* the drop. That costs nothing in an `eth_call`, which
 * never checks who the sender claims to be.
 *
 * `null` when the address has no code or answers with something that is not an address: an
 * undeployed drop, or not a drop at all.
 */
export async function readDropOwner(chainId: number, drop: Address): Promise<Address | null> {
  try {
    const result = await getPublicClient(chainId).call({
      account: drop,
      to: drop,
      data: encodeFunctionData({ abi: COW_SHED_PROXY_ABI, functionName: 'admin' }),
    })
    if (!result.data || result.data.length !== 66) return null
    const owner = `0x${result.data.slice(26)}` as Address
    return owner === '0x0000000000000000000000000000000000000000' ? null : owner
  } catch {
    return null
  }
}

/** What `drop` lets CoW's relayer pull of `token`, or zero if it cannot be read: the hook is then kept. */
async function readRelayerAllowance(chainId: number, token: Address, drop: Address): Promise<bigint> {
  try {
    return await getPublicClient(chainId).readContract({
      address: token,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [drop, COW_VAULT_RELAYER],
    })
  } catch {
    return 0n
  }
}

/** Whether the recipe's order is posted before activation and activates the drop from its pre-hook. */
export function isHookActivated(recipe: DropRecipeJson): boolean {
  return recipe.steps.some((step) => step.type === 'sellBalanceViaHook' || step.type === 'paymentViaHook')
}

/**
 * Post the order for a hook-activated drop, selling the balance it holds right now.
 *
 * No wallet and no transaction: the order carries the activation as its pre-hook, so the solver that
 * fills it deploys the drop. This is the keeper's job, done by hand.
 *
 * @param params.sellToken Required for a payment recipe, which names no sell token of its own.
 */
export async function postHookOrder(params: {
  recipe: DropRecipeJson
  balance: bigint
  sellToken?: Address
}): Promise<string> {
  const compiled = compileRecipe(params.recipe)
  const base = {
    deployment: compiled.deployment,
    owner: params.recipe.owner,
    setupData: compiled.setupData,
    balance: params.balance,
    now: Math.floor(Date.now() / 1000),
  }

  const payment = findHookPayment(compiled.deployment, compiled.setupData)
  const swap = findSellBalanceOrders(compiled.deployment, compiled.setupData).find(
    (found) => !params.sellToken || found.data.sellToken.toLowerCase() === params.sellToken.toLowerCase(),
  )
  const registration = payment ?? swap
  if (!registration) throw new Error('this recipe has no order that activates its own drop')
  const sellToken = params.sellToken ?? swap?.data.sellToken
  if (!sellToken) throw new Error('a payment order needs the token it is paid in')

  // The hook deploys the drop and approves the relayer, so it is only needed until the relayer can
  // already pull this balance. A strict recipe keeps it on every order.
  const hook = hookNeeded({
    strict: registration.data.strict,
    balance: params.balance,
    allowance: registration.data.strict ? 0n : await readRelayerAllowance(compiled.deployment.chainId, sellToken, compiled.address),
  })

  const built: HookOrder = payment
    ? buildHookPaymentOrder({ ...base, sellToken, hook })
    : buildHookOrder({ ...base, sellToken, hook })

  const orderBook = getOrderBookApi(compiled.deployment.chainId)
  try {
    // The order book refuses an appData hash it has never seen, and with a hook this document
    // exists nowhere else: it is built around this drop's own activation call.
    if (built.appDataDocument !== undefined) {
      await orderBook.uploadAppData(built.order.appData, built.appDataDocument)
    }
    return await orderBook.sendOrder(built.payload as unknown as OrderCreation)
  } catch (cause) {
    if (orderBookErrorType(cause) === 'DuplicatedOrder') return built.orderUid
    throw new Error(describeOrderBookError(cause), { cause })
  }
}

/**
 * Forward any pre-signed orders the activation placed to the CoW order book.
 *
 * The pre-signature is already on-chain, so this is purely making the order visible to solvers —
 * exactly the job the keeper does unattended. Returns the order UIDs the API accepted.
 *
 * Submitted through `OrderBookApi` rather than a hand-rolled fetch, so the base URL, the payload type
 * and the error shapes are the SDK's problem rather than ours.
 *
 * @param settlement Needed because `OrderPlacement` carries no order uid — it is recomputed from the
 *                   order struct against the settlement contract's domain separator.
 */
export async function postPlacedOrders(
  receipt: TransactionReceipt,
  drop: Address,
  chainId: number,
  settlement: Address,
): Promise<string[]> {
  const posted: string[] = []

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== drop.toLowerCase()) continue

    let order
    try {
      order = parseOrderPlacement(log, { chainId, settlement })
    } catch {
      continue // not an OrderPlacement log
    }

    try {
      posted.push(await getOrderBookApi(chainId).sendOrder(toOrderBookPayload(order, drop) as OrderCreation))
    } catch (cause) {
      // A duplicate is a success: someone else already posted this order.
      if (orderBookErrorType(cause) === 'DuplicatedOrder') {
        posted.push(order.orderUid)
        continue
      }
      // Rewrapped because the SDK's own message for an API error is empty — see
      // `describeOrderBookError`.
      throw new Error(describeOrderBookError(cause), { cause })
    }
  }

  return posted
}
