import { isAddress, type Address, type Hex } from 'viem'

import { ZERO_SALT, deriveDropAddress, encodeRecipe } from './encoding.js'
import { getDeployment } from './generated/deployments.js'
import { limitPriceToFraction } from './price.js'
import { steps, type Comparison } from './steps.js'
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
  | {
      type: 'stopLossFromBalance'
      sellToken: Address
      buyToken: Address
      receiver?: Address
      /** The minimum output. Distinct from `strike`, which decides *when* to sell. */
      limitPrice: LimitPriceJson
      /** Order lifetime from activation, not an absolute deadline. */
      validitySeconds: number | string
      trigger: {
        sellTokenPriceOracle: Address
        /** Must quote the same currency as the sell-token feed. */
        buyTokenPriceOracle: Address
        /** Fires when `sellPrice / buyPrice <= strike`, scaled to 18 decimals. */
        strike: number | string
        maxTimeSinceLastOracleUpdate: number | string
      }
      partiallyFillable?: boolean
      appData?: Hex
      orderSalt?: Hex
      allowFailure?: boolean
    }
  | {
      type: 'presignSellAllAtOracle'
      sellToken: Address
      buyToken: Address
      receiver?: Address
      /** The limit if the oracle cannot beat it. The oracle may only improve on it. */
      floorPrice: LimitPriceJson
      oracle: {
        sellTokenPriceOracle: Address
        buyTokenPriceOracle: Address
        maxAge: number | string
        haircutBps: number | string
      }
      validitySeconds: number | string
      appData?: Hex
      allowFailure?: boolean
    }
  | {
      type: 'requireCallResult'
      target: Address
      callData: Hex
      /** Which 32-byte word of the return data to compare. Defaults to 0. */
      wordIndex?: number | string
      comparison: Comparison
      threshold: number | string
    }
  | { type: 'requireMinBalance'; token: Address; minAmount: number | string }
  | { type: 'requireTimeWindow'; notBefore?: number | string; notAfter?: number | string }
  | { type: 'wrapNative'; wrappedNative: Address; allowFailure?: boolean }
  | { type: 'approveMax'; token: Address; spender: Address; allowFailure?: boolean }
  /**
   * Approve exactly the balance that arrived. The allowance counterpart of the other amount-dependent
   * steps — an allowance for a fixed number is a `raw` call to the token and needs nothing from here.
   */
  | { type: 'approveBalance'; token: Address; spender: Address; allowFailure?: boolean }
  /**
   * Mostly a rescue primitive, reached through the `build*` helpers in `rescue.ts` rather than from a
   * file. Reachable from a recipe too, though: an escape branch that pays the balance back to the owner
   * once a deadline has passed is a legitimate recipe, and refusing to express it would push the author
   * to `raw` — which the UI cannot describe. Pass the zero address as `token` to sweep the native
   * balance.
   */
  | { type: 'sweep'; token: Address; to: Address }
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
  /**
   * Which generation of the contracts to compile against. Defaults to **1**, not to the latest.
   *
   * The step contracts' addresses are inputs to the drop's CREATE2 derivation, so a file compiled
   * against a later generation resolves to a *different* address. Defaulting to the latest would mean
   * that upgrading the SDK silently repoints every file written before this field existed — and since
   * a drop is funded before it exists, and the file is the only way back to the funds, that is the
   * difference between recovering them and not. Anything this SDK exports pins the field explicitly.
   */
  generation?: number
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
  /** The owner the address was derived for — it is half the derivation, so it travels with it. */
  owner: Address
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

  // `?? 1` rather than `?? LATEST_GENERATION` — see the field's doc comment. A file that predates the
  // field was compiled against generation 1, and that is what it has to keep meaning.
  const generation = json.generation ?? 1
  const deployment = deploymentOverride ?? getDeployment(json.chainId, generation)
  if (deployment.chainId !== json.chainId) {
    throw new Error(`recipe is for chain ${json.chainId} but the deployment is for ${deployment.chainId}`)
  }
  if (deployment.generation !== generation) {
    throw new Error(
      `recipe asks for generation ${generation} but the deployment is generation ${deployment.generation}`,
    )
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
    owner: json.owner,
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
    case 'stopLossFromBalance':
      return steps.stopLossFromBalance(deployment, {
        sellToken: step.sellToken,
        buyToken: step.buyToken,
        receiver: step.receiver,
        limitPrice: resolveLimitPrice(step.limitPrice),
        validitySeconds: BigInt(step.validitySeconds),
        trigger: {
          sellTokenPriceOracle: step.trigger.sellTokenPriceOracle,
          buyTokenPriceOracle: step.trigger.buyTokenPriceOracle,
          strike: BigInt(step.trigger.strike),
          maxTimeSinceLastOracleUpdate: BigInt(step.trigger.maxTimeSinceLastOracleUpdate),
        },
        partiallyFillable: step.partiallyFillable,
        appData: step.appData,
        orderSalt: step.orderSalt,
        allowFailure: step.allowFailure,
      })
    case 'presignSellAllAtOracle':
      return steps.presignSellAllAtOracle(deployment, {
        sellToken: step.sellToken,
        buyToken: step.buyToken,
        receiver: step.receiver,
        floorPrice: resolveLimitPrice(step.floorPrice),
        oracle: {
          sellTokenPriceOracle: step.oracle.sellTokenPriceOracle,
          buyTokenPriceOracle: step.oracle.buyTokenPriceOracle,
          maxAge: BigInt(step.oracle.maxAge),
          haircutBps: BigInt(step.oracle.haircutBps),
        },
        validitySeconds: BigInt(step.validitySeconds),
        appData: step.appData,
        allowFailure: step.allowFailure,
      })
    case 'requireCallResult':
      return steps.requireCallResult(deployment, {
        target: step.target,
        callData: step.callData,
        wordIndex: step.wordIndex === undefined ? undefined : BigInt(step.wordIndex),
        comparison: step.comparison,
        threshold: BigInt(step.threshold),
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
    case 'sweep':
      return steps.sweep(deployment, { token: step.token, to: step.to })
    case 'approveMax':
      return steps.approveMax(deployment, step)
    case 'approveBalance':
      return steps.approveBalance(deployment, step)
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
