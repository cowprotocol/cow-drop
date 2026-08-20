import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_POLICY,
  TYPICAL_ACTIVATION_GAS,
  activationCostAt,
  defaultPolicyFor,
  evaluatePolicy,
  nextUtcMidnight,
  parsePolicy,
} from './policy.js'
import type { SubsidyPolicy } from './types.js'

const OWNER: Address = '0x00000000000000000000000000000000000a11ce'
const STRANGER: Address = '0x00000000000000000000000000000000000b0b00'
const NOON = Date.UTC(2026, 0, 15, 12, 0, 0)

const GWEI = 10n ** 9n

function evaluate(overrides: {
  policy?: Partial<SubsidyPolicy>
  owner?: Address
  fee?: { volumeBps: number }
  revenueWei?: bigint
  gasLimit?: bigint
  maxFeePerGas?: bigint
  payerBalanceWei?: bigint
  spentTodayWei?: bigint
  spentTodayByOwnerWei?: bigint
  now?: number
} = {}) {
  return evaluatePolicy({
    policy: { ...DEFAULT_POLICY, ...overrides.policy },
    owner: overrides.owner ?? OWNER,
    fee: overrides.fee,
    revenueWei: overrides.revenueWei,
    gasLimit: overrides.gasLimit ?? 300_000n,
    maxFeePerGas: overrides.maxFeePerGas ?? GWEI,
    payerBalanceWei: overrides.payerBalanceWei ?? 10n ** 18n,
    spentTodayWei: overrides.spentTodayWei ?? 0n,
    spentTodayByOwnerWei: overrides.spentTodayByOwnerWei ?? 0n,
    now: overrides.now ?? NOON,
  })
}

describe('evaluatePolicy', () => {
  it('pays for a stranger in "all" mode', () => {
    expect(evaluate({ owner: STRANGER })).toEqual({ allowed: true, costWei: 300_000n * GWEI })
  })

  it('pays only for the allowlist in "allowlist" mode', () => {
    const policy = { mode: 'allowlist' as const, allowlist: [OWNER] }

    expect(evaluate({ policy }).allowed).toBe(true)
    expect(evaluate({ policy, owner: STRANGER })).toMatchObject({ allowed: false, reason: 'not-allowlisted' })
  })

  it('matches the allowlist whatever the casing', () => {
    const policy = { mode: 'allowlist' as const, allowlist: [OWNER] }
    expect(evaluate({ policy, owner: OWNER.toUpperCase().replace('0X', '0x') as Address }).allowed).toBe(true)
  })

  it('lets the denylist beat either mode', () => {
    expect(evaluate({ policy: { denylist: [OWNER] } })).toMatchObject({ allowed: false, reason: 'denylisted' })
    expect(
      evaluate({ policy: { mode: 'allowlist', allowlist: [OWNER], denylist: [OWNER] } }),
    ).toMatchObject({ allowed: false, reason: 'denylisted' })
  })

  it('caps the cost in wei, so the same gas is refused in a fee spike', () => {
    // The whole reason the cap is not in gas units: 300k gas is cheap at 1 gwei and not at 200.
    const policy = { maxCostPerActivationWei: 10n ** 15n, maxFeePerGasWei: 1000n * GWEI }

    expect(evaluate({ policy, maxFeePerGas: GWEI }).allowed).toBe(true)
    expect(evaluate({ policy, maxFeePerGas: 200n * GWEI })).toMatchObject({
      allowed: false,
      reason: 'cost-too-high',
    })
  })

  it('reports a fee spike as a spike, and retries in a minute rather than at midnight', () => {
    // Fees fall back on their own, so this refusal resolves by waiting a little, not a lot.
    const result = evaluate({ policy: { maxFeePerGasWei: 50n * GWEI }, maxFeePerGas: 500n * GWEI })

    expect(result).toMatchObject({ allowed: false, reason: 'fee-cap-exceeded' })
    if (result.allowed) return
    expect(result.retryAt).toBe(NOON + 60_000)
  })

  it('refuses to spend the payer below its floor', () => {
    // So the key can be topped up before a run is left half-finished.
    const result = evaluate({ policy: { minPayerBalanceWei: 10n ** 17n }, payerBalanceWei: 10n ** 17n })

    expect(result).toMatchObject({ allowed: false, reason: 'payer-balance-low' })
  })

  it('admits a spend that exactly fills the daily budget, and refuses one wei more', () => {
    const cost = 300_000n * GWEI
    const policy = { dailyBudgetWei: cost, perOwnerDailyBudgetWei: 0n }

    expect(evaluate({ policy, spentTodayWei: 0n }).allowed).toBe(true)
    expect(evaluate({ policy, spentTodayWei: 1n })).toMatchObject({
      allowed: false,
      reason: 'daily-budget-exhausted',
    })
  })

  it('rolls the daily budget at the next UTC midnight', () => {
    const result = evaluate({ policy: { dailyBudgetWei: 0n }, now: NOON })

    expect(result).toMatchObject({ allowed: false, reason: 'daily-budget-exhausted' })
    if (result.allowed) return
    expect(result.retryAt).toBe(Date.UTC(2026, 0, 16))
  })

  it('rolls to the very next day when it is a minute to midnight', () => {
    const nearly = Date.UTC(2026, 0, 15, 23, 59, 0)
    const result = evaluate({ policy: { dailyBudgetWei: 0n }, now: nearly })

    if (result.allowed) return
    expect(result.retryAt).toBe(Date.UTC(2026, 0, 16))
  })

  it('applies the per-owner budget, and treats zero as off', () => {
    const spent = 300_000n * GWEI
    expect(evaluate({ policy: { perOwnerDailyBudgetWei: spent }, spentTodayByOwnerWei: 1n })).toMatchObject({
      allowed: false,
      reason: 'owner-budget-exhausted',
    })
    expect(evaluate({ policy: { perOwnerDailyBudgetWei: 0n }, spentTodayByOwnerWei: 10n ** 18n }).allowed).toBe(true)
  })

  it('checks the global budget before the per-owner one', () => {
    // Both are exhausted; the global refusal is the one an operator needs to see.
    const result = evaluate({
      policy: { dailyBudgetWei: 0n, perOwnerDailyBudgetWei: 1n },
      spentTodayWei: 10n ** 18n,
      spentTodayByOwnerWei: 10n ** 18n,
    })

    expect(result).toMatchObject({ reason: 'daily-budget-exhausted' })
  })
})

describe('parsePolicy', () => {
  it('reads wei as decimal strings', () => {
    const policy = parsePolicy({ mode: 'all', dailyBudgetWei: '1000000000000000000' })
    expect(policy.dailyBudgetWei).toBe(10n ** 18n)
  })

  it('refuses a number where wei is expected', () => {
    // A JSON number silently rounds above 2^53, which for a wei figure is most of them.
    expect(() => parsePolicy({ dailyBudgetWei: 1e18 })).toThrow(/decimal string/)
  })

  it('refuses a fractional or negative amount', () => {
    expect(() => parsePolicy({ dailyBudgetWei: '-1' })).toThrow(/whole number/)
    expect(() => parsePolicy({ dailyBudgetWei: '1.5' })).toThrow(/whole number/)
  })

  it('lowercases the address lists so comparison never depends on checksum', () => {
    const policy = parsePolicy({ mode: 'allowlist', allowlist: ['0x00000000000000000000000000000000000A11CE'] })
    expect(policy.allowlist).toEqual([OWNER])
  })

  it('refuses an unknown mode and a non-address entry', () => {
    expect(() => parsePolicy({ mode: 'everyone' })).toThrow(/mode/)
    expect(() => parsePolicy({ allowlist: ['nope'] })).toThrow(/not an address/)
  })

  it('falls back to the defaults for anything absent', () => {
    expect(parsePolicy({})).toEqual(DEFAULT_POLICY)
  })
})

describe('nextUtcMidnight', () => {
  it('is the following day at 00:00 UTC', () => {
    expect(nextUtcMidnight(Date.UTC(2026, 0, 15, 0, 0, 0))).toBe(Date.UTC(2026, 0, 16))
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe(Date.UTC(2027, 0, 1))
  })
})

describe('paying mode', () => {
  const FEE = { volumeBps: 10 }
  const paying = { mode: 'paying' as const, minFeeBps: 5, minRevenueRatio: 1.5 }
  const cost = 300_000n * GWEI

  it('pays when the fee is worth comfortably more than the gas', () => {
    expect(evaluate({ policy: paying, fee: FEE, revenueWei: cost * 2n }).allowed).toBe(true)
  })

  it('refuses a recipe that promises nothing', () => {
    // The hole this mode closes: in `all` mode this drop would be subsidised for free.
    expect(evaluate({ policy: paying, revenueWei: cost * 100n })).toMatchObject({
      allowed: false,
      reason: 'no-fee',
    })
  })

  it('refuses a fee below the minimum, however valuable', () => {
    expect(evaluate({ policy: paying, fee: { volumeBps: 1 }, revenueWei: cost * 100n })).toMatchObject({
      allowed: false,
      reason: 'fee-too-small',
    })
  })

  it('refuses a token the order book will not price', () => {
    // Undefined is "we cannot say it is worth subsidising", not "it is worth nothing".
    expect(evaluate({ policy: paying, fee: FEE, revenueWei: undefined })).toMatchObject({
      allowed: false,
      reason: 'unpriceable',
    })
  })

  it('refuses revenue that only just covers the gas', () => {
    // The ratio sits above 1 because the amount can shrink and the price can move before the fill.
    expect(evaluate({ policy: paying, fee: FEE, revenueWei: cost })).toMatchObject({
      allowed: false,
      reason: 'revenue-below-gas',
    })
    expect(evaluate({ policy: paying, fee: FEE, revenueWei: (cost * 3n) / 2n }).allowed).toBe(true)
  })

  it('reports paying its own way before it reports being over a cap', () => {
    // An operator reading the log wants "this drop does not pay for itself", not "slightly over".
    const result = evaluate({
      policy: { ...paying, maxCostPerActivationWei: 1n },
      fee: FEE,
      revenueWei: 0n,
    })

    expect(result).toMatchObject({ reason: 'revenue-below-gas' })
  })

  it('still lets the denylist refuse a paying drop', () => {
    expect(
      evaluate({ policy: { ...paying, denylist: [OWNER] }, fee: FEE, revenueWei: cost * 100n }),
    ).toMatchObject({ reason: 'denylisted' })
  })

  it('leaves the budgets in place as a backstop', () => {
    expect(
      evaluate({ policy: { ...paying, dailyBudgetWei: 0n }, fee: FEE, revenueWei: cost * 100n }),
    ).toMatchObject({ reason: 'daily-budget-exhausted' })
  })
})

describe('defaultPolicyFor', () => {
  // Roughly what these chains charge. Only the order of magnitude matters, which is the point.
  const BASE_GWEI = 10n ** 7n // 0.01 gwei
  const ETHEREUM_GWEI = 10n * 10n ** 9n

  const baseCost = activationCostAt(BASE_GWEI)
  const ethereumCost = activationCostAt(ETHEREUM_GWEI)

  /**
   * The bug this function exists for.
   *
   * A flat 0.02 native floor is a few activations of reserve on Ethereum and thousands on Base, where
   * it refused to pay for a drop out of a wallet holding a thousand times the gas it needed. Sized in
   * activations, the same policy is sane on both.
   */
  it('keeps the same reserve in activations on chains three orders of magnitude apart', () => {
    for (const cost of [baseCost, ethereumCost]) {
      const policy = defaultPolicyFor(cost)
      expect(policy.minPayerBalanceWei / cost).toBe(20n)
      expect(policy.maxCostPerActivationWei / cost).toBe(20n)
    }

    // And they are genuinely different absolute numbers, or nothing has been fixed.
    expect(defaultPolicyFor(baseCost).minPayerBalanceWei).toBeLessThan(
      defaultPolicyFor(ethereumCost).minPayerBalanceWei,
    )
  })

  /**
   * The other half of the same bug, in the opposite direction: the flat 0.01 native per-activation cap
   * silently refuses every Ethereum activation above roughly 24 gwei — a keeper that looks configured
   * and does nothing.
   */
  it('does not refuse an ordinary activation on an expensive chain', () => {
    const busy = activationCostAt(60n * 10n ** 9n)

    expect(busy).toBeGreaterThan(DEFAULT_POLICY.maxCostPerActivationWei)
    expect(defaultPolicyFor(busy).maxCostPerActivationWei).toBeGreaterThan(busy)
  })

  /**
   * Risk appetite is a sum of money, not a multiple of gas. Scaling a daily budget by gas price would
   * quietly raise the ceiling on the expensive chain, which is exactly backwards.
   */
  it('leaves the budgets and the fee cap absolute', () => {
    const policy = defaultPolicyFor(baseCost)

    expect(policy.dailyBudgetWei).toBe(DEFAULT_POLICY.dailyBudgetWei)
    expect(policy.perOwnerDailyBudgetWei).toBe(DEFAULT_POLICY.perOwnerDailyBudgetWei)
    expect(policy.maxFeePerGasWei).toBe(DEFAULT_POLICY.maxFeePerGasWei)
    expect(policy.mode).toBe('all')
  })

  it('sizes an activation from the measured gas', () => {
    expect(activationCostAt(2n)).toBe(TYPICAL_ACTIVATION_GAS * 2n)
  })
})

describe('parsePolicy defaults', () => {
  /**
   * A file that sets only `mode` must not silently inherit Ethereum-shaped limits on Base. This is how
   * the chain-sized defaults reach anyone who writes a partial policy — which is most people.
   */
  it('falls back to the chain-sized limits for omitted fields', () => {
    const defaults = defaultPolicyFor(activationCostAt(10n ** 7n))
    const parsed = parsePolicy({ mode: 'all' }, defaults)

    expect(parsed.minPayerBalanceWei).toBe(defaults.minPayerBalanceWei)
    expect(parsed.maxCostPerActivationWei).toBe(defaults.maxCostPerActivationWei)
  })

  it('still lets a file override them outright', () => {
    const defaults = defaultPolicyFor(activationCostAt(10n ** 7n))
    const parsed = parsePolicy({ minPayerBalanceWei: '7' }, defaults)

    expect(parsed.minPayerBalanceWei).toBe(7n)
    expect(parsed.maxCostPerActivationWei).toBe(defaults.maxCostPerActivationWei)
  })

  it('keeps the Ethereum-shaped constant as the no-chain-info fallback', () => {
    expect(parsePolicy({}).minPayerBalanceWei).toBe(DEFAULT_POLICY.minPayerBalanceWei)
  })
})
