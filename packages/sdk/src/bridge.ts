import { decodeAbiParameters, encodeAbiParameters, type Address, type Hex } from 'viem'

import { describeRecipe } from './describe.js'
import type { CompiledRecipe } from './recipe.js'
import type { DropDeployment } from './types.js'

/**
 * Bridging into a drop.
 *
 * A drop address is fundable before it exists, so the plainest way to bridge into one needs nothing
 * from this file: name `compileRecipe(...).address` as the bridge's recipient and let a keeper
 * activate once the money lands.
 *
 * What this adds is the *atomic* path. A bridge that supports a destination payload can deliver to
 * `DropBungeeReceiver` instead, which forwards the tokens to the drop and activates it inside the
 * bridge's own fill — so the CoW order is live in the same transaction, and the relayer filling the
 * bridge pays the activation gas as part of a job it is already being paid for.
 *
 * Everything here is offline: the payload is the recipe the address already commits to, so nothing
 * needs quoting to build it.
 */

/**
 * What the receiver does with the tokens when the recipe will not run.
 *
 * Not a failure mode so much as a fork in the road. A recipe declining to activate is usually the
 * design working — a `requireMinBalance` guard refusing a bridge's first tranche — and the tokens
 * have to go somewhere either way.
 */
export const ON_FAILURE = ['leave-at-drop', 'refund-owner'] as const
export type OnFailure = (typeof ON_FAILURE)[number]

/** The `uint8` each name is encoded as. Must match `DropDelivery.OnFailure`'s declaration order. */
const ON_FAILURE_CODE: Readonly<Record<OnFailure, number>> = {
  'leave-at-drop': 0,
  'refund-owner': 1,
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Gas the destination delivery needs, and the default this SDK quotes.
 *
 * Measured, not guessed: `test_gas_aFirstDeliveryFitsInTheQuotedLimit` in
 * `contracts/test/bridge/DropBungeeReceiver.t.sol` puts a cold delivery — one that deploys the drop
 * *and* signs the order — at a little over 400k, and that test fails if it grows past 600k.
 *
 * Worth over-quoting rather than trimming. Destination gas is prepaid on the source chain, so the
 * cost of a limit that is too high is some refunded change, while the cost of one that is too low is
 * a delivery that cannot complete after the money has already left.
 */
export const DEFAULT_DESTINATION_GAS_LIMIT = 550_000

/** The payload `DropDelivery` decodes, i.e. `abi.encode(address, bytes, uint8)`. */
const DELIVERY_PAYLOAD_ABI = [{ type: 'address' }, { type: 'bytes' }, { type: 'uint8' }] as const

export interface DeliveryPayload {
  owner: Address
  /** The compiled recipe — the same bytes the drop address commits to. */
  setupData: Hex
  onFailure: OnFailure
}

/**
 * Where a bridge should deliver, what to send with it, and how much gas to prepay.
 *
 * The seam a bridge provider plugs into: it is everything about the destination a provider needs and
 * nothing about the bridge. `cowprotocol/cow-sdk#845` has the same three ideas hard-coded to
 * `OrderFlow` (`getOrderFlowAddress`, `encodeOrderData`, a guessed gas limit); naming them here is
 * what would let one Bungee implementation serve both destinations.
 */
export interface DestinationTarget {
  /** The address the bridge delivers to. The receiver in atomic mode; the drop itself in direct mode. */
  receiver: Address
  /**
   * The destination calldata, or `0x` for a plain transfer.
   *
   * Empty is the signal for direct delivery, and it is load-bearing everywhere downstream: a provider
   * must not ask a bridge for destination execution it is not going to use, and must not restrict the
   * route to bridges that support it. See `directDelivery`.
   */
  payload: Hex
  /** Where the funds end up — the drop. Equal to `receiver` in direct mode. */
  predictedAddress: Address
  /** Destination gas to prepay. Zero in direct mode, where nothing runs on arrival. */
  gasLimit: number
}

/** The delivery payload for a drop. */
export function encodeDeliveryPayload(params: {
  owner: Address
  setupData: Hex
  /** Defaults to `leave-at-drop`, which is safe with any recipe. */
  onFailure?: OnFailure
}): Hex {
  const onFailure = params.onFailure ?? 'leave-at-drop'

  // The receiver rejects this too, but failing here means finding out while building a transaction
  // rather than after the money has crossed a bridge.
  if (onFailure === 'refund-owner' && params.owner.toLowerCase() === ZERO_ADDRESS) {
    throw new Error('refund-owner needs an owner to refund: this recipe has none (owner is the zero address)')
  }

  return encodeAbiParameters(DELIVERY_PAYLOAD_ABI, [params.owner, params.setupData, ON_FAILURE_CODE[onFailure]])
}

/** The inverse, for reading a payload back off a bridge transaction. */
export function decodeDeliveryPayload(payload: Hex): DeliveryPayload {
  const [owner, setupData, code] = decodeAbiParameters(DELIVERY_PAYLOAD_ABI, payload)

  const onFailure = ON_FAILURE.find((name) => ON_FAILURE_CODE[name] === code)
  if (onFailure === undefined) throw new Error(`unknown onFailure code in delivery payload: ${code}`)

  return { owner, setupData, onFailure }
}

/** The receiver for a deployment, or a readable error saying why there is not one. */
export function bungeeReceiverOf(deployment: DropDeployment): Address {
  const receiver = deployment.bungeeReceiver
  if (!receiver) {
    throw new Error(
      `generation ${deployment.generation} has no Bungee receiver — ` +
        `it was added after that generation was cut. Compile the recipe against a later one.`,
    )
  }
  return receiver
}

/**
 * The complete destination half of a bridge-and-swap, from a compiled recipe.
 *
 * Note what this does *not* depend on: the bridge, the amount, or a quote. The receiver's address is
 * fixed and the payload is the recipe, so re-quoting a route can never move the drop address — which
 * matters, because the payload names that address's preimage and a moving target would invalidate
 * every quote taken before it moved.
 */
export function bungeeDelivery(
  compiled: CompiledRecipe,
  options: { onFailure?: OnFailure; gasLimit?: number } = {},
): DestinationTarget {
  const onFailure = options.onFailure ?? 'leave-at-drop'
  assertRefundIsSafe(compiled, onFailure)

  return {
    receiver: bungeeReceiverOf(compiled.deployment),
    payload: encodeDeliveryPayload({ owner: compiled.owner, setupData: compiled.setupData, onFailure }),
    predictedAddress: compiled.address,
    gasLimit: options.gasLimit ?? DEFAULT_DESTINATION_GAS_LIMIT,
  }
}

/**
 * Deliver straight to the drop, with no contract in between.
 *
 * The safe default, and the one to reach for unless the latency genuinely matters. The bridge is asked
 * for nothing but a transfer, which has two consequences worth understanding:
 *
 * **Nothing can be stolen.** A drop address belongs to exactly one recipe and one owner, so money sent
 * there can only ever be spent by that recipe or rescued by that owner. `bungeeDelivery`'s receiver is
 * shared by everyone and forwards its whole balance to whichever drop its caller names, so a delivery
 * that fails to execute there is a public bounty. Here there is nothing to redirect and nothing to race
 * for — an unactivated delivery simply waits, indefinitely and safely.
 *
 * **Every bridge qualifies.** Atomic delivery only works through bridges that actually run a destination
 * payload, and that allowlist is narrow — with it, Gnosis is reachable only from Ethereum. A plain
 * transfer has no such requirement.
 *
 * What it costs: somebody still has to call `activate`. That is the keeper, if the drop was registered
 * before the money was sent — so register first, always. See `docs/BRIDGING.md`.
 */
export function directDelivery(compiled: CompiledRecipe): DestinationTarget {
  return {
    receiver: compiled.address,
    // No destination call, so no payload and no gas to prepay. Both are checked downstream.
    payload: '0x',
    predictedAddress: compiled.address,
    gasLimit: 0,
  }
}

/**
 * Refuse `refund-owner` on a recipe that is waiting for more money.
 *
 * The two features are individually reasonable and together are a bug. A `requireMinBalance` guard
 * exists precisely so that a bridge paying in tranches accumulates rather than trading on a partial
 * balance — and `refund-owner` reads that same refusal as "this recipe is broken" and sends the
 * tranche back. Every tranche would bounce, and the drop would never fill.
 *
 * Checked against the compiled bytes rather than the recipe file, so a hand-written `raw` step that
 * happens to call the guard is caught too — it is the drop address's actual commitment that decides
 * this, not how somebody wrote it down.
 */
function assertRefundIsSafe(compiled: CompiledRecipe, onFailure: OnFailure): void {
  if (onFailure !== 'refund-owner') return

  const described = describeRecipe(compiled.setupData, compiled.deployment)
  const guarded = described.steps.some(
    (step) => step.known?.contract === 'GuardSteps' && step.known.functionName === 'requireMinBalance',
  )

  if (guarded) {
    throw new Error(
      'refund-owner cannot be used with a requireMinBalance recipe: the guard exists so that a ' +
        'tranche-paying bridge accumulates, and refunding would send every tranche back instead. ' +
        'Use leave-at-drop, which lets the tranches gather at the drop.',
    )
  }
}
