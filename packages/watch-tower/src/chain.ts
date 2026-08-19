import { ORDER_PLACEMENT_TOPIC, DROP_EXECUTOR_ABI } from '@cowprotocol/cow-drop-sdk'
import { encodeEventTopics, formatLog, numberToHex, type Address, type Hex, type PublicClient } from 'viem'

/** A log, reduced to the fields the scanner reads. */
export interface RawLog {
  address: Address
  /** `[topic0, ...]`, or empty for an anonymous event. Viem's own shape, so a client's logs fit. */
  topics: [] | [Hex, ...Hex[]]
  data: Hex
  blockNumber: bigint
  transactionHash: Hex
  logIndex: number
}

/**
 * The three things the watch tower needs from a chain.
 *
 * Deliberately three functions rather than a `PublicClient`: everything here is about *deciding
 * whether to post an order*, and the decisions are the part worth testing. A fake with three methods
 * lets a test drive a reorg, a spoofed log or an unsigned order without a node — see
 * `scanner.test.ts`. `viemChainReader` is the only place that knows about viem.
 */
export interface ChainReader {
  getBlockNumber(): Promise<bigint>
  getLogs(filter: { address?: Address; topics: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<
    RawLog[]
  >
  /** `GPv2Settlement.preSignature(uid) != 0` — whether the order is actually signed on-chain. */
  isPreSigned(settlement: Address, orderUid: Hex): Promise<boolean>
}

/** `GPv2Settlement.preSignature`, the only settlement function the watch tower calls. */
const SETTLEMENT_ABI = [
  {
    type: 'function',
    name: 'preSignature',
    stateMutability: 'view',
    inputs: [{ name: 'orderUid', type: 'bytes' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

export function viemChainReader(client: PublicClient): ChainReader {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    // `eth_getLogs` directly rather than `client.getLogs`, which takes an `event` and derives the
    // topics itself: it has no `topics` parameter at all, so handing it one sent `topics: []` and the
    // node returned every log in the range for the scanner to reject as undecodable. A bare topic0 and
    // no address filter is the whole point of the scan, so this is the request to make.
    getLogs: async ({ address, topics, fromBlock, toBlock }) => {
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [
          {
            ...(address ? { address } : {}),
            topics: topics as never,
            fromBlock: numberToHex(fromBlock),
            toBlock: numberToHex(toBlock),
          },
        ],
      })
      return logs.map((log) => formatLog(log)) as unknown as RawLog[]
    },
    isPreSigned: async (settlement, orderUid) =>
      (await client.readContract({
        address: settlement,
        abi: SETTLEMENT_ABI,
        functionName: 'preSignature',
        args: [orderUid],
      })) !== 0n,
  }
}

/**
 * `topic0` of CoW's `OrderPlacement`. Re-exported so a caller never has to reach into the SDK for it.
 *
 * The same topic EthFlow emits, deliberately — see `contracts/src/interfaces/ICoWSwapOnchainOrders.sol`.
 * A watch tower scanning for it with no address filter therefore sees EthFlow's orders too; they are
 * already in the order book, so posting one is a `DuplicatedOrder` and harmless, and `onlyDrops`
 * narrows the scan when that noise is unwanted.
 */
export const COW_ORDER_TOPIC = ORDER_PLACEMENT_TOPIC

/**
 * `topic0` of `DropExecutor.DropTriggered`. Only used by the opt-in `onlyDrops` filter, which needs
 * to tell a cow-drop activation from any other contract placing an order.
 */
export const DROP_TRIGGERED_TOPIC: Hex = encodeEventTopics({
  abi: DROP_EXECUTOR_ABI,
  eventName: 'DropTriggered',
})[0] as Hex
