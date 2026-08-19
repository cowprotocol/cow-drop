import type { Address } from 'viem'

import type { PolicyVerdict, SubsidyPolicy } from './types.js'

/**
 * Subsidise everything, within budgets small enough to lose.
 *
 * `all` is the useful demo posture and the risky one: see the note on `SubsidyPolicy`, and treat
 * `dailyBudgetWei` as the only cap that really binds until the owner set is fixed by configuration.
 */
export const DEFAULT_POLICY: SubsidyPolicy = {
  mode: 'all',
  allowlist: [],
  denylist: [],
  maxCostPerActivationWei: 10n ** 16n, // 0.01 native
  maxFeePerGasWei: 500n * 10n ** 9n, // 500 gwei
  dailyBudgetWei: 25n * 10n ** 16n, // 0.25 native
  perOwnerDailyBudgetWei: 5n * 10n ** 16n, // 0.05 native
  minPayerBalanceWei: 2n * 10n ** 16n, // 0.02 native
}

/** Config comes in as JSON, so every wei field arrives as a string. Addresses are lowercased here. */
export function parsePolicy(raw: unknown): SubsidyPolicy {
  if (typeof raw !== 'object' || raw === null) throw new Error('policy must be a JSON object')
  const input = raw as Record<string, unknown>

  const mode = input['mode'] ?? DEFAULT_POLICY.mode
  if (mode !== 'all' && mode !== 'allowlist') {
    throw new Error(`policy.mode must be "all" or "allowlist", got ${JSON.stringify(mode)}`)
  }

  return {
    mode,
    allowlist: addresses(input['allowlist'], 'allowlist'),
    denylist: addresses(input['denylist'], 'denylist'),
    maxCostPerActivationWei: wei(input, 'maxCostPerActivationWei', DEFAULT_POLICY.maxCostPerActivationWei),
    maxFeePerGasWei: wei(input, 'maxFeePerGasWei', DEFAULT_POLICY.maxFeePerGasWei),
    dailyBudgetWei: wei(input, 'dailyBudgetWei', DEFAULT_POLICY.dailyBudgetWei),
    perOwnerDailyBudgetWei: wei(input, 'perOwnerDailyBudgetWei', DEFAULT_POLICY.perOwnerDailyBudgetWei),
    minPayerBalanceWei: wei(input, 'minPayerBalanceWei', DEFAULT_POLICY.minPayerBalanceWei),
  }
}

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

/** When a day-scoped budget resets. */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
}
