import { parseOrderPlacement, type DropDeployment, type PlacedOrder } from '@cowprotocol/cow-drop-sdk'
import { getAddress, type Address, type Hex } from 'viem'

import { COW_ORDER_TOPIC, DROP_TRIGGERED_TOPIC, type ChainReader, type RawLog } from './chain.js'

/** A discrete order found on-chain, and where it was found. */
export interface DiscoveredOrder {
  order: PlacedOrder
  /** Whoever emitted the log. The order's owner when it announced its own order, not otherwise. */
  emitter: Address
  /**
   * The order's owner: the address that signed.
   *
   * Read from `sender` for a pre-signed order and from the signature for an ERC-1271 one — never from
   * the emitter, which may be a helper announcing on the owner's behalf.
   */
  owner: Address
  blockNumber: bigint
  transactionHash: Hex
  logIndex: number
}

/** Why an `OrderPlacement` log was not turned into an order. */
export type SkipReason =
  /** The log carries this topic0 but does not decode as the event. */
  | 'undecodable'
  /** The settlement contract holds no signature for the uid. */
  | 'not-signed'
  /** `onlyDrops` is on and this order did not come from a cow-drop activation. */
  | 'not-a-drop'

export interface SkippedLog {
  reason: SkipReason
  log: RawLog
  detail?: string
}

export interface ScanOptions {
  reader: ChainReader
  /** `chainId` and `settlement` derive the domain separator each order's uid is computed against. */
  deployment: Pick<DropDeployment, 'chainId' | 'executor' | 'settlement'>
  fromBlock: bigint
  /** Inclusive. */
  toBlock: bigint
  /**
   * Check the pre-signature on-chain before accepting an order. Default `true`.
   *
   * This is the only check that proves anything, so turn it off only when something downstream does
   * the same job.
   */
  requireOnChainSignature?: boolean
  /**
   * Accept only orders placed by a cow-drop activation. Default `false`.
   *
   * `CowOrderPlaced` is a protocol-wide announcement, not cow-drop's own, so the default posts any
   * pre-signed order anyone announces. Turn this on to run a watch tower for drops specifically.
   */
  onlyDrops?: boolean
  onSkip?: (skipped: SkippedLog) => void
}

/**
 * Every discrete order announced in a block range, verified.
 *
 * ## Why there is no address filter
 *
 * Anything can emit `OrderPlacement`, and the interesting emitters cannot be enumerated anyway: a
 * drop address is derived from a recipe only its author holds and does not exist on-chain until
 * somebody activates it. So the filter is the topic0 and nothing else.
 *
 * This is the one thing CoW's own indexer does not do — `CoWSwapOnchainOrdersContract` filters on a
 * configured address list and asserts it is non-empty — and it is the reason a watch tower has to
 * exist at all rather than the event being enough on its own.
 *
 * ## Which means the event proves nothing by itself
 *
 * A topic0 is not a permission — anyone can emit those 32 bytes over a fabricated order. The check
 * that settles it is `GPv2Settlement.preSignature(uid) != 0`, against a uid recomputed here from the
 * order struct and the owner: a signature recorded against that uid is that owner's own commitment,
 * whoever announced it. That is also the fact the order book will check, so an order passing here is
 * one it will accept. Filtering by address would have been a proxy for this check; doing the check is
 * what makes dropping the filter safe.
 *
 * It follows that **the emitter does not have to be the owner**, and deliberately so — a contract
 * that cannot delegatecall pre-signs its own order and has `CowOrderPoster.announce` emit for it,
 * naming itself in `sender`.
 *
 * `onlyDrops` narrows to cow-drop's own orders by additionally requiring a `DropTriggered` from
 * `DropExecutor` in the same transaction, naming the emitter. `DropExecutor` re-derives a drop from
 * its recipe before emitting, so that is what says *"this address really is a drop running its
 * committed recipe"*.
 */
export async function scanForOrders(options: ScanOptions): Promise<DiscoveredOrder[]> {
  const { reader, deployment, fromBlock, toBlock, requireOnChainSignature = true, onlyDrops = false, onSkip } = options

  if (toBlock < fromBlock) return []

  const logs = await reader.getLogs({ topics: [COW_ORDER_TOPIC], fromBlock, toBlock })
  if (logs.length === 0) return []

  const activations = onlyDrops ? await activatedDrops(reader, deployment.executor, fromBlock, toBlock) : undefined

  const skip = (reason: SkipReason, log: RawLog, detail?: string) => onSkip?.({ reason, log, detail })

  // The log travels with the candidate so a later rejection can still report which log it was.
  const candidates: { found: DiscoveredOrder; log: RawLog }[] = []

  for (const log of logs) {
    let order: PlacedOrder
    try {
      order = parseOrderPlacement(log, deployment)
    } catch (cause) {
      skip('undecodable', log, cause instanceof Error ? cause.message : String(cause))
      continue
    }

    const emitter = getAddress(log.address)
    if (activations && !activations.has(activationKey(log.transactionHash, emitter))) {
      skip('not-a-drop', log)
      continue
    }

    candidates.push({
      log,
      found: {
        order,
        emitter,
        owner: order.owner,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      },
    })
  }

  if (!requireOnChainSignature) return candidates.map((candidate) => candidate.found)

  // One `eth_call` each, concurrently: the range that produced them already cost a `getLogs`, and
  // orders are rare enough that batching would be premature.
  const signed = await Promise.all(
    candidates.map(({ found }) =>
      // Only a pre-signature is readable on-chain. An ERC-1271 order carries its own signature in
      // the event, so there is nothing to look up.
      found.order.signingScheme === 'presign'
        ? reader.isPreSigned(deployment.settlement, found.order.orderUid)
        : Promise.resolve(true),
    ),
  )

  const verified: DiscoveredOrder[] = []
  candidates.forEach(({ log, found }, i) => {
    if (signed[i]) verified.push(found)
    else skip('not-signed', log, found.order.orderUid)
  })
  return verified
}

function activationKey(transactionHash: Hex, drop: Address): string {
  return `${transactionHash.toLowerCase()}#${drop.toLowerCase()}`
}

/**
 * `(transaction, drop)` pairs `DropExecutor` announced an activation for in this range.
 *
 * `DropTriggered(address indexed drop, ...)` puts the drop in `topics[1]`, so the pairs come out of
 * one `getLogs` against a single known address rather than a receipt per candidate.
 */
async function activatedDrops(
  reader: ChainReader,
  executor: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Set<string>> {
  const logs = await reader.getLogs({ address: executor, topics: [DROP_TRIGGERED_TOPIC], fromBlock, toBlock })

  const keys = new Set<string>()
  for (const log of logs) {
    const dropTopic = log.topics[1]
    if (!dropTopic) continue
    keys.add(activationKey(log.transactionHash, getAddress(`0x${dropTopic.slice(26)}`)))
  }
  return keys
}
