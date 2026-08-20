import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'

import {
  byteLength,
  checksFailingEverywhere,
  findAddress,
  findAmount,
  findBytes,
  isBlocker,
  isFailure,
  isNativeToken,
  isSameToken,
  summarise,
  type CheckOutcome,
} from './checks.js'

const RECEIVER: Address = '0xbF4B4b7Ab60A2435177753ae32E2619627DC7e3C'
const OTHER: Address = '0x177127622c4A00F3d409B75571e12cB3c8973d3c'
const NATIVE: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const ZERO: Address = '0x0000000000000000000000000000000000000000'

describe('findBytes', () => {
  it('reports a byte offset counted from the start of the calldata', () => {
    expect(findBytes('0xdeadbeefcafe', '0xcafe')).toEqual({ offset: 4 })
    expect(findBytes('0xdeadbeef', '0xdead')).toEqual({ offset: 0 })
    expect(findBytes('0xdeadbeef', '0xfeed')).toBeNull()
  })

  /**
   * The subtle one, and the reason this is not a one-line `indexOf`.
   *
   * `0x0abc00` contains the *nibbles* of `0xabc0` at hex index 1, but not its bytes — nothing at any
   * byte boundary equals `0xabc0`. A search that accepted that match would let a **blocking** check
   * pass on a value that is not in the transaction, which is the worst failure this module could have:
   * it would report a verified receiver that the bridge is not actually paying.
   */
  it('does not match on a nibble boundary', () => {
    expect(findBytes('0x0abc00', '0xabc0')).toBeNull()
    // The same bytes, byte-aligned, are found.
    expect(findBytes('0x00abc0', '0xabc0')).toEqual({ offset: 1 })
  })

  it('finds a later occurrence when the first one is misaligned', () => {
    expect(findBytes('0x0abc0000abc0', '0xabc0')).toEqual({ offset: 4 })
  })

  it('folds case, because calldata and checksummed addresses disagree on it', () => {
    expect(findBytes('0xDEADBEEF', '0xdeadbeef')).toEqual({ offset: 0 })
  })

  it('finds nothing in an empty needle or an oversized one', () => {
    expect(findBytes('0xdeadbeef', '0x')).toBeNull()
    expect(findBytes('0xdead', '0xdeadbeef')).toBeNull()
  })
})

describe('findAddress', () => {
  it('finds an address wherever it sits, padded or packed', () => {
    const padded: Hex = `0x${'00'.repeat(12)}${RECEIVER.slice(2)}`
    expect(findAddress(padded, RECEIVER)).toEqual({ offset: 12 })

    const packed: Hex = `0x000001bc${RECEIVER.slice(2)}${OTHER.slice(2)}`
    expect(findAddress(packed, RECEIVER)).toEqual({ offset: 4 })
    expect(findAddress(packed, OTHER)).toEqual({ offset: 24 })
  })

  it('finds a checksummed address in lowercase calldata and the reverse', () => {
    const lower: Hex = `0x${RECEIVER.slice(2).toLowerCase()}`
    expect(findAddress(lower, RECEIVER)).toEqual({ offset: 0 })

    const upper = `0x${RECEIVER.slice(2).toUpperCase()}` as Hex
    expect(findAddress(upper, RECEIVER)).toEqual({ offset: 0 })
  })
})

describe('findAmount', () => {
  it('finds the 32-byte word form and says which it was', () => {
    const word: Hex = `0x${(1_000_000n).toString(16).padStart(64, '0')}`
    expect(findAmount(word, 1_000_000n)).toEqual({ offset: 0, form: 'word' })
  })

  /** Routers pack amounts into narrower ints to save calldata; that is not a wrong amount. */
  it('finds a minimally packed amount', () => {
    expect(findAmount('0xdeadbeef0f4240', 1_000_000n)).toEqual({ offset: 4, form: 'packed' })
  })

  it('pads an odd-length amount to a whole byte before searching', () => {
    // 0xfff is three nibbles; the bytes on the wire are 0x0fff.
    expect(findAmount('0xdead0fff', 0xfffn)).toEqual({ offset: 2, form: 'packed' })
  })

  it('reports nothing rather than guessing when the amount is absent', () => {
    expect(findAmount('0xdeadbeef', 1_000_000n)).toBeNull()
  })
})

describe('token comparison', () => {
  it('treats both native sentinels as the same asset', () => {
    expect(isNativeToken(NATIVE)).toBe(true)
    expect(isNativeToken(ZERO)).toBe(true)
    expect(isNativeToken(RECEIVER)).toBe(false)

    // Otherwise a safety check would refuse every native route, which arrives as "the app is broken".
    expect(isSameToken(NATIVE, ZERO)).toBe(true)
    expect(isSameToken(NATIVE, NATIVE.toLowerCase() as Address)).toBe(true)
    expect(isSameToken(NATIVE, RECEIVER)).toBe(false)
  })

  it('does not treat two absent tokens as agreeing', () => {
    expect(isSameToken(undefined, undefined)).toBe(false)
    expect(isSameToken(null, RECEIVER)).toBe(false)
  })
})

describe('summarise', () => {
  const pass: CheckOutcome = { check: 'tx-chain', severity: 'blocking', state: 'pass', detail: 'fine' }
  const skipped: CheckOutcome = {
    check: 'approval-token',
    severity: 'blocking',
    state: 'not-applicable',
    detail: 'native',
  }
  const advisory: CheckOutcome = {
    check: 'approval-amount',
    severity: 'advisory',
    state: 'fail',
    detail: 'unlimited',
    problem: { check: 'approval-amount', expected: 1n, actual: 2n },
  }
  const blocking: CheckOutcome = {
    check: 'payload-in-calldata',
    severity: 'blocking',
    state: 'fail',
    detail: 'missing',
    problem: { check: 'payload-in-calldata', payloadBytes: 800, calldataBytes: 168 },
  }

  const unknown: CheckOutcome = {
    check: 'approval-amount',
    severity: 'blocking',
    state: 'unknown',
    detail: 'allowance unreadable',
  }

  it('is sendable only when no blocking check failed', () => {
    expect(summarise([pass, skipped, advisory]).sendable).toBe(true)
    expect(summarise([pass, blocking]).sendable).toBe(false)
  })

  /**
   * The regression that matters most in this file.
   *
   * `skipped` is a **blocking** check reporting `not-applicable` — exactly what `payload-in-calldata`
   * does in direct mode, where there is no payload to look for. It must not block. Reading the rule as
   * `state !== 'pass'` makes it block, which made every direct-mode transaction unsendable while the
   * quote itself was sendable, and sent a user looking for an override for something that was never in
   * the way.
   */
  it('is sendable when a blocking check does not apply at all', () => {
    const verification = summarise([pass, skipped])

    expect(verification.sendable).toBe(true)
    expect(verification.blocking).toEqual([])
    expect(isBlocker(skipped)).toBe(false)
  })

  /** "We could not tell" is not permission, so a blocking unknown stops the send. */
  it('is not sendable when a blocking check could not be determined', () => {
    const verification = summarise([pass, unknown])

    expect(verification.sendable).toBe(false)
    expect(verification.blocking.map((check) => check.check)).toEqual(['approval-amount'])
    expect(isBlocker(unknown)).toBe(true)
    // Not a *failure* though — nothing disagreed, so there is no problem to report.
    expect(isFailure(unknown)).toBe(false)
  })

  /** An advisory that could not be determined is worth reading and never worth refusing over. */
  it('never blocks on an advisory unknown', () => {
    const advisoryUnknown: CheckOutcome = {
      check: 'tx-chain',
      severity: 'advisory',
      state: 'unknown',
      detail: 'the RPC did not answer',
    }
    const verification = summarise([pass, advisoryUnknown])

    expect(verification.sendable).toBe(true)
    expect(verification.advisories.map((check) => check.check)).toEqual(['tx-chain'])
  })

  it('puts what stops you first, then what should worry you, and the non-events last', () => {
    const { checks } = summarise([pass, skipped, advisory, blocking, unknown])

    expect(checks.map((check) => check.state)).toEqual(['fail', 'unknown', 'fail', 'pass', 'not-applicable'])
  })

  it('separates blocking failures from advisories', () => {
    const verification = summarise([advisory, blocking])

    expect(verification.blocking.map((check) => check.check)).toEqual(['payload-in-calldata'])
    expect(verification.advisories.map((check) => check.check)).toEqual(['approval-amount'])
    expect(verification.checks.filter(isFailure)).toHaveLength(2)
  })

  /**
   * Six routes do not break at once; a response encoding does. Being able to *name* that is the whole
   * mitigation, because there is deliberately no override to reach for.
   */
  it('names a check that failed on every route, which points at us rather than at them', () => {
    const everywhere = [summarise([blocking, advisory]), summarise([blocking])]
    expect(checksFailingEverywhere(everywhere)).toEqual(['payload-in-calldata'])

    const somewhere = [summarise([blocking]), summarise([pass])]
    expect(checksFailingEverywhere(somewhere)).toEqual([])

    expect(checksFailingEverywhere([])).toEqual([])
  })
})

describe('byteLength', () => {
  it('counts bytes rather than hex characters', () => {
    expect(byteLength('0x')).toBe(0)
    expect(byteLength('0xdeadbeef')).toBe(4)
  })
})
