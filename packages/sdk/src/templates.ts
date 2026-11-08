import type { Address, Hex } from 'viem'

import { LATEST_GENERATION } from './generated/deployments.js'
import type { DropRecipeJson, LimitPriceJson } from './recipe.js'
import { COW_DROP_APP_DATA } from './appData.js'

/**
 * The guards every template accepts.
 *
 * Worth setting on anything one-shot. Activation is permissionless, so "nobody will trigger this early"
 * cannot be a promise made by whoever activates — it has to be committed into the address, which is
 * what these do. A guard reverts, so a premature activation is a no-op rather than a spent run.
 */
export interface RecipeGuards {
  /**
   * Refuse to activate until this much has arrived, in atomic units of the sell token.
   *
   * The one to reach for. Without it, anyone may activate the moment the first wei lands and the order
   * gets sized from a part-delivered balance — exactly what happens when a bridge pays out in tranches.
   */
  minAmount?: bigint
  /** Refuse to activate before this absolute unix timestamp. */
  notBefore?: bigint
  /**
   * Refuse to activate after this absolute unix timestamp.
   *
   * Gives a one-shot recipe an expiry, so a drop funded far too late fails loudly instead of trading at
   * a price nobody still wants. The owner's rescue path is what recovers it after that.
   */
  notAfter?: bigint
}

/** Guards that must run before anything with a side effect. */
function timeGuards(guards: RecipeGuards): DropRecipeJson['steps'] {
  if (guards.notBefore === undefined && guards.notAfter === undefined) return []
  return [
    {
      type: 'requireTimeWindow',
      notBefore: guards.notBefore?.toString(),
      notAfter: guards.notAfter?.toString(),
    },
  ]
}

/** The balance guard, which has to come *after* any wrap so it measures the token being sold. */
function balanceGuard(guards: RecipeGuards, sellToken: Address): DropRecipeJson['steps'] {
  if (guards.minAmount === undefined) return []
  return [{ type: 'requireMinBalance', token: sellToken, minAmount: guards.minAmount.toString() }]
}

/**
 * Templates: a handful of parameters in, a complete recipe out.
 *
 * These exist so the common cases never require touching the step builder. The UI's template
 * picker calls one of these and drops the result into the builder, where it can still be edited.
 */

export interface SwapOnArrivalParams extends RecipeGuards {
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
  /**
   * Improve the limit with an oracle read at activation, instead of using `limitPrice` as-is.
   *
   * `limitPrice` becomes a *floor*: the oracle may only ever tighten it. That asymmetry is the point —
   * activation is permissionless, so an activator picks the moment and therefore the oracle reading,
   * and the floor is what stops them picking a bad one.
   */
  oracle?: {
    sellTokenPriceOracle: Address
    /** Must quote the same currency as the sell-token feed. */
    buyTokenPriceOracle: Address
    /** How stale either feed may be. Defaults to an hour. */
    maxAge?: number
    /** How far below the oracle's number to set the limit, in basis points. Defaults to 50 (0.5%). */
    haircutBps?: number
  }
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

  steps.push(...timeGuards(params))

  if (params.wrapNative) {
    steps.push({ type: 'wrapNative', wrappedNative: params.wrapNative })
  }

  steps.push(...balanceGuard(params, params.sellToken))

  steps.push(
    params.oracle
      ? {
          type: 'presignSellAllAtOracle',
          sellToken: params.sellToken,
          buyToken: params.buyToken,
          receiver: params.receiver ?? params.owner,
          // The committed limit becomes the floor; the oracle may only tighten it.
          floorPrice: params.limitPrice,
          oracle: {
            sellTokenPriceOracle: params.oracle.sellTokenPriceOracle,
            buyTokenPriceOracle: params.oracle.buyTokenPriceOracle,
            maxAge: params.oracle.maxAge ?? 3600,
            haircutBps: params.oracle.haircutBps ?? 50,
          },
          validitySeconds: params.validitySeconds ?? 30 * 60,
          appData: params.appData ?? COW_DROP_APP_DATA,
        }
      : {
          type: 'presignSellAll',
          sellToken: params.sellToken,
          buyToken: params.buyToken,
          receiver: params.receiver ?? params.owner,
          limitPrice: params.limitPrice,
          validitySeconds: params.validitySeconds ?? 30 * 60,
          appData: params.appData ?? COW_DROP_APP_DATA,
        },
  )

  return {
    version: 1,
    generation: LATEST_GENERATION,
    label: params.label ?? (params.oracle ? 'swap on arrival at oracle' : 'swap on arrival'),
    chainId: params.chainId,
    owner: params.owner,
    salt: params.salt,
    once: false,
    steps,
  }
}

export interface StopLossOnArrivalParams extends RecipeGuards {
  chainId: number
  owner: Address
  sellToken: Address
  buyToken: Address
  /** Where the bought tokens go. Defaults to the owner — see `SwapOnArrivalParams.receiver`. */
  receiver?: Address
  salt?: Hex
  /**
   * The minimum output, applied to whatever arrived. Distinct from `strike`: the strike decides *when*
   * to sell, this decides how bad a fill is refused. A stop-loss without a sane limit is a market order
   * into whatever liquidity happens to exist at the worst moment.
   */
  limitPrice: LimitPriceJson
  /** How long the order stays live once activated. Measured from activation, not from authoring. */
  validitySeconds: number
  sellTokenPriceOracle: Address
  /** Must quote the same currency as the sell-token feed. */
  buyTokenPriceOracle: Address
  /**
   * Fires when `sellTokenPrice / buyTokenPrice <= strike`, scaled to 18 decimals. "Sell my WXDAI if it
   * drops below 1.8 COW" is `1800000000000000000n`.
   */
  strike: bigint
  /** How stale either feed may be. Defaults to an hour. */
  maxTimeSinceLastOracleUpdate?: number
  partiallyFillable?: boolean
  label?: string
  appData?: Hex
  wrapNative?: Address
}

/**
 * The stop-loss recipe: whatever lands here is sold once the pair crosses a strike.
 *
 * Uses the composable path, so after a single activation the watch tower polls the condition and posts
 * the order itself. That is what separates this from a price *guard*: a guard can only refuse at the
 * wrong moment and needs somebody watching to retry, whereas this sits registered and fires itself.
 *
 * `once` is true: re-running would register a second overlapping stop-loss over the remaining balance.
 */
export function stopLossOnArrival(params: StopLossOnArrivalParams): DropRecipeJson {
  const steps: DropRecipeJson['steps'] = []

  steps.push(...timeGuards(params))

  if (params.wrapNative) {
    steps.push({ type: 'wrapNative', wrappedNative: params.wrapNative })
  }

  steps.push(...balanceGuard(params, params.sellToken))

  steps.push({
    type: 'stopLossFromBalance',
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    receiver: params.receiver ?? params.owner,
    limitPrice: params.limitPrice,
    validitySeconds: params.validitySeconds,
    trigger: {
      sellTokenPriceOracle: params.sellTokenPriceOracle,
      buyTokenPriceOracle: params.buyTokenPriceOracle,
      strike: params.strike.toString(),
      maxTimeSinceLastOracleUpdate: params.maxTimeSinceLastOracleUpdate ?? 3600,
    },
    partiallyFillable: params.partiallyFillable,
    appData: params.appData ?? COW_DROP_APP_DATA,
  })

  return {
    version: 1,
    generation: LATEST_GENERATION,
    label: params.label ?? 'stop-loss on arrival',
    chainId: params.chainId,
    owner: params.owner,
    salt: params.salt,
    once: true,
    steps,
  }
}

export interface TwapOnArrivalParams extends RecipeGuards {
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
   * Strongly recommended here. This recipe is one-shot by default, so without a floor anyone may
   * activate it the moment the first wei lands and the whole schedule gets sized from a
   * part-delivered balance — which is exactly what happens if a bridge pays out in tranches. The
   * guard reverts, so an early activation is a no-op rather than a spent run.
   *
   * Required when `reusableAfter` is set, where it stops a third party re-activating on dust.
   */
  /**
   * Make the address reusable, with a cooldown between activations. Omit it for the one-shot
   * default.
   *
   * `true` is the setting to want: a cooldown of `parts * partDuration`, the schedule's own length.
   * By the time the window reopens the previous TWAP has run out of parts, so the drop takes the
   * next arrival without ever holding two live schedules over one balance. A number sets the
   * cooldown in seconds, and cannot be shorter than the schedule.
   *
   * Setting this changes the drop address, because it adds a step. A recipe written without it keeps
   * resolving exactly where it did.
   */
  reusableAfter?: number | true
}

/**
 * The TWAP recipe: whatever lands here is split into `parts` and sold over time.
 *
 * Uses the composable path, so after a single activation the drop is self-driving — the watch tower
 * posts each part as it becomes tradeable, with nobody signing anything.
 *
 * `once` is true by default: re-running would register a *second* overlapping TWAP against the
 * remaining balance, which is almost never what someone means. `reusableAfter` is the other way to
 * avoid that — a cooldown instead of a single run, so the address keeps working for the next arrival
 * while still only ever holding one live schedule.
 */
export function twapOnArrival(params: TwapOnArrivalParams): DropRecipeJson {
  const steps: DropRecipeJson['steps'] = []

  const schedule = params.parts * params.partDuration
  const cooldownSeconds = params.reusableAfter === true ? schedule : params.reusableAfter
  if (cooldownSeconds !== undefined) {
    // Shorter than the schedule and the two TWAPs overlap, which is the thing the cooldown exists to
    // prevent. Hand-build the recipe if overlap is genuinely wanted.
    if (cooldownSeconds < schedule) {
      throw new Error(
        `reusableAfter is ${cooldownSeconds}s but the schedule runs for ${schedule}s ` +
          `(${params.parts} x ${params.partDuration}s): the next activation would register a second ` +
          `TWAP while the first is still live. Use at least ${schedule}, or true for exactly that.`,
      )
    }
    // Activation is permissionless and the claim is what paces it, so without a floor anyone can
    // re-activate on dust the moment the window opens and push the next real one out by a full
    // cooldown. The balance guard runs first and reverts, which rolls the claim back with it.
    if (params.minAmount === undefined) {
      throw new Error(
        'a reusable TWAP needs minAmount: without it anyone can re-activate on dust the moment the ' +
          'cooldown expires and push the next activation out by another full cooldown.',
      )
    }
  }

  // Guards go first, before anything has side effects.
  steps.push(...timeGuards(params))

  if (params.wrapNative) {
    steps.push({ type: 'wrapNative', wrappedNative: params.wrapNative })
  }

  // After wrapping, so a native-funded drop is measured in the token it will actually sell.
  steps.push(...balanceGuard(params, params.sellToken))

  // After the balance guard, so a dust activation reverts before it can claim the window.
  if (cooldownSeconds !== undefined) {
    steps.push({ type: 'claimCooldown', cooldownSeconds })
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
    appData: params.appData ?? COW_DROP_APP_DATA,
  })

  return {
    version: 1,
    generation: LATEST_GENERATION,
    label: params.label ?? `twap ${params.parts} parts`,
    chainId: params.chainId,
    owner: params.owner,
    salt: params.salt,
    // A cooldown replaces `once` rather than joining it: `once` is checked first and would spend the
    // single run regardless, leaving the cooldown gating nothing. `compileRecipe` refuses the pair.
    once: cooldownSeconds === undefined,
    steps,
  }
}

export interface PaymentRequestParams extends Omit<RecipeGuards, 'minAmount'> {
  chainId: number
  owner: Address
  /** The token the receiver is paid in. */
  buyToken: Address
  /** The price, in `buyToken` atoms: the least the receiver gets per payment. */
  buyAmount: bigint
  /** Who is paid. Defaults to the owner. */
  receiver?: Address
  /** Lifetime of each payment's order, from its activation. Defaults to 30 minutes. */
  validitySeconds?: number
  appData?: Hex
  label?: string
  salt?: Hex
}

export interface ConvertOnArrivalParams extends Omit<RecipeGuards, 'minAmount'> {
  chainId: number
  owner: Address
  salt?: Hex
  /** The token everything is converted into. */
  buyToken: Address
  /** Who receives it. Defaults to the owner. */
  receiver?: Address
  /**
   * The only address allowed to activate, or zero for anyone.
   *
   * Nothing in the recipe fixes a price — the activator names the order's minimum each time — so this
   * is what stops a stranger naming one atom. Zero is a deliberate opt-out that leaves the price to
   * CoW's solver competition.
   */
  pricer?: Address
  /** Order lifetime from activation. Defaults to 30 minutes. */
  validitySeconds?: number
  label?: string
  appData?: Hex
}

/**
 * "Whatever lands here, sell it for `buyToken`": a reusable address priced fresh at each activation.
 *
 * Like `paymentRequest` it names no sell token, but it commits no price either — the activator names
 * the order's minimum (`buildActivateConvertTx`). That is what `pricer` guards: only it or the owner
 * may activate, because `setupData` is public and a stranger would otherwise name one atom. A zero
 * `pricer` opts out and leaves the price to CoW's solver competition alone.
 *
 * Reusable, and with no balance guard: the sell token is unknown until activation, so there is
 * nothing to measure.
 */
export function convertOnArrival(params: ConvertOnArrivalParams): DropRecipeJson {
  return {
    version: 1,
    generation: LATEST_GENERATION,
    label: params.label ?? 'convert on arrival',
    chainId: params.chainId,
    owner: params.owner,
    salt: params.salt,
    // Reusable by design: each arrival is its own activation.
    once: false,
    steps: [
      ...timeGuards(params),
      {
        type: 'convert',
        buyToken: params.buyToken,
        receiver: params.receiver ?? params.owner,
        pricer: params.pricer ?? '0x0000000000000000000000000000000000000000',
        validitySeconds: params.validitySeconds ?? 30 * 60,
        appData: params.appData ?? COW_DROP_APP_DATA,
      },
    ],
  }
}

/**
 * "Pay me `buyAmount` of `buyToken`, in any token": a reusable address a payer funds with whatever they
 * hold.
 *
 * The recipe names no sell token. Whoever activates names it — `buildActivatePaymentTx` — and the drop
 * sells its whole balance of that token for at least `buyAmount`, paid to the receiver. A payer is told
 * how much to send by a buy quote for `buyAmount` (see `requiredPayment`); any surplus over the price is
 * the receiver's, because the order is a sell.
 *
 * Reusable rather than one-shot, so the same address can take one payment after another. No minimum
 * balance guard: the sell token is unknown, so there is nothing to measure — the price is the guard.
 */
export function paymentRequest(params: PaymentRequestParams): DropRecipeJson {
  return {
    version: 1,
    generation: LATEST_GENERATION,
    label: params.label ?? 'payment request',
    chainId: params.chainId,
    owner: params.owner,
    salt: params.salt,
    once: false,
    steps: [
      ...timeGuards(params),
      {
        type: 'payment',
        buyToken: params.buyToken,
        buyAmount: params.buyAmount.toString(),
        receiver: params.receiver ?? params.owner,
        validitySeconds: params.validitySeconds ?? 30 * 60,
        appData: params.appData ?? COW_DROP_APP_DATA,
      },
    ],
  }
}
