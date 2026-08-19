import { keccak256, toHex, type Address, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'

import { appDataHash, feeFor, isProblem, matchDocuments } from './appData.js'

const KEEPER: Address = '0x00000000000000000000000000000000000cafe0'
const OTHER: Address = '0x00000000000000000000000000000000000b0b00'

function document(metadata: unknown): string {
  return JSON.stringify({ version: '1.4.0', appCode: 'cow-drop', metadata })
}

const WITH_FEE = document({ partnerFee: { volumeBps: 10, recipient: KEEPER } })

describe('appDataHash', () => {
  it('is keccak of the exact bytes it was given', () => {
    expect(appDataHash(WITH_FEE)).toBe(keccak256(toHex(WITH_FEE)))
  })

  it('treats two spellings of the same object as different documents', () => {
    // Which is why the keeper hashes the string verbatim and never re-serialises: JSON has many
    // spellings, and only the one that was hashed is the pre-image.
    const a = '{"a":1,"b":2}'
    const b = '{"b":2,"a":1}'

    expect(appDataHash(a)).not.toBe(appDataHash(b))
  })
})

describe('feeFor', () => {
  it('finds a volume fee naming the keeper', () => {
    const result = feeFor(WITH_FEE, appDataHash(WITH_FEE), KEEPER)

    expect(isProblem(result)).toBe(false)
    if (isProblem(result)) return
    expect(result.volumeBps).toBe(10)
    expect(result.recipient).toBe(KEEPER)
  })

  it('matches the recipient whatever the casing', () => {
    const mixed = document({ partnerFee: { volumeBps: 10, recipient: '0x00000000000000000000000000000000000CAFE0' } })
    expect(isProblem(feeFor(mixed, appDataHash(mixed), KEEPER))).toBe(false)
  })

  it('refuses a document that is not the one the recipe committed to', () => {
    // The whole point: a fee in a document nobody signed is not a promise.
    const result = feeFor(WITH_FEE, `0x${'11'.repeat(32)}`, KEEPER)

    expect(result).toMatchObject({ error: 'hash-mismatch', actual: appDataHash(WITH_FEE) })
  })

  it('refuses a fee that names somebody else', () => {
    const theirs = document({ partnerFee: { volumeBps: 50, recipient: OTHER } })

    expect(feeFor(theirs, appDataHash(theirs), KEEPER)).toMatchObject({ error: 'no-fee-for-recipient' })
  })

  it('finds the keeper\'s fee among several', () => {
    const many = document({
      partnerFee: [
        { volumeBps: 5, recipient: OTHER },
        { volumeBps: 25, recipient: KEEPER },
      ],
    })
    const result = feeFor(many, appDataHash(many), KEEPER)

    expect(isProblem(result)).toBe(false)
    if (isProblem(result)) return
    expect(result.volumeBps).toBe(25)
  })

  it('refuses a surplus-only fee, whose guaranteed value is zero', () => {
    // Real income, but a fill with no surplus pays nothing — and subsidising against income that may
    // never arrive is exactly what this mode exists to stop.
    const surplus = document({ partnerFee: { surplusBps: 100, maxVolumeBps: 50, recipient: KEEPER } })

    expect(feeFor(surplus, appDataHash(surplus), KEEPER)).toEqual({ error: 'fee-not-volume-based' })
  })

  it('handles a document with no partnerFee, and one that is not JSON', () => {
    const none = document({})
    expect(feeFor(none, appDataHash(none), KEEPER)).toMatchObject({ error: 'no-fee-for-recipient' })

    const junk = 'not json'
    expect(feeFor(junk, appDataHash(junk), KEEPER)).toEqual({ error: 'not-json' })
  })
})

describe('matchDocuments', () => {
  it('pairs each document with the hash it belongs to', () => {
    const a = document({ partnerFee: { volumeBps: 1, recipient: KEEPER } })
    const b = document({ partnerFee: { volumeBps: 2, recipient: KEEPER } })

    const { matched, unmatched } = matchDocuments([appDataHash(a), appDataHash(b)], [b, a])

    expect(matched[appDataHash(a)]).toBe(a)
    expect(matched[appDataHash(b)]).toBe(b)
    expect(unmatched).toEqual([])
  })

  it('reports a document matching nothing, rather than dropping it', () => {
    // Silently ignoring it would leave the order unpostable later, for a reason nobody could trace.
    const stray = document({ partnerFee: { volumeBps: 1, recipient: KEEPER } })
    const committed: Hex[] = [`0x${'22'.repeat(32)}`]

    const { unmatched } = matchDocuments(committed, [stray])

    expect(unmatched).toEqual([{ document: stray, hash: appDataHash(stray) }])
  })
})
