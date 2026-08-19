import type { DropStepJson } from '@cowprotocol/cow-drop-sdk'
import { describe, expect, it } from 'vitest'

import { COW, OWNER, recipeJson, WXDAI } from './fixtures.js'
import { balancesDigest, deriveHints, pollTargets } from './hints.js'

const ZERO = '0x0000000000000000000000000000000000000000'
const wxdai = WXDAI.toLowerCase() as `0x${string}`

function hintsFor(...steps: DropStepJson[]) {
  return deriveHints(recipeJson({ steps }))
}

const SWAP: DropStepJson = {
  type: 'presignSellAll',
  sellToken: WXDAI,
  buyToken: COW,
  limitPrice: { price: '45', sellDecimals: 18, buyDecimals: 18 },
  validitySeconds: 1800,
}

describe('deriveHints', () => {
  it('takes the sell token from each trading step', () => {
    const price = { price: '45', sellDecimals: 18, buyDecimals: 18 }

    expect(hintsFor(SWAP).tokens).toEqual([wxdai])
    expect(
      hintsFor({ type: 'twapFromBalance', sellToken: WXDAI, buyToken: COW, parts: 12, partDuration: 3600, limitPrice: price }).tokens,
    ).toEqual([wxdai])
    expect(
      hintsFor({
        type: 'stopLossFromBalance',
        sellToken: WXDAI,
        buyToken: COW,
        limitPrice: price,
        validitySeconds: 604800,
        trigger: {
          sellTokenPriceOracle: '0x0000000000000000000000000000000000000fe1',
          buyTokenPriceOracle: '0x0000000000000000000000000000000000000fe2',
          strike: '45000000000000000000',
          maxTimeSinceLastOracleUpdate: 3600,
        },
      }).tokens,
    ).toEqual([wxdai])
  })

  it('watches the native balance for a wrapNative recipe', () => {
    // What has to *arrive* is the chain's own currency; the wrapped token is a later step's problem.
    const hints = hintsFor({ type: 'wrapNative', wrappedNative: WXDAI }, SWAP)

    expect(hints.native).toBe(true)
    expect(hints.tokens).toEqual([wxdai])
  })

  it('reads a minimum balance, and keeps the units it was committed in', () => {
    const hints = hintsFor({ type: 'requireMinBalance', token: WXDAI, minAmount: '1000000000000000000000' }, SWAP)

    expect(hints.minBalance[wxdai]).toBe('1000000000000000000000')
  })

  it('treats a zero-address minimum as native, not as an ERC20', () => {
    // `balanceOf` on the zero address is not a call worth making.
    const hints = hintsFor({ type: 'requireMinBalance', token: ZERO, minAmount: '1' }, SWAP)

    expect(hints.native).toBe(true)
    expect(hints.tokens).toEqual([wxdai])
  })

  it('watches both when the guarded token is not the sell token', () => {
    const hints = hintsFor({ type: 'requireMinBalance', token: COW, minAmount: '1' }, SWAP)

    expect(new Set(hints.tokens)).toEqual(new Set([wxdai, COW.toLowerCase()]))
  })

  it('reads a time window', () => {
    const hints = hintsFor({ type: 'requireTimeWindow', notBefore: 100, notAfter: 200 }, SWAP)

    expect(hints).toMatchObject({ notBefore: 100, notAfter: 200, notAfterIsHard: true })
  })

  it('takes the strictest bound when there are two windows, but stops trusting notAfter', () => {
    // The earliest deadline is still the real one; what is no longer obvious is that it is the only
    // one, and retiring a live drop is the failure to avoid.
    const hints = hintsFor(
      { type: 'requireTimeWindow', notBefore: 100, notAfter: 500 },
      { type: 'requireTimeWindow', notBefore: 200, notAfter: 300 },
      SWAP,
    )

    expect(hints).toMatchObject({ notBefore: 200, notAfter: 300, notAfterIsHard: false })
  })

  it('will not retire on a deadline when any step was unreadable', () => {
    // A raw step could carry another condition entirely, so `notAfter` is no longer a bound.
    const hints = hintsFor(
      { type: 'requireTimeWindow', notAfter: 200 },
      { type: 'raw', target: OWNER, callData: '0x1234' },
      SWAP,
    )

    expect(hints.notAfter).toBe(200)
    expect(hints.notAfterIsHard).toBe(false)
  })

  it('warns about a requireCallResult guard and infers nothing from it', () => {
    // The SDK deliberately refuses to interpret the inner calldata, so only the simulation sees it.
    const hints = hintsFor(
      { type: 'requireCallResult', target: COW, callData: '0x1234', comparison: 'gte', threshold: '1' },
      SWAP,
    )

    expect(hints.warnings[0]).toMatch(/requireCallResult/)
    expect(hints.notAfterIsHard).toBe(false)
  })

  it('is blind for a recipe of nothing but raw steps', () => {
    // Correctness is unaffected — the simulation was always the gate — only latency is.
    const hints = hintsFor({ type: 'raw', target: OWNER, callData: '0x1234' })

    expect(hints).toMatchObject({ blind: true, tokens: [], native: false })
    expect(hints.warnings).toHaveLength(1)
  })

  it('watches allowance-step tokens too', () => {
    expect(hintsFor({ type: 'approveBalance', token: COW, spender: OWNER }, SWAP).tokens).toContain(COW.toLowerCase())
  })
})

describe('pollTargets', () => {
  it('asks for the native balance when the recipe needs it', () => {
    expect(pollTargets(hintsFor({ type: 'wrapNative', wrappedNative: WXDAI }, SWAP))).toEqual([null, wxdai])
  })

  it('skips the native read when nothing needs it', () => {
    expect(pollTargets(hintsFor(SWAP))).toEqual([wxdai])
  })

  it('reads the native balance for a blind recipe anyway, since it is one cheap call', () => {
    expect(pollTargets(hintsFor({ type: 'raw', target: OWNER, callData: '0x12' }))).toEqual([null])
  })
})

describe('balancesDigest', () => {
  it('changes when a balance moves and not otherwise', () => {
    // The whole cost control: an unchanged digest means no reason to spend an eth_call.
    expect(balancesDigest([1n, 2n])).toBe(balancesDigest([1n, 2n]))
    expect(balancesDigest([1n, 2n])).not.toBe(balancesDigest([1n, 3n]))
    // Position matters — the same total from different tokens is not the same state.
    expect(balancesDigest([1n, 2n])).not.toBe(balancesDigest([2n, 1n]))
  })
})
