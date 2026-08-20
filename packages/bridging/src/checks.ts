import { isSameAddress } from '@cowprotocol/cow-drop-sdk'
import type { Address, Hex } from 'viem'

import type { DestinationExecution } from './bungee/capability.js'

/**
 * The vocabulary for checking a bridge's answer against what we asked it for.
 *
 * Provider-agnostic on purpose: the checks themselves are Bungee-shaped (see `bungee/verify.ts`), but
 * the way a verdict is expressed should not be, because the next provider's answers need checking
 * too.
 *
 * ## The rule for classifying a check
 *
 * A check is **blocking** iff it compares a value *we chose* against the same value *echoed back or
 * embedded verbatim*, in a place where a mismatch cannot be a legitimate encoding. Everything else —
 * encodings, amounts, clocks — is **advisory**: shown, never gating.
 *
 * The asymmetry is deliberate and it cuts both ways. A blocking check that wrongly trips makes a good
 * route unusable, which is an outage we caused; an advisory check that should have blocked is how
 * money leaves. So every blocking check needs an argument for why *absence means what we think it
 * means*, and each one carries that argument at its definition site.
 */

/** Whether a failure stops the send. `blocking` means impossible, not greyed out. */
export type CheckSeverity = 'blocking' | 'advisory'

/**
 * A failed check, carrying the values that disagreed.
 *
 * Discriminated on `check` and carrying the compared pair, the way `RegistrationError`'s
 * `address-mismatch` carries `supplied`/`derived` — so a caller can word its own sentence, and a test
 * can assert on the fact rather than on prose.
 */
export type CheckProblem =
  // Route eligibility, from the quote response alone.
  | { check: 'destination-execution'; bridge: string; execution: DestinationExecution }
  | { check: 'output-token'; requested: Address; quoted: Address }
  | { check: 'output-chain'; requested: number; quoted: number }
  | { check: 'input-token'; requested: Address; quoted: Address }
  | { check: 'input-amount'; requested: bigint; quoted: bigint }
  | { check: 'receiver-echo'; requested: Address; echoed: Address }
  | { check: 'user-echo'; requested: Address; echoed: Address }
  | { check: 'route-expiry'; expiresAt: number; now: number }
  // The built transaction.
  | { check: 'tx-chain'; requested: number; built: number }
  | { check: 'receiver-in-calldata'; receiver: Address; calldataBytes: number }
  | { check: 'payload-in-calldata'; payloadBytes: number; calldataBytes: number }
  | { check: 'calldata-length'; calldataBytes: number; leastPossible: number }
  | { check: 'sell-amount-in-calldata'; amount: bigint }
  | { check: 'approval-token'; expected: Address; actual: Address }
  | { check: 'approval-user'; expected: Address; actual: Address }
  | { check: 'approval-amount'; expected: bigint; actual: bigint }
  | { check: 'route-identity'; quotedSpender: Address; builtSpender: Address }
  | { check: 'direct-receiver'; receiver: Address; predicted: Address }
  | { check: 'delivery-target'; reason: string }

export type CheckId = CheckProblem['check']

/**
 * One check, in the shape a UI row renders directly.
 *
 * Four states, and the two in the middle are the reason this is not a boolean.
 *
 * - `pass` — checked, and it agrees.
 * - `fail` — checked, and it does not.
 * - `unknown` — **could not be determined.** A real answer, and the one a boolean has nowhere to put:
 *   it would have to render as a pass, which is the lie that strands money, or as a failure, which
 *   cries wolf. A blocking check that is `unknown` stops the send, because "we could not tell" is not
 *   permission.
 * - `not-applicable` — **the question does not arise here.** Direct delivery carries no payload, so
 *   "is the payload in the calldata" has no answer and needs none. This must never block anything.
 *
 * Keeping those last two apart matters more than it looks. Collapsing them means either an
 * undeterminable allowance silently permits a send, or a mode that legitimately skips a check can
 * never send at all — and both bugs look like the other one from the outside.
 *
 * `detail` is written at the comparison site so the sentence and the comparison cannot drift apart,
 * and so the reason a route is disabled is prose this library owns rather than prose React invents.
 * `where` is the byte offset a structural check found its needle at — the one piece of information
 * that makes "the drop address is in the calldata" checkable by a human against a block explorer.
 */
export type CheckOutcome =
  | { check: CheckId; severity: CheckSeverity; state: 'pass'; detail: string; where?: number }
  | { check: CheckId; severity: CheckSeverity; state: 'not-applicable'; detail: string }
  | { check: CheckId; severity: CheckSeverity; state: 'unknown'; detail: string }
  | { check: CheckId; severity: CheckSeverity; state: 'fail'; detail: string; problem: CheckProblem }

export type CheckFailure = Extract<CheckOutcome, { state: 'fail' }>

/** A check that did not pass and cannot be waved through: it failed, or it could not be determined. */
export type CheckBlocker = Extract<CheckOutcome, { state: 'fail' | 'unknown' }>

/** Narrows to the failure side. Mirrors `isProblem` in the keeper's appData module. */
export function isFailure(outcome: CheckOutcome): outcome is CheckFailure {
  return outcome.state === 'fail'
}

/**
 * Narrows to "did not pass, and not because the question was moot".
 *
 * This is the predicate a gate must use. `state !== 'pass'` is the tempting spelling and it is wrong —
 * it swallows `not-applicable`, which makes every mode that legitimately skips a check unsendable.
 */
export function isBlocker(outcome: CheckOutcome): outcome is CheckBlocker {
  return outcome.state === 'fail' || outcome.state === 'unknown'
}

export interface Verification {
  /** Every check, in display order: what stops you, then what should worry you, then the rest. */
  checks: readonly CheckOutcome[]
  /** False if any blocking check failed or could not be determined. Nothing may be signed while false. */
  sendable: boolean
  /** Blocking checks that did not pass. Non-empty means un-sendable, full stop. */
  blocking: readonly CheckBlocker[]
  /** Advisory checks that did not pass. Worth reading; never a reason to refuse. */
  advisories: readonly CheckBlocker[]
}

/**
 * The order a reader needs: what stops you, then what should worry you, then the rest.
 *
 * Ranked by consequence rather than by state, which is not the same sort. A blocking check that could
 * not be determined outranks an advisory that outright failed, because the first one is why the button
 * does not work and the second is a note. Sorting on state alone buries it below the note.
 */
function rank(check: CheckOutcome): number {
  if (isBlocker(check)) return check.severity === 'blocking' ? 0 : 1
  return check.state === 'pass' ? 2 : 3
}

/**
 * The one place a verdict is computed.
 *
 * Callers must not re-derive this. The web app did, with `state !== 'pass'`, and produced a screen that
 * refused every direct-mode transaction while this function called the same quote sendable — the
 * failure mode being that the button and the evidence beside it disagreed, which is worse than either
 * being wrong alone. Merge extra checks into the list and call this again instead.
 */
export function summarise(checks: readonly CheckOutcome[]): Verification {
  const unresolved = checks.filter(isBlocker)

  // Failures before undeterminables within the same rank: a mismatch is more actionable than an
  // unanswered RPC, and it is the one that names two values a reader can compare.
  const ordered = [...checks].sort((a, b) => rank(a) - rank(b) || Number(a.state === 'unknown') - Number(b.state === 'unknown'))

  const blocking = unresolved.filter((check) => check.severity === 'blocking')

  return {
    checks: ordered,
    sendable: blocking.length === 0,
    blocking,
    advisories: unresolved.filter((check) => check.severity === 'advisory'),
  }
}

/**
 * One sentence for the first blocking failure.
 *
 * Owned here rather than in a UI so that a disabled route row and a refused send cannot word the same
 * fact differently — which is how a user ends up believing they are two separate problems.
 */
export function blockingSummary(verification: Verification): string | undefined {
  return verification.blocking[0]?.detail
}

/**
 * Which checks failed on *every* route.
 *
 * When a structural check fails identically across a whole route set, the fault is far more likely
 * ours than the provider's: six routes do not break at once, but a response encoding does. This is
 * what lets a UI say "this may be a stale check on our side" instead of leaving someone to conclude
 * the app is broken. There is deliberately no override — the remedy is a fix, not a click — so being
 * able to *name* the situation is the whole mitigation.
 */
export function checksFailingEverywhere(verifications: readonly Verification[]): CheckId[] {
  const [first, ...rest] = verifications
  if (!first) return []

  return first.blocking
    .map((failure) => failure.check)
    .filter((check) =>
      rest.every((verification) => verification.blocking.some((failure) => failure.check === check)),
    )
}

// ---------------------------------------------------------------------------------------------
// Calldata primitives
// ---------------------------------------------------------------------------------------------

/**
 * Where `needle`'s bytes occur in `haystack`, or null.
 *
 * **Byte-aligned: only even hex indices are considered.** A plain `indexOf` on a hex string can match
 * starting at an odd nibble, which is not an occurrence of those bytes at all — `0x0abc` "contains"
 * `0xabc0`'s nibbles without containing its bytes. Accepting one of those would make a *blocking*
 * check pass wrongly, which is the single worst bug this module could have.
 *
 * Returns a byte offset counted from the start of the calldata, selector included, because that is
 * the number a human can check against a block explorer's decoded view.
 */
export function findBytes(haystack: Hex, needle: Hex): { offset: number } | null {
  const hay = haystack.slice(2).toLowerCase()
  const pin = needle.slice(2).toLowerCase()
  if (pin.length === 0 || pin.length > hay.length) return null

  for (let index = hay.indexOf(pin); index !== -1; index = hay.indexOf(pin, index + 1)) {
    if (index % 2 === 0) return { offset: index / 2 }
  }
  return null
}

/** `findBytes` for an address, which is its 20 bytes wherever they sit — padded, packed, or bare. */
export function findAddress(calldata: Hex, address: Address): { offset: number } | null {
  return findBytes(calldata, `0x${address.slice(2)}`)
}

/** How an amount turned up in the calldata. Which form matched is worth reporting, so it is returned. */
export type AmountForm = 'word' | 'packed' | 'value'

/**
 * Where an amount occurs, in any of the forms a router legitimately uses.
 *
 * Tries the 32-byte left-padded word first, then the minimal-byte packing. `value` is not searched for
 * here — the caller compares that directly — but it shares the return type so one check can report
 * all three.
 */
export function findAmount(calldata: Hex, amount: bigint): { offset: number; form: AmountForm } | null {
  const hex = amount.toString(16)

  const word = findBytes(calldata, `0x${hex.padStart(64, '0')}`)
  if (word) return { ...word, form: 'word' }

  // Minimal-byte: whole bytes only, so an odd-length hex string pads to the next byte.
  const packed = findBytes(calldata, `0x${hex.length % 2 === 0 ? hex : `0${hex}`}`)
  if (packed) return { ...packed, form: 'packed' }

  return null
}

/**
 * The pseudo-addresses bridges use for a chain's native token.
 *
 * Bungee, Across and LiFi all spell it `0xEeee…`; some routes answer with the zero address. Both mean
 * the same asset, so a token comparison that did not fold them would refuse every native route — a
 * safety change quietly making native bridging impossible, which arrives as "the app is broken".
 */
const NATIVE_SENTINELS = ['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '0x0000000000000000000000000000000000000000']

/** Is this address a stand-in for the chain's native token? */
export function isNativeToken(token: Address | null | undefined): boolean {
  return token ? NATIVE_SENTINELS.includes(token.toLowerCase()) : false
}

/**
 * Two token addresses, compared the way a bridge API means them.
 *
 * Here rather than in the SDK because "native is `0xEeee…`" is a bridge-API convention, not anything
 * a drop knows about.
 */
export function isSameToken(a: Address | null | undefined, b: Address | null | undefined): boolean {
  if (isNativeToken(a) && isNativeToken(b)) return true
  return isSameAddress(a, b)
}

/** Bytes in a hex blob, for the size a `<details>` summary and a length check both want. */
export function byteLength(hex: Hex): number {
  return (hex.length - 2) / 2
}
