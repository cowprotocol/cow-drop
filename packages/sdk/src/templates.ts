import type { Address, Hex } from 'viem'

import { LATEST_GENERATION } from './generated/deployments.js'
import type { DropRecipeJson, LimitPriceJson } from './recipe.js'

/**
 * Templates: a handful of parameters in, a complete recipe out.
 *
 * These exist so the common cases never require touching the step builder. The UI's template
 * picker calls one of these and drops the result into the builder, where it can still be edited.
 */

export interface SwapOnArrivalParams {
  chainId: number
  owner: Address
  /** Optional user salt, to get more than one drop from the same parameters. */
  salt?: Hex
  sellToken: Address
  buyToken: Address
  /**
   * Where the bought tokens go. **Defaults to the owner**, which is almost always what you want:
   * otherwise the proceeds sit in the drop and need a second transaction to get out.
   *
   * Pass the zero address to deliberately leave them in the drop — CoW's "pay the order's owner"
   * sentinel, and the drop *is* the order's owner. That is the right choice only when something else
   * will act on them there.
   *
   * Note this cannot default to the drop's own address: that address is derived from these very
   * parameters, so naming it here would be circular. The sentinel exists for exactly that reason.
   */
  receiver?: Address
  limitPrice: LimitPriceJson
  /** Order lifetime once activated. Defaults to 30 minutes. */
  validitySeconds?: number
  label?: string
  appData?: Hex
  /**
   * Wrap the drop's native balance first, for a drop funded with ETH/xDAI rather than a token.
   * Pass the wrapped-native address of the chain.
   */
  wrapNative?: Address
}

/**
 * The "bridge in, then swap" recipe: whatever lands here gets sold once, at a limit price.
 *
 * Uses the pre-sign path, so it needs no conditional-order handler and no watch tower — but the
 * order does have to be POSTed to the order book after activation. `once` is left false so the same
 * address keeps working for later arrivals.
 */
export function swapOnArrival(params: SwapOnArrivalParams): DropRecipeJson {
  const steps: DropRecipeJson['steps'] = []

  if (params.wrapNative) {
    steps.push({ type: 'wrapNative', wrappedNative: params.wrapNative })
  }

  steps.push({
    type: 'presignSellAll',
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    receiver: params.receiver ?? params.owner,
    limitPrice: params.limitPrice,
    validitySeconds: params.validitySeconds ?? 30 * 60,
    appData: params.appData,
  })

  return {
    version: 1,
    generation: LATEST_GENERATION,
    label: params.label ?? 'swap on arrival',
    chainId: params.chainId,
    owner: params.owner,
    salt: params.salt,
    once: false,
    steps,
  }
}

export interface TwapOnArrivalParams {
  chainId: number
  owner: Address
  sellToken: Address
  buyToken: Address
  /** Where the bought tokens go. Defaults to the owner — see `SwapOnArrivalParams.receiver`. */
  receiver?: Address
  /** Number of parts to split the arrived balance into. */
  parts: number
  /** Seconds between parts. */
  partDuration: number
  /** Optional user salt, to get more than one drop from the same parameters. */
  salt?: Hex
  span?: number
  limitPrice: LimitPriceJson
  label?: string
  appData?: Hex
  wrapNative?: Address
  /**
   * Refuse to activate until this much has arrived, in atomic units.
   *
   * Strongly recommended here. This recipe is one-shot, so without a floor anyone may activate it
   * the moment the first wei lands and the whole schedule gets sized from a part-delivered balance —
   * which is exactly what happens if a bridge pays out in tranches. The guard reverts, so an early
   * activation is a no-op rather than a spent run.
   */
  minAmount?: bigint
  /** Refuse to activate before this absolute unix timestamp. */
  notBefore?: bigint
}

/**
 * The TWAP recipe: whatever lands here is split into `parts` and sold over time.
 *
 * Uses the composable path, so after a single activation the drop is self-driving — the watch tower
 * posts each part as it becomes tradeable, with nobody signing anything.
 *
 * `once` is true here: re-running would register a *second* overlapping TWAP against the remaining
 * balance, which is almost never what someone means.
 */
export function twapOnArrival(params: TwapOnArrivalParams): DropRecipeJson {
  const steps: DropRecipeJson['steps'] = []

  // Guards go first, before anything has side effects.
  if (params.notBefore !== undefined) {
    steps.push({ type: 'requireTimeWindow', notBefore: params.notBefore.toString() })
  }

  if (params.wrapNative) {
    steps.push({ type: 'wrapNative', wrappedNative: params.wrapNative })
  }

  // After wrapping, so a native-funded drop is measured in the token it will actually sell.
  if (params.minAmount !== undefined) {
    steps.push({ type: 'requireMinBalance', token: params.sellToken, minAmount: params.minAmount.toString() })
  }

  steps.push({
    type: 'twapFromBalance',
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    receiver: params.receiver ?? params.owner,
    parts: params.parts,
    partDuration: params.partDuration,
    span: params.span,
    limitPrice: params.limitPrice,
    appData: params.appData,
  })

  return {
    version: 1,
    generation: LATEST_GENERATION,
    label: params.label ?? `twap ${params.parts} parts`,
    chainId: params.chainId,
    owner: params.owner,
    salt: params.salt,
    once: true,
    steps,
  }
}
