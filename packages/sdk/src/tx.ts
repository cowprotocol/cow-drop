import { decodeEventLog, encodeFunctionData, type Address, type Hex, type Log } from 'viem'

import { DROP_EXECUTOR_ABI, DROP_RECIPES_ABI } from './generated/artifacts.js'
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

/** A CoW order as emitted by `DropOrderPlaced`. */
export interface PlacedOrder {
  orderUid: Hex
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
 * Decode a `DropOrderPlaced` log into the order that was pre-signed.
 *
 * The event is emitted from inside a delegatecall, so its emitter is the drop rather than
 * `DropRecipes` — which is what lets a poster filter by drop address.
 */
export function parseDropOrderPlaced(log: Pick<Log, 'data' | 'topics'>): PlacedOrder {
  const decoded = decodeEventLog({
    abi: DROP_RECIPES_ABI,
    eventName: 'DropOrderPlaced',
    data: log.data,
    topics: log.topics,
  })

  const { orderUid, order } = decoded.args as unknown as {
    orderUid: Hex
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

  return { orderUid, ...order }
}

const KIND_SELL = '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775'
const BALANCE_ERC20 = '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9'

/**
 * Turn a placed order into the body for `POST /api/v1/orders`.
 *
 * `signingScheme: 'presign'` tells the order book to check the on-chain pre-signature instead of
 * verifying bytes, and `from` is the drop — the order's owner and the address that signed it.
 */
export function toOrderBookPayload(order: PlacedOrder, drop: Address) {
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
    signingScheme: 'presign' as const,
    // For a pre-signed order the signature field carries the owner, not a signature.
    signature: drop,
    from: drop,
  }
}
