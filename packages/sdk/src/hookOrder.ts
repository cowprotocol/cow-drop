import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToString,
  keccak256,
  stringToHex,
  toBytes,
  type Address,
  type Hex,
} from 'viem'

import { knownAppDataDocument } from './appData.js'
import { decodeRecipe, deriveDropAddress } from './encoding.js'
import { cowDomainSeparator, orderUidFor, type CowOrderData } from './orderUid.js'
import { buildActivatePaymentTx, buildActivateTx } from './tx.js'
import type { DropDeployment, LimitPriceFraction } from './types.js'

/** `GPv2VaultRelayer`: what a drop approves so the settlement contract can pull the sell token. */
export const COW_VAULT_RELAYER: Address = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'

/**
 * Gas the solver must forward to the activation hook.
 *
 * Committed into the recipe, so it is a ceiling picked once: a hook that runs out fails silently and
 * leaves the order unfillable, while a generous limit only costs what the activation really burns.
 */
export const DEFAULT_HOOK_GAS_LIMIT = 800_000n

const KIND_SELL: Hex = '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775'
const BALANCE_ERC20: Hex = '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9'

/** The JSON either side of the activation hook's calldata. The handler rebuilds the document from it. */
export interface AppDataTemplate {
  /** Must end in `0x`: the calldata is appended as bare hex. */
  prefix: string
  suffix: string
}

/** `SellBalanceHandler.Data`: what a recipe commits a whole-balance sell to. */
export interface SellBalanceData {
  sellToken: Address
  buyToken: Address
  receiver: Address
  limitPrice: LimitPriceFraction
  validitySeconds: bigint
  /** Whether every order needs its own hook to have run the recipe. Set it with a guard or a ration. */
  strict: boolean
  /** The appData of an order posted with no hook. */
  appData: Hex
  /** Empty prefix and suffix mean a fixed `appData`. */
  appDataTemplate: AppDataTemplate
}

/** Hand-written like the other ComposableCoW ABIs here: composable-cow is not a submodule. */
export const COMPOSABLE_COW_CREATE_ABI = [
  {
    type: 'function',
    name: 'create',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'handler', type: 'address' },
          { name: 'salt', type: 'bytes32' },
          { name: 'staticInput', type: 'bytes' },
        ],
      },
      { name: 'dispatch', type: 'bool' },
    ],
    outputs: [],
  },
] as const

const SELL_BALANCE_DATA_PARAMS = [
  {
    type: 'tuple',
    components: [
      { name: 'sellToken', type: 'address' },
      { name: 'buyToken', type: 'address' },
      { name: 'receiver', type: 'address' },
      { name: 'limitNumerator', type: 'uint256' },
      { name: 'limitDenominator', type: 'uint256' },
      { name: 'validitySeconds', type: 'uint256' },
      { name: 'strict', type: 'bool' },
      { name: 'appData', type: 'bytes32' },
      { name: 'appDataPrefix', type: 'bytes' },
      { name: 'appDataSuffix', type: 'bytes' },
    ],
  },
] as const

const ORDER_COMPONENTS = [
  { name: 'sellToken', type: 'address' },
  { name: 'buyToken', type: 'address' },
  { name: 'receiver', type: 'address' },
  { name: 'sellAmount', type: 'uint256' },
  { name: 'buyAmount', type: 'uint256' },
  { name: 'validTo', type: 'uint32' },
  { name: 'appData', type: 'bytes32' },
  { name: 'feeAmount', type: 'uint256' },
  { name: 'kind', type: 'bytes32' },
  { name: 'partiallyFillable', type: 'bool' },
  { name: 'sellTokenBalance', type: 'bytes32' },
  { name: 'buyTokenBalance', type: 'bytes32' },
] as const

/** `(GPv2Order.Data, ComposableCoW.PayloadStruct)`: what `DropExecutor.isValidSignature` decodes. */
const SIGNATURE_PARAMS = [
  { type: 'tuple', components: ORDER_COMPONENTS },
  {
    type: 'tuple',
    components: [
      { name: 'proof', type: 'bytes32[]' },
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'handler', type: 'address' },
          { name: 'salt', type: 'bytes32' },
          { name: 'staticInput', type: 'bytes' },
        ],
      },
      { name: 'offchainInput', type: 'bytes' },
    ],
  },
] as const

/**
 * The default appData template: a document whose only content is the activation hook.
 *
 * Write your own to add a partner fee or anything else, keeping the hook's `callData` as the one
 * place the prefix ends and the suffix begins.
 */
export function hookAppDataTemplate(params: {
  deployment: Pick<DropDeployment, 'executor'>
  gasLimit?: bigint
  /** The contract the hook calls. Defaults to the executor; a payment's hook calls `PaymentSteps`. */
  target?: Address
}): AppDataTemplate {
  const gasLimit = params.gasLimit ?? DEFAULT_HOOK_GAS_LIMIT
  const target = getAddress(params.target ?? params.deployment.executor)
  return {
    prefix: '{"appCode":"cow-drop","metadata":{"hooks":{"pre":[{"callData":"0x',
    suffix: `","gasLimit":"${gasLimit}","target":"${target}"}]}},"version":"1.1.0"}`,
  }
}

/**
 * The appData document for one drop: the template around its own activation call.
 *
 * With `sellToken` the call is `PaymentSteps.activatePayment`, which is how a payment's hook tells
 * the drop which token to approve.
 */
export function hookAppDataDocument(
  template: AppDataTemplate,
  params: {
    deployment: Pick<DropDeployment, 'executor' | 'paymentSteps'>
    owner: Address
    setupData: Hex
    sellToken?: Address
  },
): string {
  const { sellToken } = params
  const call = sellToken ? buildActivatePaymentTx({ ...params, sellToken }) : buildActivateTx(params)
  return template.prefix + call.data.slice(2) + template.suffix
}

/** `abi.encode(SellBalanceHandler.Data)`, the handler's `staticInput`. */
export function encodeSellBalanceData(data: SellBalanceData): Hex {
  return encodeAbiParameters(SELL_BALANCE_DATA_PARAMS, [
    {
      sellToken: data.sellToken,
      buyToken: data.buyToken,
      receiver: data.receiver,
      limitNumerator: data.limitPrice.numerator,
      limitDenominator: data.limitPrice.denominator,
      validitySeconds: data.validitySeconds,
      strict: data.strict,
      appData: data.appData,
      appDataPrefix: stringToHex(data.appDataTemplate.prefix),
      appDataSuffix: stringToHex(data.appDataTemplate.suffix),
    },
  ])
}

export function decodeSellBalanceData(staticInput: Hex): SellBalanceData {
  const [raw] = decodeAbiParameters(SELL_BALANCE_DATA_PARAMS, staticInput)
  return {
    sellToken: raw.sellToken,
    buyToken: raw.buyToken,
    receiver: raw.receiver,
    limitPrice: { numerator: raw.limitNumerator, denominator: raw.limitDenominator },
    validitySeconds: raw.validitySeconds,
    strict: raw.strict,
    appData: raw.appData,
    appDataTemplate: { prefix: hexToString(raw.appDataPrefix), suffix: hexToString(raw.appDataSuffix) },
  }
}

/** A `SellBalanceHandler` registration found in a recipe. */
export interface SellBalanceRegistration {
  params: { handler: Address; salt: Hex; staticInput: Hex }
  data: SellBalanceData
}

/**
 * Every whole-balance sell a recipe registers, read back out of its committed bytes.
 *
 * From `setupData` rather than the recipe file, so whoever posts the order works from exactly what
 * the drop address commits to.
 */
export function findSellBalanceOrders(
  deployment: Pick<DropDeployment, 'composableCow' | 'sellBalanceHandler'>,
  setupData: Hex,
): SellBalanceRegistration[] {
  return registrationsOf(deployment.composableCow, deployment.sellBalanceHandler, setupData).map((params) => ({
    params,
    data: decodeSellBalanceData(params.staticInput),
  }))
}

/** Every plain `ComposableCoW.create` in a recipe that registers `handler`. */
function registrationsOf(
  composableCow: Address,
  handler: Address | undefined,
  setupData: Hex,
): SellBalanceRegistration['params'][] {
  if (!handler) return []

  const found: SellBalanceRegistration['params'][] = []
  for (const call of decodeRecipe(setupData).calls) {
    if (call.isDelegateCall || call.target.toLowerCase() !== composableCow.toLowerCase()) continue
    try {
      const { args } = decodeFunctionData({ abi: COMPOSABLE_COW_CREATE_ABI, data: call.callData })
      if (args[0].handler.toLowerCase() === handler.toLowerCase()) found.push(args[0])
    } catch {
      // Some other call to ComposableCoW.
    }
  }
  return found
}

export interface HookOrder {
  drop: Address
  order: CowOrderData
  orderUid: Hex
  /** What the drop's `isValidSignature` is handed. No owner prefix: the order book adds it. */
  signature: Hex
  /** Upload this before posting. Undefined when the appData is fixed and the document is not known. */
  appDataDocument: string | undefined
  /** The `POST /api/v1/orders` body. */
  payload: ReturnType<typeof toHookOrderPayload>
}

/**
 * The order to post for a funded drop, whether or not the drop is deployed yet.
 *
 * Built from the recipe and the balance alone. Its appData carries the activation as a pre-hook, so
 * the solver that fills it deploys the drop in the same transaction and nobody pays for an
 * activation up front.
 *
 * @param params.balance The drop's balance of the sell token. The handler accepts nothing else.
 * @param params.now     Unix seconds. `validTo` is set `clockSkewSeconds` short of the furthest the
 *                       handler allows, because the chain's clock decides and may run behind this one.
 */
export function buildHookOrder(params: {
  deployment: DropDeployment
  owner: Address
  setupData: Hex
  balance: bigint
  now: number
  /** Which registration to use when a recipe has several. Defaults to the first. */
  sellToken?: Address
  clockSkewSeconds?: number
}): HookOrder {
  const { deployment, owner, setupData, balance } = params

  const registrations = findSellBalanceOrders(deployment, setupData)
  const registration = params.sellToken
    ? registrations.find((r) => r.data.sellToken.toLowerCase() === params.sellToken!.toLowerCase())
    : registrations[0]
  if (!registration) {
    throw new Error('this recipe registers no SellBalanceHandler order to post')
  }
  const { data } = registration

  if (balance <= 0n) throw new Error('nothing to sell: the drop holds none of the sell token')
  const buyAmount = (balance * data.limitPrice.numerator) / data.limitPrice.denominator
  if (buyAmount === 0n) throw new Error('the limit price rounds this balance down to a zero minimum')

  return assembleHookOrder({ ...params, registration: registration.params, terms: { ...data, buyAmount } })
}

/** `PaymentHandler.Data`: what a recipe commits an any-token payment to. */
export interface HookPaymentData {
  buyToken: Address
  /** The price: the least the receiver gets, whatever is sold. */
  buyAmount: bigint
  receiver: Address
  validitySeconds: bigint
  appData: Hex
  appDataTemplate: AppDataTemplate
}

const HOOK_PAYMENT_DATA_PARAMS = [
  {
    type: 'tuple',
    components: [
      { name: 'buyToken', type: 'address' },
      { name: 'buyAmount', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'validitySeconds', type: 'uint256' },
      { name: 'appData', type: 'bytes32' },
      { name: 'appDataPrefix', type: 'bytes' },
      { name: 'appDataSuffix', type: 'bytes' },
    ],
  },
] as const

/** `abi.encode(PaymentHandler.Data)`, the handler's `staticInput`. */
export function encodeHookPaymentData(data: HookPaymentData): Hex {
  return encodeAbiParameters(HOOK_PAYMENT_DATA_PARAMS, [
    {
      buyToken: data.buyToken,
      buyAmount: data.buyAmount,
      receiver: data.receiver,
      validitySeconds: data.validitySeconds,
      appData: data.appData,
      appDataPrefix: stringToHex(data.appDataTemplate.prefix),
      appDataSuffix: stringToHex(data.appDataTemplate.suffix),
    },
  ])
}

export function decodeHookPaymentData(staticInput: Hex): HookPaymentData {
  const [raw] = decodeAbiParameters(HOOK_PAYMENT_DATA_PARAMS, staticInput)
  return {
    buyToken: raw.buyToken,
    buyAmount: raw.buyAmount,
    receiver: raw.receiver,
    validitySeconds: raw.validitySeconds,
    appData: raw.appData,
    appDataTemplate: { prefix: hexToString(raw.appDataPrefix), suffix: hexToString(raw.appDataSuffix) },
  }
}

/** A `PaymentHandler` registration found in a recipe. */
export interface HookPaymentRegistration {
  params: SellBalanceRegistration['params']
  data: HookPaymentData
}

/** The any-token payment a recipe registers, read back out of its committed bytes. */
export function findHookPayment(
  deployment: Pick<DropDeployment, 'composableCow' | 'paymentHandler'>,
  setupData: Hex,
): HookPaymentRegistration | undefined {
  const params = registrationsOf(deployment.composableCow, deployment.paymentHandler, setupData)[0]
  return params && { params, data: decodeHookPaymentData(params.staticInput) }
}

/**
 * The order to post for a payment drop that was paid in `sellToken`.
 *
 * The recipe names no sell token, so the caller does: the drop's whole balance of it, for at least
 * the committed `buyAmount`. Its pre-hook names the same token, which is what makes the drop approve
 * it. A payment made in `buyToken` itself has no order: activate with that token instead.
 */
export function buildHookPaymentOrder(params: {
  deployment: DropDeployment
  owner: Address
  setupData: Hex
  sellToken: Address
  balance: bigint
  now: number
  clockSkewSeconds?: number
}): HookOrder {
  const registration = findHookPayment(params.deployment, params.setupData)
  if (!registration) throw new Error('this recipe registers no PaymentHandler order to post')
  const { data } = registration

  if (params.balance <= 0n) throw new Error('nothing to sell: the drop holds none of the sell token')
  if (params.sellToken.toLowerCase() === data.buyToken.toLowerCase()) {
    throw new Error('a payment already in the buy token needs no order; activate with that token to forward it')
  }

  return assembleHookOrder({
    ...params,
    registration: registration.params,
    terms: { ...data, sellToken: params.sellToken },
    hookSellToken: params.sellToken,
  })
}

/** Everything after the terms are settled: deadline, appData, signature, uid, payload. */
function assembleHookOrder(params: {
  deployment: DropDeployment
  owner: Address
  setupData: Hex
  balance: bigint
  now: number
  clockSkewSeconds?: number
  registration: SellBalanceRegistration['params']
  terms: {
    sellToken: Address
    buyToken: Address
    receiver: Address
    buyAmount: bigint
    validitySeconds: bigint
    appData: Hex
    appDataTemplate: AppDataTemplate
  }
  /** Set when the hook must name the token being sold. */
  hookSellToken?: Address
}): HookOrder {
  const { deployment, owner, setupData, balance, terms } = params

  const validity = Number(terms.validitySeconds)
  const skew = Math.min(params.clockSkewSeconds ?? 60, Math.floor(validity / 2))
  const validTo = params.now + validity - skew
  if (!Number.isInteger(validTo) || validTo > 0xffffffff) throw new Error(`validTo out of range: ${validTo}`)

  const templated = terms.appDataTemplate.prefix.length > 0
  const appDataDocument = templated
    ? hookAppDataDocument(terms.appDataTemplate, { deployment, owner, setupData, sellToken: params.hookSellToken })
    : knownAppDataDocument(terms.appData)
  const appData = templated ? keccak256(toBytes(appDataDocument!)) : terms.appData

  const order: CowOrderData = {
    sellToken: terms.sellToken,
    buyToken: terms.buyToken,
    receiver: terms.receiver,
    sellAmount: balance,
    buyAmount: terms.buyAmount,
    validTo,
    appData,
    feeAmount: 0n,
    kind: KIND_SELL,
    partiallyFillable: false,
    sellTokenBalance: BALANCE_ERC20,
    buyTokenBalance: BALANCE_ERC20, // gitleaks:allow (balance-kind constant, not a secret)
  }

  const drop = deriveDropAddress({ deployment, owner, setupData })
  const signature = encodeHookSignature(order, params.registration, templated ? { owner, setupData } : undefined)
  const orderUid = orderUidFor(order, drop, cowDomainSeparator(deployment.chainId, deployment.settlement))

  return {
    drop,
    order,
    orderUid,
    signature,
    appDataDocument,
    payload: toHookOrderPayload(order, drop, signature),
  }
}

/**
 * The ERC-1271 signature for a `SellBalanceHandler` order.
 *
 * @param recipe The recipe the handler rebuilds the appData from. Omit for a fixed appData.
 */
export function encodeHookSignature(
  order: CowOrderData,
  params: SellBalanceRegistration['params'],
  recipe?: { owner: Address; setupData: Hex },
): Hex {
  const offchainInput = recipe
    ? encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [recipe.owner, recipe.setupData])
    : '0x'
  return encodeAbiParameters(SIGNATURE_PARAMS, [order, { proof: [], params, offchainInput }])
}

function toHookOrderPayload(order: CowOrderData, drop: Address, signature: Hex) {
  return {
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    receiver: order.receiver,
    sellAmount: order.sellAmount.toString(),
    buyAmount: order.buyAmount.toString(),
    validTo: order.validTo,
    appData: order.appData,
    feeAmount: '0',
    kind: 'sell' as const,
    partiallyFillable: false,
    sellTokenBalance: 'erc20' as const,
    buyTokenBalance: 'erc20' as const,
    signingScheme: 'eip1271' as const,
    signature,
    from: drop,
  }
}
