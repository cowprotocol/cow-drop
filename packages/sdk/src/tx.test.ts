import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'

import { COW_ORDER_ABI } from './generated/artifacts.js'
import {
  COW_ORDER_PLACED_TOPIC,
  ownerOfOrderUid,
  parseCowOrderPlaced,
  toOrderBookPayload,
  type PlacedOrder,
} from './tx.js'

const DROP = '0x1111111111111111111111111111111111111111'
const SELL_TOKEN = '0x2222222222222222222222222222222222222222'
const BUY_TOKEN = '0x3333333333333333333333333333333333333333'
const RECEIVER = '0x4444444444444444444444444444444444444444'
const DIGEST = `0x${'ab'.repeat(32)}`
const KIND_SELL = '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775'
const BALANCE_ERC20 = '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9'

const VALID_TO = 1_800_003_600
const UID: Hex = `0x${DIGEST.slice(2)}${DROP.slice(2)}${VALID_TO.toString(16).padStart(8, '0')}`

const ORDER = {
  sellToken: SELL_TOKEN,
  buyToken: BUY_TOKEN,
  receiver: RECEIVER,
  sellAmount: 1234n * 10n ** 18n,
  buyAmount: 1172n * 10n ** 18n,
  validTo: VALID_TO,
  appData: `0x${'00'.repeat(32)}`,
  feeAmount: 0n,
  kind: KIND_SELL,
  partiallyFillable: false,
  sellTokenBalance: BALANCE_ERC20,
  buyTokenBalance: BALANCE_ERC20,
} as const

const EVENT = COW_ORDER_ABI[0]!

/**
 * A `CowOrderPlaced` log, encoded the way the contract encodes it. Built from the generated ABI
 * rather than hand-written bytes, so a change to the event shows up here as a failing decode rather
 * than as a fixture that quietly stopped describing reality.
 */
function log(signingScheme: number, signature: Hex) {
  return {
    topics: encodeEventTopics({ abi: COW_ORDER_ABI, eventName: 'CowOrderPlaced' }) as [Hex],
    data: encodeAbiParameters(EVENT.inputs, [UID, signingScheme, signature, ORDER] as never),
  }
}

describe('parseCowOrderPlaced', () => {
  it('decodes a pre-signed order and reads the owner back out of the uid', () => {
    const order = parseCowOrderPlaced(log(3, DROP))

    expect(order.orderUid).toBe(UID)
    expect(order.owner).toBe(DROP)
    expect(order.signingScheme).toBe('presign')
    expect(order.signature).toBe(DROP)
    expect(order.sellAmount).toBe(ORDER.sellAmount)
    expect(order.validTo).toBe(VALID_TO)
  })

  it('names an eip-1271 order without needing to know which step placed it', () => {
    expect(parseCowOrderPlaced(log(2, '0xdeadbeef')).signingScheme).toBe('eip1271')
  })

  it('refuses a signing scheme it has no name for rather than guessing one', () => {
    // The contracts being newer than the SDK. Posting under a guessed scheme would be worse.
    expect(() => parseCowOrderPlaced(log(7, '0x'))).toThrow()
  })

  it('rejects a log that is not a CowOrderPlaced', () => {
    expect(() => parseCowOrderPlaced({ topics: [`0x${'11'.repeat(32)}`], data: '0x' })).toThrow()
  })
})

describe('COW_ORDER_PLACED_TOPIC', () => {
  it('is the topic0 an indexer filters on, with no address filter', () => {
    expect(COW_ORDER_PLACED_TOPIC).toBe(encodeEventTopics({ abi: COW_ORDER_ABI, eventName: 'CowOrderPlaced' })[0])
  })
})

describe('ownerOfOrderUid', () => {
  it('reads the owner from the middle 20 bytes', () => {
    expect(ownerOfOrderUid(UID)).toBe(DROP)
  })

  it('refuses a uid that is not 56 bytes', () => {
    expect(() => ownerOfOrderUid('0xdeadbeef')).toThrow(/56 bytes/)
  })
})

describe('toOrderBookPayload', () => {
  it('forwards the scheme and signature from the event rather than assuming pre-sign', () => {
    const payload = toOrderBookPayload(parseCowOrderPlaced(log(3, DROP)))

    expect(payload.signingScheme).toBe('presign')
    expect(payload.signature).toBe(DROP)
    expect(payload.from).toBe(DROP)
    expect(payload.kind).toBe('sell')
    expect(payload.sellTokenBalance).toBe('erc20')
    // Amounts are strings for the API, and must not go through a float on the way.
    expect(payload.sellAmount).toBe('1234000000000000000000')
  })

  it('defaults the owner to the one in the uid', () => {
    const order: PlacedOrder = parseCowOrderPlaced(log(3, DROP))
    expect(toOrderBookPayload(order).from).toBe(order.owner)
  })
})
