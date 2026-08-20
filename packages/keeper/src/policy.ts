import type { Address } from 'viem'

import type { PolicyVerdict, SubsidyPolicy } from './types.js'

/**
 * What a cold activation burns.
 *
 * Measured, not guessed: `test_gas_aFirstDeliveryFitsInTheQuotedLimit` puts a delivery that deploys
 * the drop *and* signs the order a little over 400k, and observed activations land near 370k. Used
 * only to size defaults — the real gas comes from simulating the actual drop.
 */
export const TYPICAL_ACTIVATION_GAS = 420_000n

/**
 * How many activations of headroom the defaults keep, and allow per transaction.
 *
 * Twenty is chosen so a keeper is never stranded mid-run by its own floor, and so a twenty-fold fee
 * spike pauses it rather than draining it. Both numbers are only meaningful in activations, which is
 * the whole point of `defaultPolicyFor`.
 */
const DEFAULT_HEADROOM = 20n

/**
 * The defaults, sized to what an activation actually costs on *this* chain.
 *
 * Two of these limits are only meaningful relative to the cost of the thing they limit, and shipping
 * them as one frozen constant made them wrong on every chain at once — in opposite directions.
 * `minPayerBalanceWei` at a flat 0.02 native is five activations of reserve on Ethereum and **six
 * thousand** on Base, where it refused to pay for a drop out of a wallet holding a thousand times the
 * gas it needed. `maxCostPerActivationWei` at a flat 0.01 native is three thousand times the real cost
 * on Base, and on Ethereum it silently refuses every activation above roughly 24 gwei — a keeper that
 * looks configured and does nothing.
 *
 * Note what is *not* scaled. `dailyBudgetWei` and `perOwnerDailyBudgetWei` stay absolute because they
 * are risk appetite rather than a technical threshold: "how much am I willing to lose in a day" is a
 * sum of money, and scaling it by gas price would quietly raise the ceiling on an expensive chain,
 * which is exactly backwards. `maxFeePerGasWei` stays absolute too — it is an anomaly guard, and a
 * tight one stalls a keeper for no safety gain since the cost cap already bounds the spend.
 */
export function defaultPolicyFor(activationCostWei: bigint): SubsidyPolicy {
  return {
    ...DEFAULT_POLICY,
    maxCostPerActivationWei: DEFAULT_HEADROOM * activationCostWei,
    minPayerBalanceWei: DEFAULT_HEADROOM * activationCostWei,
  }
}

/** One activation's cost at this gas price, for `defaultPolicyFor`. */
export function activationCostAt(maxFeePerGasWei: bigint): bigint {
  return TYPICAL_ACTIVATION_GAS * maxFeePerGasWei
}

/**
 * Subsidise everything, within budgets small enough to lose.
 *
 * `all` is the useful demo posture and the risky one: see the note on `SubsidyPolicy`, and treat
 * `dailyBudgetWei` as the only cap that really binds until the owner set is fixed by configuration.
 *
 * The two gas-sensitive numbers here are Ethereum-shaped, because a chain-blind constant has to be
 * shaped like *some* chain. Prefer `defaultPolicyFor` wherever the gas price is known — this is the
 * fallback for a caller that cannot ask.
 */
export const DEFAULT_POLICY: SubsidyPolicy = {
  mode: 'all',
  allowlist: [],
  denylist: [],
  maxCostPerActivationWei: 10n ** 16n, // 0.01 native — ~2.4 activations at 10 gwei
  maxFeePerGasWei: 500n * 10n ** 9n, // 500 gwei
  dailyBudgetWei: 25n * 10n ** 16n, // 0.25 native
  perOwnerDailyBudgetWei: 5n * 10n ** 16n, // 0.05 native
  minPayerBalanceWei: 2n * 10n ** 16n, // 0.02 native — ~4.8 activations at 10 gwei
  minFeeBps: 1,
  minRevenueRatio: 1.5,
}

/**
 * Config comes in as JSON, so every wei field arrives as a string. Addresses are lowercased here.
 *
 * `defaults` is what an omitted field falls back to. Pass the chain-sized policy, so that a file which
 * sets only `mode` still gets limits that fit the chain rather than Ethereum's.
 */
export function parsePolicy(raw: unknown, defaults: SubsidyPolicy = DEFAULT_POLICY): SubsidyPolicy {
  if (typeof raw !== 'object' || raw === null) throw new Error('policy must be a JSON object')
  const input = raw as Record<string, unknown>

  const mode = input['mode'] ?? defaults.mode
  if (mode !== 'all' && mode !== 'allowlist' && mode !== 'paying') {
    throw new Error(`policy.mode must be "all", "allowlist" or "paying", got ${JSON.stringify(mode)}`)
  }

  const feeRecipient = input['feeRecipient']
  if (feeRecipient !== undefined && (typeof feeRecipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(feeRecipient))) {
    throw new Error('policy.feeRecipient must be an address')
  }

  return {
    mode,
    allowlist: addresses(input['allowlist'], 'allowlist'),
    denylist: addresses(input['denylist'], 'denylist'),
    maxCostPerActivationWei: wei(input, 'maxCostPerActivationWei', defaults.maxCostPerActivationWei),
    maxFeePerGasWei: wei(input, 'maxFeePerGasWei', defaults.maxFeePerGasWei),
    dailyBudgetWei: wei(input, 'dailyBudgetWei', defaults.dailyBudgetWei),
    perOwnerDailyBudgetWei: wei(input, 'perOwnerDailyBudgetWei', defaults.perOwnerDailyBudgetWei),
    minPayerBalanceWei: wei(input, 'minPayerBalanceWei', defaults.minPayerBalanceWei),
    feeRecipient: feeRecipient === undefined ? undefined : (feeRecipient.toLowerCase() as Address),
    minFeeBps: positive(input, 'minFeeBps', defaults.minFeeBps),
    minRevenueRatio: positive(input, 'minRevenueRatio', defaults.minRevenueRatio),
  }
}

/** A plain positive number — bps and ratios are small, so a float is the honest type here. */
function positive(input: Record<string, unknown>, field: string, fallback: number): number {
  const value = input[field]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`policy.${field} must be a positive number`)
  }
  return value
}

/** A list of addresses, lowercased. Anything that is not one is a configuration error. */
function addresses(value: unknown, field: string): Address[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`policy.${field} must be an array of addresses`)
  return value.map((entry) => {
    if (typeof entry !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(entry)) {
      throw new Error(`policy.${field} contains something that is not an address: ${JSON.stringify(entry)}`)
    }
    return entry.toLowerCase() as Address
  })
}

/** A wei amount, as a decimal string. See below for why a JSON number will not do. */
function wei(input: Record<string, unknown>, field: string, fallback: bigint): bigint {
  const value = input[field]
  if (value === undefined) return fallback
  // A number would silently round above 2^53, which for a wei figure is most of them.
  if (typeof value !== 'string') {
    throw new Error(`policy.${field} must be a decimal string of wei, not ${typeof value}`)
  }
  if (!/^\d+$/.test(value)) throw new Error(`policy.${field} must be a whole number of wei, got "${value}"`)
  return BigInt(value)
}

export interface PolicyInput {
  policy: SubsidyPolicy
  owner: Address
  /** The fee the recipe promises, verified at registration. Absent means it promises nothing. */
  fee?: { volumeBps: number }
  /**
   * What that fee is worth right now, in wei.
   *
   * `undefined` means the sell token could not be priced — a refusal rather than a zero, because an
   * unpriceable token is one we cannot say is worth subsidising, not one we know is worthless.
   */
  revenueWei?: bigint
  /** The simulated gas, already multiplied by the safety buffer. */
  gasLimit: bigint
  maxFeePerGas: bigint
  payerBalanceWei: bigint
  spentTodayWei: bigint
  spentTodayByOwnerWei: bigint
  now: number
}

/**
 * Whether to pay for this activation.
 *
 * Pure and clockless — `now` is passed in, because the thing most worth pinning in a test is the day
 * boundary a budget rolls over on.
 *
 * Order matters. The denylist is absolute, so it comes first; the fee cap comes before the cost cap so
 * a spike reports as a spike rather than as an expensive transaction; and the budgets come last
 * because they are the only refusals that resolve by waiting.
 */
export function evaluatePolicy(input: PolicyInput): PolicyVerdict {
  const { policy, gasLimit, maxFeePerGas, payerBalanceWei, spentTodayWei, spentTodayByOwnerWei, now } = input
  const owner = input.owner.toLowerCase() as Address
  const costWei = gasLimit * maxFeePerGas

  if (policy.denylist.includes(owner)) {
    return { allowed: false, reason: 'denylisted', detail: `${owner} is on the denylist` }
  }

  if (policy.mode === 'allowlist' && !policy.allowlist.includes(owner)) {
    return { allowed: false, reason: 'not-allowlisted', detail: `${owner} is not on the allowlist` }
  }

  // The economic gate, checked before the fee and budget caps so the refusal an operator sees is the
  // interesting one: "this drop does not pay for itself", not "it is slightly over the cap".
  if (policy.mode === 'paying') {
    const refusal = payingRefusal(input, costWei)
    if (refusal) return refusal
  }

  if (maxFeePerGas > policy.maxFeePerGasWei) {
    return {
      allowed: false,
      reason: 'fee-cap-exceeded',
      detail: `${maxFeePerGas} wei/gas is above the ${policy.maxFeePerGasWei} cap`,
      // Fees fall back on their own; look again shortly rather than waiting for midnight.
      retryAt: now + 60_000,
    }
  }

  if (costWei > policy.maxCostPerActivationWei) {
    return {
      allowed: false,
      reason: 'cost-too-high',
      detail: `${costWei} wei is above the ${policy.maxCostPerActivationWei} per-activation cap`,
    }
  }

  if (payerBalanceWei - costWei < policy.minPayerBalanceWei) {
    return {
      allowed: false,
      reason: 'payer-balance-low',
      detail: `paying ${costWei} wei would leave the keeper below its ${policy.minPayerBalanceWei} floor`,
    }
  }

  if (spentTodayWei + costWei > policy.dailyBudgetWei) {
    return {
      allowed: false,
      reason: 'daily-budget-exhausted',
      detail: `${spentTodayWei} of ${policy.dailyBudgetWei} wei already spent today`,
      retryAt: nextUtcMidnight(now),
    }
  }

  // Zero disables the per-owner cap. In `all` mode it is close to decorative anyway — see the note on
  // `SubsidyPolicy` — so making it switchable off costs nothing and says so.
  if (policy.perOwnerDailyBudgetWei > 0n && spentTodayByOwnerWei + costWei > policy.perOwnerDailyBudgetWei) {
    return {
      allowed: false,
      reason: 'owner-budget-exhausted',
      detail: `${owner} has used ${spentTodayByOwnerWei} of ${policy.perOwnerDailyBudgetWei} wei today`,
      retryAt: nextUtcMidnight(now),
    }
  }

  return { allowed: true, costWei }
}

/**
 * Whether a drop earns its own gas.
 *
 * Only `volumeBps` counts as revenue — see `feeFor`. A surplus-based fee is real income and its
 * *guaranteed* value is zero, and subsidising against income that may never arrive is the thing this
 * mode exists to stop.
 */
function payingRefusal(input: PolicyInput, costWei: bigint): PolicyVerdict | undefined {
  const { policy, fee, revenueWei } = input

  if (!fee) {
    return { allowed: false, reason: 'no-fee', detail: 'the recipe promises the keeper nothing' }
  }

  if (fee.volumeBps < policy.minFeeBps) {
    return {
      allowed: false,
      reason: 'fee-too-small',
      detail: `${fee.volumeBps} bps is below the ${policy.minFeeBps} bps minimum`,
    }
  }

  if (revenueWei === undefined) {
    return { allowed: false, reason: 'unpriceable', detail: 'the order book would not price the sell token' }
  }

  // Scaled integer arithmetic: the ratio is a float and the amounts are wei.
  const required = (costWei * BigInt(Math.round(policy.minRevenueRatio * 1000))) / 1000n
  if (revenueWei < required) {
    return {
      allowed: false,
      reason: 'revenue-below-gas',
      detail: `a fee worth ${revenueWei} wei does not cover ${costWei} wei of gas at ${policy.minRevenueRatio}x`,
    }
  }

  return undefined
}

/** When a day-scoped budget resets. */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
}
