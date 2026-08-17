import type { Address, Hex } from 'viem'

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
  sellToken: Address
  buyToken: Address
  /** Where the bought tokens go. Omit to leave them in the drop. */
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
    receiver: params.receiver,
    limitPrice: params.limitPrice,
    validitySeconds: params.validitySeconds ?? 30 * 60,
    appData: params.appData,
  })

  return {
    version: 1,
    label: params.label ?? 'swap on arrival',
    chainId: params.chainId,
    owner: params.owner,
    once: false,
    steps,
  }
}

export interface TwapOnArrivalParams {
  chainId: number
  owner: Address
  sellToken: Address
  buyToken: Address
  receiver?: Address
  /** Number of parts to split the arrived balance into. */
  parts: number
  /** Seconds between parts. */
  partDuration: number
  span?: number
  limitPrice: LimitPriceJson
  label?: string
  appData?: Hex
  wrapNative?: Address
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

  if (params.wrapNative) {
    steps.push({ type: 'wrapNative', wrappedNative: params.wrapNative })
  }

  steps.push({
    type: 'twapFromBalance',
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    receiver: params.receiver,
    parts: params.parts,
    partDuration: params.partDuration,
    span: params.span,
    limitPrice: params.limitPrice,
    appData: params.appData,
  })

  return {
    version: 1,
    label: params.label ?? `twap ${params.parts} parts`,
    chainId: params.chainId,
    owner: params.owner,
    once: true,
    steps,
  }
}
