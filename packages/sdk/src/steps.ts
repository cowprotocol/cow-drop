import { encodeFunctionData, type Address, type Hex } from 'viem'

import { DROP_RECIPES_ABI } from './generated/artifacts.js'
import type { DropCall, DropDeployment, LimitPriceFraction } from './types.js'

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/**
 * A recipe primitive always runs as a delegatecall into `DropRecipes`, so that `address(this)` is
 * the drop and the step can read the balance that actually arrived. Getting this flag wrong is not
 * a subtle bug: the step would read `DropRecipes`' own (always zero) balance.
 */
function recipeCall(deployment: Pick<DropDeployment, 'recipes'>, callData: Hex, allowFailure = false): DropCall {
  return {
    target: deployment.recipes,
    value: 0n,
    callData,
    allowFailure,
    isDelegateCall: true,
  }
}

export interface PresignSellAllParams {
  sellToken: Address
  buyToken: Address
  /** Where the bought tokens go. Defaults to the drop itself. */
  receiver?: Address
  limitPrice: LimitPriceFraction
  /** Order lifetime from activation, not an absolute deadline. */
  validitySeconds: bigint
  appData?: Hex
  allowFailure?: boolean
}

export interface TwapFromBalanceParams {
  sellToken: Address
  buyToken: Address
  receiver?: Address
  /** Number of parts. Must be at least 2. */
  parts: bigint
  /** Seconds per part. */
  partDuration: bigint
  /** Trading window within each part; 0 means the whole part. */
  span?: bigint
  limitPrice: LimitPriceFraction
  appData?: Hex
  /** Discriminator for the conditional order, if you need two TWAPs with identical params. */
  salt?: Hex
  allowFailure?: boolean
}

const ZERO_BYTES32: Hex = `0x${'00'.repeat(32)}`

/**
 * The step registry. Each entry compiles a recipe step into one `DropCall`.
 *
 * This is the extension point: a new capability is a new function here plus a matching primitive in
 * `DropRecipes.sol`. `raw` is the escape hatch the ABI-builder UI emits for anything not covered.
 */
export const steps = {
  /** Sell the drop's whole balance as one pre-signed order (path P). */
  presignSellAll(deployment: Pick<DropDeployment, 'recipes'>, params: PresignSellAllParams): DropCall {
    return recipeCall(
      deployment,
      encodeFunctionData({
        abi: DROP_RECIPES_ABI,
        functionName: 'presignSellAll',
        args: [
          params.sellToken,
          params.buyToken,
          params.receiver ?? ZERO_ADDRESS,
          params.limitPrice.numerator,
          params.limitPrice.denominator,
          params.validitySeconds,
          params.appData ?? ZERO_BYTES32,
        ],
      }),
      params.allowFailure,
    )
  },

  /** Split the drop's whole balance into parts and register a TWAP (path C). */
  twapFromBalance(deployment: Pick<DropDeployment, 'recipes'>, params: TwapFromBalanceParams): DropCall {
    if (params.parts < 2n) {
      throw new Error('a TWAP needs at least 2 parts; use presignSellAll for a single swap')
    }
    if (params.partDuration <= 0n) {
      throw new Error('partDuration must be greater than zero')
    }
    const span = params.span ?? 0n
    if (span > params.partDuration) {
      throw new Error('span cannot exceed partDuration')
    }
    return recipeCall(
      deployment,
      encodeFunctionData({
        abi: DROP_RECIPES_ABI,
        functionName: 'twapFromBalance',
        args: [
          params.sellToken,
          params.buyToken,
          params.receiver ?? ZERO_ADDRESS,
          params.parts,
          params.partDuration,
          span,
          params.limitPrice.numerator,
          params.limitPrice.denominator,
          params.appData ?? ZERO_BYTES32,
          params.salt ?? ZERO_BYTES32,
        ],
      }),
      params.allowFailure,
    )
  },

  /** Wrap the drop's whole native balance, so natively-funded drops can trade. */
  wrapNative(deployment: Pick<DropDeployment, 'recipes'>, params: { wrappedNative: Address; allowFailure?: boolean }): DropCall {
    return recipeCall(
      deployment,
      encodeFunctionData({
        abi: DROP_RECIPES_ABI,
        functionName: 'wrapNative',
        args: [params.wrappedNative],
      }),
      params.allowFailure,
    )
  },

  approveMax(
    deployment: Pick<DropDeployment, 'recipes'>,
    params: { token: Address; spender: Address; allowFailure?: boolean },
  ): DropCall {
    return recipeCall(
      deployment,
      encodeFunctionData({
        abi: DROP_RECIPES_ABI,
        functionName: 'approveMax',
        args: [params.token, params.spender],
      }),
      params.allowFailure,
    )
  },

  /**
   * Anything not covered above. A plain call by default — `isDelegateCall` runs foreign code in the
   * drop's context and can rewrite its storage, so it must be asked for explicitly.
   */
  raw(params: {
    target: Address
    callData: Hex
    value?: bigint
    allowFailure?: boolean
    isDelegateCall?: boolean
  }): DropCall {
    return {
      target: params.target,
      value: params.value ?? 0n,
      callData: params.callData,
      allowFailure: params.allowFailure ?? false,
      isDelegateCall: params.isDelegateCall ?? false,
    }
  },
}
