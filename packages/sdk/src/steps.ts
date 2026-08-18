import { encodeFunctionData, type Address, type Hex } from 'viem'

import {
  GUARD_STEPS_ABI,
  PRESIGN_STEPS_ABI,
  STOP_LOSS_STEPS_ABI,
  TOKEN_STEPS_ABI,
  TWAP_STEPS_ABI,
} from './generated/artifacts.js'
import type { DropCall, DropDeployment, LimitPriceFraction } from './types.js'

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/**
 * A step always runs as a delegatecall into its step contract, so that `address(this)` is the drop and
 * the step can read the balance that actually arrived. Getting this flag wrong is not a subtle bug: the
 * step would read the step contract's own (always zero) balance.
 *
 * Each builder passes the contract that hosts it. The four are separate deployments because a step's
 * target sits inside the committed bytes and is therefore part of the drop address — see
 * `contracts/src/steps/`. That is also why a builder narrows its `deployment` parameter to the single
 * field it needs: asking for `deployment.twapSteps` in a guard would be a lie about what moves that
 * guard's address.
 */
function stepCall(target: Address, callData: Hex, allowFailure = false): DropCall {
  return {
    target,
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
  /**
   * Discriminator for the conditional order itself, if you need two TWAPs with identical params.
   * Unrelated to the drop's own factory salt, which lives on the recipe.
   */
  orderSalt?: Hex
  allowFailure?: boolean
}

const ZERO_BYTES32: Hex = `0x${'00'.repeat(32)}`

/** The oracle pair and threshold a stop-loss fires on. */
export interface StopLossTrigger {
  /** Chainlink-style feed for the sell token. */
  sellTokenPriceOracle: Address
  /** Feed for the buy token. Must quote the same currency as the sell-token feed. */
  buyTokenPriceOracle: Address
  /** Fires when `sellPrice / buyPrice <= strike`, scaled to 18 decimals. */
  strike: bigint
  /** How stale a feed may be before the handler refuses to price the pair. */
  maxTimeSinceLastOracleUpdate: bigint
}

/** Comparison operators, in the order `GuardSteps.Comparison` declares them. */
export const COMPARISONS = ['gt', 'gte', 'lt', 'lte', 'eq'] as const
export type Comparison = (typeof COMPARISONS)[number]

export interface RequireCallResultParams {
  target: Address
  /** Full calldata, selector included. */
  callData: Hex
  /** Which 32-byte word of the return data to compare. `0` for a single return value. */
  wordIndex?: bigint
  comparison: Comparison
  /** Signed, so Chainlink answers and plain `uint256` getters both fit. */
  threshold: bigint
}

export interface OraclePrice {
  sellTokenPriceOracle: Address
  /** Must quote the same currency as the sell-token feed. */
  buyTokenPriceOracle: Address
  /** How stale either feed may be before the step reverts. */
  maxAge: bigint
  /** How far below the oracle's own number to set the limit, in basis points. */
  haircutBps: bigint
}

export interface PresignSellAllAtOracleParams {
  sellToken: Address
  buyToken: Address
  receiver?: Address
  /** The limit if the oracle cannot beat it. Set it as though the oracle did not exist. */
  floorPrice: LimitPriceFraction
  oracle: OraclePrice
  validitySeconds: bigint
  appData?: Hex
  allowFailure?: boolean
}

export interface StopLossFromBalanceParams {
  sellToken: Address
  buyToken: Address
  receiver?: Address
  /** The minimum output, applied to whatever arrived. Distinct from the strike. */
  limitPrice: LimitPriceFraction
  /** Order lifetime from activation, not an absolute deadline. */
  validitySeconds: bigint
  trigger: StopLossTrigger
  partiallyFillable?: boolean
  appData?: Hex
  orderSalt?: Hex
  allowFailure?: boolean
}

/**
 * An order selling a token for itself is invalid — TWAP's own `validate` rejects it and GPv4 would
 * too. Caught here so it fails while authoring rather than at activation, which for a committed recipe
 * means a drop address that can never run.
 */
function assertDistinctTokens(sellToken: Address, buyToken: Address): void {
  if (sellToken.toLowerCase() === buyToken.toLowerCase()) {
    throw new Error(`sellToken and buyToken are the same (${sellToken}); an order cannot trade a token for itself`)
  }
}

/**
 * The step registry. Each entry compiles a recipe step into one `DropCall`.
 *
 * This is the extension point: a new capability is a new function here plus a matching primitive in one
 * of the contracts under `contracts/src/steps/`. `raw` is the escape hatch the ABI-builder UI emits for
 * anything not covered.
 */
export const steps = {
  /** Sell the drop's whole balance as one pre-signed order (path P). */
  presignSellAll(deployment: Pick<DropDeployment, 'presignSteps'>, params: PresignSellAllParams): DropCall {
    assertDistinctTokens(params.sellToken, params.buyToken)
    return stepCall(
      deployment.presignSteps,
      encodeFunctionData({
        abi: PRESIGN_STEPS_ABI,
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
  twapFromBalance(deployment: Pick<DropDeployment, 'twapSteps'>, params: TwapFromBalanceParams): DropCall {
    assertDistinctTokens(params.sellToken, params.buyToken)
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
    return stepCall(
      deployment.twapSteps,
      encodeFunctionData({
        abi: TWAP_STEPS_ABI,
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
          params.orderSalt ?? ZERO_BYTES32,
        ],
      }),
      params.allowFailure,
    )
  },

  /**
   * Sell the whole balance at whichever is stricter: an oracle-derived limit, or a floor you commit.
   *
   * Solves a stale committed price without handing the price away. Activation is permissionless, so an
   * activator picks the moment and therefore the oracle reading — the floor is what stops them picking
   * a bad one. The oracle may only ever *improve* on it, so the worst an activator can do is give you
   * the price you already agreed to. Set `floorPrice` as though the oracle did not exist.
   */
  presignSellAllAtOracle(
    deployment: Pick<DropDeployment, 'presignSteps'>,
    params: PresignSellAllAtOracleParams,
  ): DropCall {
    assertDistinctTokens(params.sellToken, params.buyToken)
    if (params.oracle.haircutBps > 10_000n) {
      throw new Error('haircutBps cannot exceed 10000 (100%)')
    }
    if (params.oracle.maxAge <= 0n) {
      throw new Error('maxAge must be positive, or every oracle read counts as stale')
    }
    if (params.oracle.sellTokenPriceOracle.toLowerCase() === params.oracle.buyTokenPriceOracle.toLowerCase()) {
      throw new Error('the two price feeds are the same address, so the derived price is always 1')
    }
    return stepCall(
      deployment.presignSteps,
      encodeFunctionData({
        abi: PRESIGN_STEPS_ABI,
        functionName: 'presignSellAllAtOracle',
        args: [
          params.sellToken,
          params.buyToken,
          params.receiver ?? ZERO_ADDRESS,
          params.floorPrice.numerator,
          params.floorPrice.denominator,
          {
            sellTokenPriceOracle: params.oracle.sellTokenPriceOracle,
            buyTokenPriceOracle: params.oracle.buyTokenPriceOracle,
            maxAge: params.oracle.maxAge,
            haircutBps: params.oracle.haircutBps,
          },
          params.validitySeconds,
          params.appData ?? ZERO_BYTES32,
        ],
      }),
      params.allowFailure,
    )
  },

  /**
   * Refuse to proceed unless a read from another contract satisfies a comparison.
   *
   * The general-purpose guard — an oracle threshold, a balance elsewhere, a protocol's utilisation.
   * It is a `staticcall`, so the worst a malformed one can do is revert or pass wrongly; it can never
   * move a balance.
   *
   * **It is a refusal, not a trigger.** Evaluated once, at activation. Nothing watches for the moment
   * the condition turns true, so "sell when the price crosses X" is `stopLossFromBalance`, not this.
   * Use it to refuse to start on terms you would not accept.
   *
   * `wordIndex` picks which 32-byte word of the return data to compare — `0` for a single return value,
   * `1` for Chainlink's `answer`. An index pointing at the wrong field compares the wrong number and may
   * pass when it should fail, silently, so a UI should show the target and calldata rather than a
   * friendly summary.
   */
  requireCallResult(deployment: Pick<DropDeployment, 'guardSteps'>, params: RequireCallResultParams): DropCall {
    const comparison = COMPARISONS.indexOf(params.comparison)
    if (comparison < 0) {
      throw new Error(`unknown comparison: ${String(params.comparison)}`)
    }
    return stepCall(
      deployment.guardSteps,
      encodeFunctionData({
        abi: GUARD_STEPS_ABI,
        functionName: 'requireCallResult',
        args: [params.target, params.callData, params.wordIndex ?? 0n, comparison, params.threshold],
      }),
      // Never swallow a guard's revert — that would defeat its entire purpose.
      false,
    )
  },

  /**
   * Sell the drop's whole balance, but only once an oracle pair crosses a strike (path C).
   *
   * The condition is evaluated by the watch tower on every poll rather than once at activation, which
   * is what separates this from a guard: a guard can only *refuse* at the wrong moment and needs
   * somebody watching to retry, whereas this sits registered and fires itself.
   *
   * `strike` is the floor, scaled to 18 decimals: the handler sells when
   * `sellTokenPrice / buyTokenPrice <= strike`, both prices taken from the feeds and normalised. So
   * "sell my WXDAI if it drops below 1.8 COW" is `strike = 1_800000000000000000n`. The two feeds
   * **must quote the same currency**, or the comparison is meaningless — that is not checkable
   * on-chain, so it is on the author.
   *
   * `limitPrice` is a separate thing from `strike`: the strike decides *when* to sell, the limit
   * decides how bad a fill you refuse. Setting a strike without a sane limit is how a stop-loss
   * becomes a market order into whatever liquidity happens to exist.
   */
  stopLossFromBalance(
    deployment: Pick<DropDeployment, 'stopLossSteps'>,
    params: StopLossFromBalanceParams,
  ): DropCall {
    assertDistinctTokens(params.sellToken, params.buyToken)
    if (params.validitySeconds <= 0n) {
      throw new Error('a stop-loss needs a positive validitySeconds; it is measured from activation')
    }
    if (params.trigger.maxTimeSinceLastOracleUpdate <= 0n) {
      throw new Error('maxTimeSinceLastOracleUpdate must be positive, or every oracle read counts as stale')
    }
    if (params.trigger.sellTokenPriceOracle.toLowerCase() === params.trigger.buyTokenPriceOracle.toLowerCase()) {
      throw new Error('the two price feeds are the same address, so the strike comparison is always 1')
    }
    return stepCall(
      deployment.stopLossSteps,
      encodeFunctionData({
        abi: STOP_LOSS_STEPS_ABI,
        functionName: 'stopLossFromBalance',
        args: [
          params.sellToken,
          params.buyToken,
          params.receiver ?? ZERO_ADDRESS,
          params.limitPrice.numerator,
          params.limitPrice.denominator,
          params.validitySeconds,
          {
            sellTokenPriceOracle: params.trigger.sellTokenPriceOracle,
            buyTokenPriceOracle: params.trigger.buyTokenPriceOracle,
            strike: params.trigger.strike,
            maxTimeSinceLastOracleUpdate: params.trigger.maxTimeSinceLastOracleUpdate,
          },
          params.partiallyFillable ?? false,
          params.appData ?? ZERO_BYTES32,
          params.orderSalt ?? ZERO_BYTES32,
        ],
      }),
      params.allowFailure,
    )
  },

  /**
   * Refuse to proceed unless the drop holds at least `minAmount`.
   *
   * The guarantee that nobody activates a drop before its funds have landed cannot come from the
   * activator, since anyone may activate. It has to be committed into the address — which is what
   * this does. Put it first in a recipe; it reverts, so a premature activation rolls back entirely
   * and, critically, does not spend a `once` recipe's single run.
   *
   * Pass `token: zero address` to guard the native balance instead.
   */
  requireMinBalance(
    deployment: Pick<DropDeployment, 'guardSteps'>,
    params: { token: Address; minAmount: bigint },
  ): DropCall {
    if (params.minAmount <= 0n) {
      throw new Error('requireMinBalance needs a positive minAmount to guard anything')
    }
    return stepCall(
      deployment.guardSteps,
      encodeFunctionData({
        abi: GUARD_STEPS_ABI,
        functionName: 'requireMinBalance',
        args: [params.token, params.minAmount],
      }),
      // Never swallow a guard's revert — that would defeat its entire purpose.
      false,
    )
  },

  /**
   * Refuse to proceed outside an absolute time window. Either bound may be omitted.
   *
   * Timestamps are absolute because they are fixed when the address is computed; a relative delay
   * would have to be measured from activation, which is the thing being constrained.
   */
  requireTimeWindow(
    deployment: Pick<DropDeployment, 'guardSteps'>,
    params: { notBefore?: bigint; notAfter?: bigint },
  ): DropCall {
    const notBefore = params.notBefore ?? 0n
    const notAfter = params.notAfter ?? 0n
    if (notBefore === 0n && notAfter === 0n) {
      throw new Error('requireTimeWindow needs at least one of notBefore or notAfter')
    }
    if (notBefore !== 0n && notAfter !== 0n && notAfter <= notBefore) {
      throw new Error('requireTimeWindow needs notAfter to be later than notBefore')
    }
    return stepCall(
      deployment.guardSteps,
      encodeFunctionData({
        abi: GUARD_STEPS_ABI,
        functionName: 'requireTimeWindow',
        args: [notBefore, notAfter],
      }),
      false,
    )
  },

  /** Wrap the drop's whole native balance, so natively-funded drops can trade. */
  wrapNative(
    deployment: Pick<DropDeployment, 'tokenSteps'>,
    params: { wrappedNative: Address; allowFailure?: boolean },
  ): DropCall {
    return stepCall(
      deployment.tokenSteps,
      encodeFunctionData({
        abi: TOKEN_STEPS_ABI,
        functionName: 'wrapNative',
        args: [params.wrappedNative],
      }),
      params.allowFailure,
    )
  },

  /**
   * Send the drop's whole balance of `token` to `to`. Pass the zero address as `token` to sweep the
   * native balance.
   *
   * Mostly used for rescue rather than as a recipe step — see `buildRescueTx` and
   * `buildOwnerSweepTx`. An empty balance is a no-op rather than a revert, so a rescue naming
   * several tokens moves whatever it finds.
   */
  sweep(deployment: Pick<DropDeployment, 'tokenSteps'>, params: { token: Address; to: Address }): DropCall {
    if (params.to === ZERO_ADDRESS) {
      throw new Error('sweep needs a non-zero recipient')
    }
    return stepCall(
      deployment.tokenSteps,
      encodeFunctionData({
        abi: TOKEN_STEPS_ABI,
        functionName: 'sweep',
        args: [params.token, params.to],
      }),
    )
  },

  /**
   * Allow `spender` an unlimited amount, skipping the write if it already can.
   *
   * Note that an allowance for a *literal* amount needs no step at all: `token.approve(spender, n)` is
   * an ordinary call, so it belongs in `raw`. In a recipe it is usually the wrong thing anyway — the
   * amount is committed before anything is funded, so the number will not match what arrives. The two
   * shapes that survive that are this one and `approveBalance`.
   */
  approveMax(
    deployment: Pick<DropDeployment, 'tokenSteps'>,
    params: { token: Address; spender: Address; allowFailure?: boolean },
  ): DropCall {
    return stepCall(
      deployment.tokenSteps,
      encodeFunctionData({
        abi: TOKEN_STEPS_ABI,
        functionName: 'approveMax',
        args: [params.token, params.spender],
      }),
      params.allowFailure,
    )
  },

  /**
   * Allow `spender` exactly the balance that arrived, skipping the write if it already can.
   *
   * The tight alternative to `approveMax`, and the allowance step that genuinely has to be a step: "the
   * amount that arrived" is not a literal, so no `raw` call can express it. Upward-only — a wider
   * allowance already in place is left alone rather than narrowed.
   */
  approveBalance(
    deployment: Pick<DropDeployment, 'tokenSteps'>,
    params: { token: Address; spender: Address; allowFailure?: boolean },
  ): DropCall {
    return stepCall(
      deployment.tokenSteps,
      encodeFunctionData({
        abi: TOKEN_STEPS_ABI,
        functionName: 'approveBalance',
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
