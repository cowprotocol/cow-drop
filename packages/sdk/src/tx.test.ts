import { encodeAbiParameters, encodeEventTopics, pad, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'

import { ONCHAIN_ORDERS_ABI } from './generated/artifacts.js'
import { cowDomainSeparator, orderUidFor, ownerOfOrderUid } from './orderUid.js'
import {
  ORDER_PLACEMENT_EVENT,
  ORDER_PLACEMENT_TOPIC,
  parseExtraData,
  parseOrderPlacement,
  toOrderBookPayload,
  type PlacedOrder,
} from './tx.js'

const DROP = '0x1111111111111111111111111111111111111111'
const SELL_TOKEN = '0x2222222222222222222222222222222222222222'
const BUY_TOKEN = '0x3333333333333333333333333333333333333333'
const RECEIVER = '0x4444444444444444444444444444444444444444'
const POSTER = '0x5555555555555555555555555555555555555555'
const KIND_SELL = '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775'
const BALANCE_ERC20 = '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9'

const CHAIN_ID = 100
const SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
const CONTEXT = { chainId: CHAIN_ID, settlement: SETTLEMENT } as const

const VALID_TO = 1_800_003_600

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

/** The uid the settlement contract would key this order by, for a given owner. */
function uidOf(owner: Hex): Hex {
  return orderUidFor(ORDER, owner, cowDomainSeparator(CHAIN_ID, SETTLEMENT))
}

/** Twelve bytes of `int64 quoteId ++ uint32 validTo`, as the contracts emit it. */
function extraData(quoteId: bigint, validTo: number): Hex {
  const unsigned = quoteId < 0n ? quoteId + (1n << 64n) : quoteId
  return `0x${unsigned.toString(16).padStart(16, '0')}${validTo.toString(16).padStart(8, '0')}`
}

/**
 * An `OrderPlacement` log, encoded the way the contracts encode it. Built from the generated ABI
 * rather than hand-written bytes, so a change to the event shows up here as a failing decode rather
 * than as a fixture that quietly stopped describing reality.
 */
function log(sender: Hex, scheme: number, signature: Hex, data: Hex = extraData(0n, VALID_TO)) {
  return {
    topics: encodeEventTopics({
      abi: ONCHAIN_ORDERS_ABI,
      eventName: 'OrderPlacement',
      args: { sender },
    }) as [Hex, Hex],
    data: encodeAbiParameters(ORDER_PLACEMENT_EVENT.inputs.slice(1), [ORDER, { scheme, data: signature }, data] as never),
  }
}

describe('parseOrderPlacement', () => {
  it('decodes a pre-signed order and takes the owner from sender', () => {
    const order = parseOrderPlacement(log(DROP, 1, DROP), CONTEXT)

    // The uid is not in the log. Recomputing it is the whole reason this function needs a chain.
    expect(order.orderUid).toBe(uidOf(DROP))
    expect(order.owner).toBe(DROP)
    expect(order.sender).toBe(DROP)
    expect(order.signingScheme).toBe('presign')
    expect(order.signature).toBe(DROP)
    expect(order.sellAmount).toBe(ORDER.sellAmount)
    expect(order.validTo).toBe(VALID_TO)
  })

  it('takes the owner from the signature for an eip-1271 order, not from sender', () => {
    // The distinction that matters: under 1271 the sender may be anyone, and the signature names the
    // contract the order book must call. Reading the owner from the wrong field yields a uid the
    // settlement contract has never heard of, and an order that looks unsigned.
    const order = parseOrderPlacement(log(POSTER, 0, DROP), CONTEXT)

    expect(order.owner).toBe(DROP)
    expect(order.sender).toBe(POSTER)
    expect(order.signingScheme).toBe('eip1271')
    expect(order.orderUid).toBe(uidOf(DROP))
  })

  it('keeps the owner and the emitter separate when a helper announced the order', () => {
    // `CowOrderPoster.announce` emits from itself an order owned by its caller, which is what
    // `sender` is for. An indexer that assumed owner == emitter would reject every one of those.
    const order = parseOrderPlacement(log(DROP, 1, DROP), CONTEXT)

    expect(order.owner).toBe(DROP)
    expect(order.orderUid).toBe(uidOf(DROP))
  })

  it('accepts a domain separator directly, so a poster need not know the chain', () => {
    const domainSeparator = cowDomainSeparator(CHAIN_ID, SETTLEMENT)

    expect(parseOrderPlacement(log(DROP, 1, DROP), { domainSeparator }).orderUid).toBe(
      parseOrderPlacement(log(DROP, 1, DROP), CONTEXT).orderUid,
    )
  })

  it('refuses a signing scheme it has no name for rather than guessing one', () => {
    // `GPv2Signing.Scheme.PreSign` is 3; the on-chain enum numbers PreSign 1. An emitter that used
    // the wrong numbering must not be silently read as something else.
    expect(() => parseOrderPlacement(log(DROP, 3, DROP), CONTEXT)).toThrow(/signing scheme/)
  })

  it('refuses an eip-1271 signature too short to hold a signer', () => {
    expect(() => parseOrderPlacement(log(DROP, 0, '0xdeadbeef'), CONTEXT)).toThrow(/20-byte signer/)
  })

  it('rejects a log that is not an OrderPlacement', () => {
    expect(() => parseOrderPlacement({ topics: [`0x${'11'.repeat(32)}`], data: '0x' }, CONTEXT)).toThrow()
  })
})

describe('ORDER_PLACEMENT_TOPIC', () => {
  it('is the topic0 an indexer filters on, with no address filter', () => {
    expect(ORDER_PLACEMENT_TOPIC).toBe(
      encodeEventTopics({ abi: ONCHAIN_ORDERS_ABI, eventName: 'OrderPlacement' })[0],
    )
  })

  it('is the topic EthFlow has emitted since it shipped', () => {
    // Hard-coded rather than derived: this is the fact that makes cow-drop's announcements readable by
    // anything already indexing CoW's on-chain orders. `contracts/test/OnchainOrders.t.sol` asserts the
    // same constant on the Solidity side.
    expect(ORDER_PLACEMENT_TOPIC).toBe('0xcf5f9de2984132265203b5c335b25727702ca77262ff622e136baa7362bf1da9')
  })
})

describe('parseExtraData', () => {
  it('reads the quote id and deadline the contracts pack', () => {
    expect(parseExtraData(extraData(4242n, VALID_TO))).toEqual({ quoteId: 4242n, validTo: VALID_TO })
  })

  it('reads a negative quote id as two-s complement', () => {
    expect(parseExtraData(extraData(-1n, 1))).toEqual({ quoteId: -1n, validTo: 1 })
  })

  it('reads a drop-s no-quote marker as zero', () => {
    expect(parseExtraData(extraData(0n, VALID_TO))?.quoteId).toBe(0n)
  })

  it('returns undefined for a field of any other length, rather than throwing', () => {
    // The event enforces no encoding, so an emitter that put something else there is a log this
    // convention does not describe — not a malformed one.
    expect(parseExtraData('0x')).toBeUndefined()
    expect(parseExtraData(pad('0x01', { size: 32 }))).toBeUndefined()
  })
})

describe('ownerOfOrderUid', () => {
  it('reads the owner from the middle 20 bytes', () => {
    expect(ownerOfOrderUid(uidOf(DROP))).toBe(DROP)
  })

  it('refuses a uid that is not 56 bytes', () => {
    expect(() => ownerOfOrderUid('0xdeadbeef')).toThrow(/56 bytes/)
  })
})

describe('toOrderBookPayload', () => {
  it('forwards the scheme and signature from the event rather than assuming pre-sign', () => {
    const payload = toOrderBookPayload(parseOrderPlacement(log(DROP, 1, DROP), CONTEXT))

    expect(payload.signingScheme).toBe('presign')
    expect(payload.signature).toBe(DROP)
    expect(payload.from).toBe(DROP)
    expect(payload.kind).toBe('sell')
    expect(payload.sellTokenBalance).toBe('erc20')
    // Amounts are strings for the API, and must not go through a float on the way.
    expect(payload.sellAmount).toBe('1234000000000000000000')
  })

  it('defaults the owner to the order-s own owner', () => {
    const order: PlacedOrder = parseOrderPlacement(log(DROP, 1, DROP), CONTEXT)
    expect(toOrderBookPayload(order).from).toBe(order.owner)
  })
})
