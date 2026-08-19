import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  size,
  slice,
  toEventSelector,
  type Address,
  type Hex,
  type Log,
} from 'viem'

import { DROP_EXECUTOR_ABI, ONCHAIN_ORDERS_ABI } from './generated/artifacts.js'
import { cowDomainSeparator, orderUidFor, type CowOrderData } from './orderUid.js'
import type { DropDeployment } from './types.js'

export interface EvmCall {
  to: Address
  data: Hex
  value: bigint
}

/**
 * The transaction that deploys a drop and runs its recipe — or re-runs it, if the drop already
 * exists. Anyone can send it; there is no signature to collect and no privileged sender, so a
 * keeper, a solver pre-interaction or the user's own wallet are interchangeable here.
 */
export function buildActivateTx(params: {
  deployment: Pick<DropDeployment, 'executor'>
  owner: Address
  setupData: Hex
}): EvmCall {
  return {
    to: params.deployment.executor,
    data: encodeFunctionData({
      abi: DROP_EXECUTOR_ABI,
      functionName: 'activate',
      args: [params.owner, params.setupData],
    }),
    value: 0n,
  }
}

/**
 * The signing schemes an order placed on-chain can use, by their `OnchainSigningScheme` numbers.
 *
 * Two, not `GPv2Signing.Scheme`'s four: a contract cannot produce an ECDSA signature, so the two
 * ECDSA schemes are unreachable from on-chain order placement and are not in this numbering. The names
 * are the strings the order book takes, so they go out to the API unchanged.
 */
export const COW_SIGNING_SCHEMES = ['eip1271', 'presign'] as const
export type CowSigningScheme = (typeof COW_SIGNING_SCHEMES)[number]

/** A discrete order as announced by `OrderPlacement`, with its owner and uid resolved. */
export interface PlacedOrder extends CowOrderData {
  /**
   * `orderDigest ++ owner ++ validTo`.
   *
   * Not in the log — computed here from the order struct, the owner and the domain separator, which is
   * exactly what the settlement contract keys the signature by. See `packages/sdk/src/orderUid.ts`.
   */
  orderUid: Hex
  /**
   * The order's owner: the address that signed, and the one the order book will attribute the order
   * to.
   *
   * Read from `sender` for `presign` and from `signature` for `eip1271` — the two places the scheme
   * puts it. **Not** the log's emitter, which may be a helper announcing on the owner's behalf.
   */
  owner: Address
  /**
   * Who triggered the placement — `OrderPlacement`'s indexed `sender`.
   *
   * The owner for a `presign` order, and not necessarily related to the order at all otherwise.
   */
  sender: Address
  /** How the order book should check the order. */
  signingScheme: CowSigningScheme
  /** Forwarded to the order book verbatim. Under both schemes this is the owner's address. */
  signature: Hex
  /**
   * `OrderPlacement`'s `data`, unparsed.
   *
   * Twelve bytes of `int64 quoteId ++ uint32 validTo` by convention — see `parseExtraData` — but the
   * event enforces nothing, so an emitter that put something else there is not an error here.
   */
  extraData: Hex
}

/**
 * `OrderPlacement` on its own, for `getLogs`.
 *
 * CoW's own event, not cow-drop's — see `contracts/src/interfaces/ICoWSwapOnchainOrders.sol` for why
 * that matters. An indexer filters on this topic0 with **no address filter**, because drop addresses
 * are counterfactual and nobody knows them in advance, and so picks up orders from contracts that did
 * not exist when it was written. See `packages/watch-tower`.
 */
export const ORDER_PLACEMENT_EVENT = ONCHAIN_ORDERS_ABI.find(
  (item): item is Extract<(typeof ONCHAIN_ORDERS_ABI)[number], { type: 'event' }> =>
    item.type === 'event' && item.name === 'OrderPlacement',
)!

/** `topic0` of `OrderPlacement` — the only filter an indexer needs. */
export const ORDER_PLACEMENT_TOPIC: Hex = toEventSelector(ORDER_PLACEMENT_EVENT)

/** `topic0` of `OrderInvalidation`. */
export const ORDER_INVALIDATION_TOPIC: Hex = toEventSelector(
  ONCHAIN_ORDERS_ABI.find(
    (item): item is Extract<(typeof ONCHAIN_ORDERS_ABI)[number], { type: 'event' }> =>
      item.type === 'event' && item.name === 'OrderInvalidation',
  )!,
)

/** Where the chain and settlement address that resolve a uid come from. */
export interface OrderPlacementContext {
  chainId: number
  settlement: Address
}

/**
 * Decode an `OrderPlacement` log into the order that was placed.
 *
 * Decoded against `ONCHAIN_ORDERS_ABI` rather than any emitter's ABI, deliberately: the event belongs
 * to the protocol, so a decoder does not have to know which contract emitted it — EthFlow's logs decode
 * here as readily as a drop's. Throws if the log is not an `OrderPlacement`.
 *
 * A drop's own orders are emitted from inside a delegatecall, so their emitter is the drop rather than
 * the step contract, and `sender` is the drop too.
 *
 * @param context The chain and settlement address, used only to derive the domain separator the uid is
 *                computed against. Pass `domainSeparator` instead if you already hold one.
 */
export function parseOrderPlacement(
  log: Pick<Log, 'data' | 'topics'>,
  context: OrderPlacementContext | { domainSeparator: Hex },
): PlacedOrder {
  const decoded = decodeEventLog({
    abi: ONCHAIN_ORDERS_ABI,
    eventName: 'OrderPlacement',
    data: log.data,
    topics: log.topics,
  })

  const { sender, order, signature, data } = decoded.args as unknown as {
    sender: Address
    order: CowOrderData
    signature: { scheme: number; data: Hex }
    data: Hex
  }

  const scheme = COW_SIGNING_SCHEMES[signature.scheme]
  if (!scheme) {
    // The enum has two values and the parser upstream treats anything else as an unreachable state.
    // Guessing a name for a third would post an order under a scheme nobody agreed on.
    throw new Error(`unknown on-chain signing scheme ${signature.scheme} in OrderPlacement`)
  }

  // Under `presign` the settlement contract recorded the signature against `msg.sender`, which the
  // emitter reports here. Under `eip1271` the signature names the contract the order book must call.
  // Either way the owner is 20 bytes, and reading it from the wrong place would produce a uid the
  // settlement contract has never heard of.
  const owner =
    scheme === 'presign'
      ? getAddress(sender)
      : (() => {
          if (size(signature.data) < 20) {
            throw new Error(`an eip1271 signature must begin with the 20-byte signer, got ${signature.data}`)
          }
          return getAddress(slice(signature.data, 0, 20))
        })()

  const domainSeparator =
    'domainSeparator' in context ? context.domainSeparator : cowDomainSeparator(context.chainId, context.settlement)

  return {
    ...order,
    orderUid: orderUidFor(order, owner, domainSeparator),
    owner,
    sender: getAddress(sender),
    signingScheme: scheme,
    signature: signature.data,
    extraData: data,
  }
}

/** `OrderPlacement`'s `data`, as every producer so far encodes it. */
export interface OrderPlacementExtraData {
  /** A CoW API quote id, or `0` for "none" — see `CowOrder.NO_QUOTE`. */
  quoteId: bigint
  /**
   * The deadline the emitter wants honoured, which need not be the order's own `validTo`.
   *
   * EthFlow commits `validTo = uint32.max` on-chain and puts the real deadline here, because its orders
   * are gated by ERC-1271 and it enforces expiry itself. A pre-signed order cannot do that — nothing
   * gates it but the settlement contract's `validTo` — so for a drop the two agree.
   */
  validTo: number
}

/**
 * Parse the twelve bytes of `int64 quoteId ++ uint32 validTo` from `extraData`.
 *
 * Returns `undefined` rather than throwing when the field is some other length: the event enforces no
 * encoding, so a log that carries something else is a log this convention does not apply to, not a
 * malformed one.
 */
export function parseExtraData(extraData: Hex): OrderPlacementExtraData | undefined {
  if (size(extraData) !== 12) return undefined

  const [quoteId, validTo] = decodeAbiParametersPacked(extraData)
  return { quoteId, validTo }
}

/** `int64 ++ uint32`, big-endian and two's complement, which no ABI decoder does for packed bytes. */
function decodeAbiParametersPacked(extraData: Hex): [bigint, number] {
  const unsigned = BigInt(slice(extraData, 0, 8))
  const quoteId = unsigned >= 1n << 63n ? unsigned - (1n << 64n) : unsigned
  return [quoteId, Number(BigInt(slice(extraData, 8, 12)))]
}

const KIND_SELL = '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775'
const BALANCE_ERC20 = '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9'

/**
 * Turn a placed order into the body for `POST /api/v1/orders`.
 *
 * `signingScheme` and `signature` are forwarded from the event rather than assumed, which is what
 * keeps a poster from having to know how the order was signed: for `presign` the order book checks
 * the on-chain pre-signature and expects the owner in the signature field, which is exactly what the
 * announcement carries.
 *
 * `appData` goes out as the hash, because the hash is all the order struct holds. The order book
 * accepts that form for a document it already knows; a poster holding the document itself should
 * upload it first — see `packages/watch-tower`.
 *
 * @param drop Overrides the owner. Defaults to the order's own owner, which for a drop is the drop.
 */
export function toOrderBookPayload(order: PlacedOrder, drop: Address = order.owner) {
  return {
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    receiver: order.receiver,
    sellAmount: order.sellAmount.toString(),
    buyAmount: order.buyAmount.toString(),
    validTo: order.validTo,
    appData: order.appData,
    feeAmount: order.feeAmount.toString(),
    kind: order.kind === KIND_SELL ? 'sell' : 'buy',
    partiallyFillable: order.partiallyFillable,
    sellTokenBalance: order.sellTokenBalance === BALANCE_ERC20 ? 'erc20' : 'external',
    buyTokenBalance: order.buyTokenBalance === BALANCE_ERC20 ? 'erc20' : 'internal',
    signingScheme: order.signingScheme,
    signature: order.signature,
    from: drop,
  }
}

/**
 * ComposableCoW's registration event, hand-written for the same reason as the revoke ABI: composable-cow
 * is not a submodule here, so there is no artifact to generate from.
 */
const CONDITIONAL_ORDER_CREATED_ABI = [
  {
    type: 'event',
    name: 'ConditionalOrderCreated',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      {
        name: 'params',
        type: 'tuple',
        indexed: false,
        components: [
          { name: 'handler', type: 'address' },
          { name: 'salt', type: 'bytes32' },
          { name: 'staticInput', type: 'bytes' },
        ],
      },
    ],
  },
] as const

/**
 * `keccak256(abi.encode(params))`, the key ComposableCoW stores an authorisation under and the argument
 * `remove` takes.
 *
 * Mirrors `ComposableCoW.hash`. Two implementations of one formula drift silently and the failure mode
 * here is a rescue that appears to retire an order and does not, so it is checked against fixtures
 * generated by the compiled contract — see `derivation.test.ts`.
 */
export function conditionalOrderParamsHash(params: {
  handler: Address
  salt: Hex
  staticInput: Hex
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'handler', type: 'address' },
            { name: 'salt', type: 'bytes32' },
            { name: 'staticInput', type: 'bytes' },
          ],
        },
      ],
      [params],
    ),
  )
}

/** One conditional order a drop registered, and the hash ComposableCoW keys it by. */
export interface RegisteredConditionalOrder {
  owner: Address
  handler: Address
  salt: Hex
  staticInput: Hex
  /** `keccak256(abi.encode(params))` — what `remove` takes, and what a rescue needs. */
  paramsHash: Hex
}

/**
 * Every conditional order an activation registered, from its receipt.
 *
 * This is what makes a complete rescue possible. The params hash cannot be computed before activation,
 * because it covers the amount that arrived — so the receipt is where it first exists. Keep it with the
 * recipe file: retiring the order later needs it, and nothing on-chain will hand it back in a form the
 * SDK can use.
 */
export function parseConditionalOrdersCreated(
  logs: readonly Pick<Log, 'data' | 'topics' | 'address'>[],
  composableCow: Address,
): RegisteredConditionalOrder[] {
  const found: RegisteredConditionalOrder[] = []

  for (const log of logs) {
    if (log.address?.toLowerCase() !== composableCow.toLowerCase()) continue

    let decoded
    try {
      decoded = decodeEventLog({
        abi: CONDITIONAL_ORDER_CREATED_ABI,
        eventName: 'ConditionalOrderCreated',
        data: log.data,
        topics: log.topics,
      })
    } catch {
      // Some other ComposableCoW event in the same transaction.
      continue
    }

    const { owner, params } = decoded.args as unknown as {
      owner: Address
      params: { handler: Address; salt: Hex; staticInput: Hex }
    }

    found.push({
      owner,
      handler: params.handler,
      salt: params.salt,
      staticInput: params.staticInput,
      paramsHash: conditionalOrderParamsHash(params),
    })
  }

  return found
}
