import { COW_ORDER_ABI } from '@cowprotocol/cow-drop-sdk'
import { encodeAbiParameters, encodeEventTopics, pad, type Address, type Hex } from 'viem'

import { DROP_TRIGGERED_TOPIC, type RawLog } from './chain.js'

/**
 * Log builders for the tests.
 *
 * Encoded from the generated ABI rather than written out as bytes, so a change to `CowOrderPlaced`
 * surfaces as a failing decode here rather than as a fixture that quietly stopped matching reality.
 * Not shipped — `tsconfig.build.json` excludes it.
 */
export const KIND_SELL: Hex = '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775'
export const BALANCE_ERC20: Hex = '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9'

const COW_ORDER_EVENT = COW_ORDER_ABI[0]!

export const ZERO_APP_DATA: Hex = `0x${'00'.repeat(32)}`

export function orderUid(digest: Hex, owner: Address, validTo: number): Hex {
  return `0x${digest.slice(2)}${owner.slice(2)}${validTo.toString(16).padStart(8, '0')}` as Hex
}

export interface OrderLogOptions {
  /** The log's emitter. */
  drop: Address
  /** The owner encoded in the uid. Defaults to `drop`; differs when a poster announced it. */
  uidOwner?: Address
  transactionHash?: Hex
  blockNumber?: bigint
  logIndex?: number
  signingScheme?: number
  appData?: Hex
  sellAmount?: bigint
}

export function cowOrderPlacedLog(options: OrderLogOptions): RawLog {
  const {
    drop,
    uidOwner = drop,
    transactionHash = `0x${'aa'.repeat(32)}`,
    blockNumber = 100n,
    logIndex = 0,
    signingScheme = 3,
    appData = ZERO_APP_DATA,
    sellAmount = 1000n * 10n ** 18n,
  } = options

  const validTo = 1_800_003_600
  const uid = orderUid(`0x${'ab'.repeat(32)}`, uidOwner, validTo)

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
    topics: encodeEventTopics({ abi: COW_ORDER_ABI, eventName: 'CowOrderPlaced' }) as [Hex],
    data: encodeAbiParameters(COW_ORDER_EVENT.inputs, [uid, signingScheme, uidOwner, order] as never),
    blockNumber,
    transactionHash,
    logIndex,
  }
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
