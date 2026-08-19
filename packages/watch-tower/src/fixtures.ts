import { ONCHAIN_ORDERS_ABI, ORDER_PLACEMENT_EVENT } from '@cowprotocol/cow-drop-sdk'
import { encodeAbiParameters, encodeEventTopics, pad, type Address, type Hex } from 'viem'

import { DROP_TRIGGERED_TOPIC, type RawLog } from './chain.js'

/**
 * Log builders for the tests.
 *
 * Encoded from the generated ABI rather than written out as bytes, so a change to `OrderPlacement`
 * surfaces as a failing decode here rather than as a fixture that quietly stopped matching reality.
 * Not shipped — `tsconfig.build.json` excludes it.
 */
export const KIND_SELL: Hex = '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775'
export const BALANCE_ERC20: Hex = '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9'

export const ZERO_APP_DATA: Hex = `0x${'00'.repeat(32)}`

export interface OrderLogOptions {
  /** The log's emitter. */
  drop: Address
  /**
   * The order's owner, which the event carries in `sender` for a pre-signed order. Defaults to
   * `drop`; differs when a poster announced somebody else's order.
   */
  owner?: Address
  transactionHash?: Hex
  blockNumber?: bigint
  logIndex?: number
  /** `OnchainSigningScheme`: 0 is `Eip1271`, 1 is `PreSign`. */
  signingScheme?: number
  appData?: Hex
  sellAmount?: bigint
}

/** A `CowOrderPlaced` log, with whatever fields a test cares about and defaults for the rest. */
export function orderPlacementLog(options: OrderLogOptions): RawLog {
  const {
    drop,
    owner = drop,
    transactionHash = `0x${'aa'.repeat(32)}`,
    blockNumber = 100n,
    logIndex = 0,
    signingScheme = 1,
    appData = ZERO_APP_DATA,
    sellAmount = 1000n * 10n ** 18n,
  } = options

  const validTo = 1_800_003_600

  const order = {
    sellToken: '0x2222222222222222222222222222222222222222',
    buyToken: '0x3333333333333333333333333333333333333333',
    receiver: '0x4444444444444444444444444444444444444444',
    sellAmount,
    buyAmount: (sellAmount * 95n) / 100n,
    validTo,
    appData,
    feeAmount: 0n,
    kind: KIND_SELL,
    partiallyFillable: false,
    sellTokenBalance: BALANCE_ERC20,
    buyTokenBalance: BALANCE_ERC20,
  }

  return {
    address: drop,
    topics: encodeEventTopics({
      abi: ONCHAIN_ORDERS_ABI,
      eventName: 'OrderPlacement',
      args: { sender: owner },
    }) as [Hex, Hex],
    // `sender` is indexed, so only the last three parameters are in the data.
    data: encodeAbiParameters(ORDER_PLACEMENT_EVENT.inputs.slice(1), [
      order,
      { scheme: signingScheme, data: owner },
      extraData(0n, validTo),
    ] as never),
    blockNumber,
    transactionHash,
    logIndex,
  }
}

/** Twelve bytes of `int64 quoteId ++ uint32 validTo`, as `CowOrder.extraData` packs it. */
export function extraData(quoteId: bigint, validTo: number): Hex {
  const unsigned = quoteId < 0n ? quoteId + (1n << 64n) : quoteId
  return `0x${unsigned.toString(16).padStart(16, '0')}${validTo.toString(16).padStart(8, '0')}`
}

/** The activation announcement `DropExecutor` emits alongside a real order. */
export function dropTriggeredLog(options: {
  executor: Address
  drop: Address
  transactionHash?: Hex
  blockNumber?: bigint
}): RawLog {
  return {
    address: options.executor,
    topics: [DROP_TRIGGERED_TOPIC, pad(options.drop), pad('0x00'), pad('0x00')],
    data: '0x',
    blockNumber: options.blockNumber ?? 100n,
    transactionHash: options.transactionHash ?? `0x${'aa'.repeat(32)}`,
    logIndex: 1,
  }
}
