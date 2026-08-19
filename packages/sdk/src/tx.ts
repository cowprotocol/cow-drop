import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  toEventSelector,
  type Address,
  type Hex,
  type Log,
} from 'viem'

import { DROP_EXECUTOR_ABI, COW_ORDER_ABI } from './generated/artifacts.js'
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
 * The signing schemes a drop can produce, by their `GPv2Signing.Scheme` numbers — which is what
 * `CowOrderPlaced` carries.
 *
 * A drop is a contract, so it cannot produce an ECDSA signature and the first two are unreachable.
 * They are listed anyway because the numbering has to stay the protocol's, not ours.
 */
export const COW_SIGNING_SCHEMES = ['eip712', 'ethsign', 'eip1271', 'presign'] as const
export type CowSigningScheme = (typeof COW_SIGNING_SCHEMES)[number]

/** A discrete order as emitted by `CowOrderPlaced`, plus the owner read back out of its uid. */
export interface PlacedOrder {
  orderUid: Hex
  /**
   * The order's owner, decoded from the middle 20 bytes of `orderUid`.
   *
   * An indexer should check this against the log's emitter. They agree for any order a step actually
   * placed — the step runs as a delegatecall, so the drop is both — and disagreeing means the log came
   * from something that is not a drop placing its own order.
   */
  owner: Address
  /** How the order book should check the order. */
  signingScheme: CowSigningScheme
  /** Forwarded to the order book verbatim. For `presign` this is the owner address. */
  signature: Hex
  sellToken: Address
  buyToken: Address
  receiver: Address
  sellAmount: bigint
  buyAmount: bigint
  validTo: number
  appData: Hex
  feeAmount: bigint
  kind: Hex
  partiallyFillable: boolean
  sellTokenBalance: Hex
  buyTokenBalance: Hex
}

/**
 * `CowOrderPlaced` on its own, for `getLogs`.
 *
 * The one event every step emits for a discrete order, which is what makes an indexer possible: it
 * filters on this topic0 with **no address filter** — drop addresses are counterfactual and nobody
 * knows them in advance — and picks up orders from step contracts that did not exist when it was
 * written. See `packages/watch-tower`.
 */
export const COW_ORDER_PLACED_EVENT = COW_ORDER_ABI.find(
  (item): item is Extract<(typeof COW_ORDER_ABI)[number], { type: 'event' }> =>
    item.type === 'event' && item.name === 'CowOrderPlaced',
)!

/** `topic0` of `CowOrderPlaced` — the only filter an indexer needs. */
export const COW_ORDER_PLACED_TOPIC: Hex = toEventSelector(COW_ORDER_PLACED_EVENT)

/**
 * Decode a `CowOrderPlaced` log into the order that was placed.
 *
 * Decoded against `COW_ORDER_ABI` rather than any step contract's ABI, deliberately: the event is
 * declared once in `CowOrder.sol` precisely so that a decoder does not have to know which contract
 * emitted it. Throws if the log is not a `CowOrderPlaced`.
 *
 * The event is emitted from inside a delegatecall, so its emitter is the drop rather than the step
 * contract — which is what lets a poster filter by drop address.
 */
export function parseCowOrderPlaced(log: Pick<Log, 'data' | 'topics'>): PlacedOrder {
  const decoded = decodeEventLog({
    abi: COW_ORDER_ABI,
    eventName: 'CowOrderPlaced',
    data: log.data,
    topics: log.topics,
  })

  const { orderUid, signingScheme, signature, order } = decoded.args as unknown as {
    orderUid: Hex
    signingScheme: number
    signature: Hex
    order: {
      sellToken: Address
      buyToken: Address
      receiver: Address
      sellAmount: bigint
      buyAmount: bigint
      validTo: number
      appData: Hex
      feeAmount: bigint
      kind: Hex
      partiallyFillable: boolean
      sellTokenBalance: Hex
      buyTokenBalance: Hex
    }
  }

  const scheme = COW_SIGNING_SCHEMES[signingScheme]
  if (!scheme) {
    // A scheme this SDK has no name for means the contracts are newer than the SDK. Posting it under
    // a guessed name would be worse than refusing.
    throw new Error(`unknown signing scheme ${signingScheme} in CowOrderPlaced`)
  }

  return { orderUid, owner: ownerOfOrderUid(orderUid), signingScheme: scheme, signature, ...order }
}

/**
 * The owner encoded in an order UID.
 *
 * A UID is `orderDigest ++ owner ++ validTo` — 32 + 20 + 4 bytes — so the owner sits at a fixed
 * offset and needs no lookup. This is how an indexer cross-checks a log's emitter.
 */
export function ownerOfOrderUid(orderUid: Hex): Address {
  const bytes = orderUid.slice(2)
  if (bytes.length !== 112) throw new Error(`order uid must be 56 bytes, got ${bytes.length / 2}`)
  return getAddress(`0x${bytes.slice(64, 104)}`)
}

const KIND_SELL = '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775'
const BALANCE_ERC20 = '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9'

/**
 * Turn a placed order into the body for `POST /api/v1/orders`.
 *
 * `signingScheme` and `signature` are forwarded from the event rather than assumed, which is what
 * keeps a poster from having to know how the order was signed: for `presign` the order book checks
 * the on-chain pre-signature and expects the owner in the signature field, which is exactly what the
 * contract emits.
 *
 * `appData` goes out as the hash, because the hash is all the order struct holds. The order book
 * accepts that form for a document it already knows; a poster holding the document itself should
 * upload it first — see `packages/watch-tower`.
 *
 * @param drop Overrides the owner. Defaults to the one encoded in the order uid, which is the drop.
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
