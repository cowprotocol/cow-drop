import type { Address } from 'viem'

/**
 * Comparing two addresses, the only way that is safe.
 *
 * EIP-55 casing is display metadata, not identity, so every comparison has to fold case. The repo
 * had ~25 ad-hoc spellings of that and got away with it, because none of them decided anything. One
 * helper matters now because these comparisons became *blocking*: a comparison that wrongly returns
 * false refuses a good bridge route, and one that wrongly returns true signs a bad transaction.
 *
 * **An absent address equals nothing, including another absence.** That is the bug in the ad-hoc
 * spelling: `a?.toLowerCase() === b?.toLowerCase()` reports two `undefined`s as a match, which in a
 * verification check reads as "this field agrees" when in fact neither side has a value. A response
 * that omitted a field would then pass the check that exists to compare it.
 */
export function isSameAddress(
  a: Address | string | null | undefined,
  b: Address | string | null | undefined,
): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}
