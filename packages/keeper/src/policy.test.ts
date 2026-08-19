import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'

import { DEFAULT_POLICY, evaluatePolicy, nextUtcMidnight, parsePolicy } from './policy.js'
import type { SubsidyPolicy } from './types.js'

const OWNER: Address = '0x00000000000000000000000000000000000a11ce'
const STRANGER: Address = '0x00000000000000000000000000000000000b0b00'
const NOON = Date.UTC(2026, 0, 15, 12, 0, 0)

const GWEI = 10n ** 9n

function evaluate(overrides: {
  policy?: Partial<SubsidyPolicy>
  owner?: Address
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
