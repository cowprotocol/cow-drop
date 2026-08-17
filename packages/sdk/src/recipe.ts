import { isAddress, type Address, type Hex } from 'viem'

import { ZERO_SALT, deriveDropAddress, encodeRecipe } from './encoding.js'
import { getDeployment } from './generated/deployments.js'
import { limitPriceToFraction } from './price.js'
import { steps } from './steps.js'
import type { DropDeployment, LimitPriceFraction, Recipe } from './types.js'

/** A limit price, either as the exact atomic fraction or as a human price plus token decimals. */
export type LimitPriceJson =
  | { numerator: string; denominator: string }
  | { price: string; sellDecimals: number; buyDecimals: number }

export type DropStepJson =
  | {
      type: 'presignSellAll'
      sellToken: Address
      buyToken: Address
      receiver?: Address
      limitPrice: LimitPriceJson
      validitySeconds: number | string
      appData?: Hex
      allowFailure?: boolean
    }
  | {
      type: 'twapFromBalance'
      sellToken: Address
      buyToken: Address
      receiver?: Address
      parts: number | string
      partDuration: number | string
      span?: number | string
      limitPrice: LimitPriceJson
      appData?: Hex
      orderSalt?: Hex
      allowFailure?: boolean
    }
  | { type: 'requireMinBalance'; token: Address; minAmount: number | string }
  | { type: 'requireTimeWindow'; notBefore?: number | string; notAfter?: number | string }
  | { type: 'wrapNative'; wrappedNative: Address; allowFailure?: boolean }
  | { type: 'approveMax'; token: Address; spender: Address; allowFailure?: boolean }
  | {
      type: 'raw'
      target: Address
      callData: Hex
      value?: number | string
      allowFailure?: boolean
      isDelegateCall?: boolean
    }

/**
 * The portable recipe format — what the UI imports and exports, and the closest thing this project
 * has to a document. Note that the file is not itself the commitment: the compiled `setupData` is.
 * The file is a reproducible way to get back to those bytes, which is why compilation reads fields
 * by name in a fixed order and never depends on key order or formatting.
 */
export interface DropRecipeJson {
  version: 1
  label: string
  chainId: number
  owner: Address
  /**
   * The factory's user salt, as a 32-byte hex string. Defaults to zero.
   *
   * Use it when you want the *same* recipe at more than one address — several independent payroll
   * drops, say — without making the human-readable label artificially unique, or as a grinding space
   * for a vanity address.
   */
  salt?: Hex
  once?: boolean
  steps: DropStepJson[]
}

export interface CompiledRecipe {
  recipe: Recipe
  setupData: Hex
  /** The drop address. Send funds here. */
  address: Address
  deployment: DropDeployment
}

export function resolveLimitPrice(json: LimitPriceJson): LimitPriceFraction {
  if ('numerator' in json) {
    const numerator = BigInt(json.numerator)
    const denominator = BigInt(json.denominator)
    if (numerator <= 0n || denominator <= 0n) {
      throw new Error('limit price numerator and denominator must both be positive')
    }
    return { numerator, denominator }
  }
  return limitPriceToFraction(json.price, json.sellDecimals, json.buyDecimals)
}

/** Compile a recipe file into the bytes committed into its drop address, and that address. */
export function compileRecipe(json: DropRecipeJson, deploymentOverride?: DropDeployment): CompiledRecipe {
  if (json.version !== 1) {
    throw new Error(`unsupported recipe version: ${String(json.version)}`)
  }
  if (!isAddress(json.owner)) {
    throw new Error(`recipe owner is not an address: ${String(json.owner)}`)
  }
  if (!Array.isArray(json.steps) || json.steps.length === 0) {
    throw new Error('a recipe needs at least one step')
  }

  const deployment = deploymentOverride ?? getDeployment(json.chainId)
  if (deployment.chainId !== json.chainId) {
    throw new Error(`recipe is for chain ${json.chainId} but the deployment is for ${deployment.chainId}`)
  }

  if (json.salt !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(json.salt)) {
    throw new Error(`recipe salt must be a 32-byte hex string, got: ${String(json.salt)}`)
  }

  const recipe: Recipe = {
    label: json.label,
    salt: json.salt ?? ZERO_SALT,
    once: json.once ?? false,
    calls: json.steps.map((step) => compileStep(step, deployment)),
  }

  // `once` and `allowFailure` are each fine alone and dangerous together: a step that fails without
  // reverting lets an activation succeed having done nothing, which spends the single run and leaves
  // the drop permanently inert. Because activation is permissionless, anyone could do that to
  // anyone, at no cost beyond gas. Refused rather than warned about.
  if (recipe.once) {
    const index = recipe.calls.findIndex((call) => call.allowFailure)
    if (index !== -1) {
      throw new Error(
        `step ${index + 1} sets allowFailure in a "once" recipe: the run could be spent by anyone ` +
          `without the step taking effect. Drop allowFailure, or make the recipe reusable.`,
      )
    }
  }

  const setupData = encodeRecipe(recipe)
  return {
    recipe,
    setupData,
    address: deriveDropAddress({ deployment, owner: json.owner, setupData }),
    deployment,
  }
}

function compileStep(step: DropStepJson, deployment: DropDeployment) {
  switch (step.type) {
    case 'presignSellAll':
      return steps.presignSellAll(deployment, {
        sellToken: step.sellToken,
        buyToken: step.buyToken,
        receiver: step.receiver,
        limitPrice: resolveLimitPrice(step.limitPrice),
        validitySeconds: BigInt(step.validitySeconds),
        appData: step.appData,
        allowFailure: step.allowFailure,
      })
    case 'twapFromBalance':
      return steps.twapFromBalance(deployment, {
        sellToken: step.sellToken,
        buyToken: step.buyToken,
        receiver: step.receiver,
        parts: BigInt(step.parts),
        partDuration: BigInt(step.partDuration),
        span: step.span === undefined ? undefined : BigInt(step.span),
        limitPrice: resolveLimitPrice(step.limitPrice),
        appData: step.appData,
        orderSalt: step.orderSalt,
        allowFailure: step.allowFailure,
      })
    case 'requireMinBalance':
      return steps.requireMinBalance(deployment, {
        token: step.token,
        minAmount: BigInt(step.minAmount),
      })
    case 'requireTimeWindow':
      return steps.requireTimeWindow(deployment, {
        notBefore: step.notBefore === undefined ? undefined : BigInt(step.notBefore),
        notAfter: step.notAfter === undefined ? undefined : BigInt(step.notAfter),
      })
    case 'wrapNative':
      return steps.wrapNative(deployment, step)
    case 'approveMax':
      return steps.approveMax(deployment, step)
    case 'raw':
      return steps.raw({
        target: step.target,
        callData: step.callData,
        value: step.value === undefined ? undefined : BigInt(step.value),
        allowFailure: step.allowFailure,
        isDelegateCall: step.isDelegateCall,
      })
    default: {
      const exhaustive: never = step
      throw new Error(`unknown step type: ${JSON.stringify(exhaustive)}`)
    }
  }
}
