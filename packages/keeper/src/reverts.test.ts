import { GUARD_STEPS_ABI } from '@cowprotocol/cow-drop-sdk'
import { encodeErrorResult, toFunctionSelector, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'

import { classifyRevert } from './reverts.js'

/** Encode a real revert from the generated ABIs, so a fixture cannot drift from the contracts. */
function guardRevert(errorName: 'TooEarly' | 'TooLate', arg: bigint): Hex {
  return encodeErrorResult({ abi: GUARD_STEPS_ABI, errorName, args: [arg] })
}

describe('classifyRevert', () => {
  it('treats a drop that has nothing to sell as waiting', () => {
    const data = encodeErrorResult({
      abi: [{ type: 'error', name: 'NothingToSell', inputs: [] }],
      errorName: 'NothingToSell',
    })

    expect(classifyRevert(data, '')).toMatchObject({ name: 'NothingToSell', class: 'waiting' })
  })

  it('treats a window that has not opened as waiting, and one that has closed as terminal', () => {
    expect(classifyRevert(guardRevert('TooEarly', 100n), '')).toMatchObject({ name: 'TooEarly', class: 'waiting' })
    expect(classifyRevert(guardRevert('TooLate', 100n), '')).toMatchObject({ name: 'TooLate', class: 'terminal' })
  })

  it('retires a consumed one-shot recipe', () => {
    const data = encodeErrorResult({
      abi: [{ type: 'error', name: 'AlreadyConsumed', inputs: [] }],
      errorName: 'AlreadyConsumed',
    })

    expect(classifyRevert(data, '')).toMatchObject({ class: 'terminal' })
  })

  it('parks, rather than retires, a step contract that is not deployed here yet', () => {
    // It may be deployed later, at which point the same recipe works.
    const data = encodeErrorResult({
      abi: [{ type: 'error', name: 'NoCodeAtDelegateTarget', inputs: [{ type: 'address' }] }],
      errorName: 'NoCodeAtDelegateTarget',
      args: ['0x0000000000000000000000000000000000000001'],
    })

    expect(classifyRevert(data, '')).toMatchObject({ class: 'blocked' })
  })

  it('never retires on a selector it does not recognise', () => {
    // The rule that must not regress: this decoder is the lossy part, and an unfamiliar revert from
    // some `raw` step's target must not stop the keeper watching a live drop.
    const unknown = toFunctionSelector('SomeoneElsesError(uint256)')

    expect(classifyRevert(unknown, 'execution reverted')).toMatchObject({ name: 'unknown', class: 'waiting' })
  })

  it('reads a plain require message, and calls it waiting', () => {
    const data = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }],
      errorName: 'Error',
      args: ['TRANSFER_FROM_FAILED'],
    })

    expect(classifyRevert(data, 'reverted')).toMatchObject({ class: 'waiting', detail: 'TRANSFER_FROM_FAILED' })
  })

  it('falls back to the node message when there is no revert data at all', () => {
    expect(classifyRevert(undefined, 'out of gas')).toEqual({ name: 'unknown', class: 'waiting', detail: 'out of gas' })
    expect(classifyRevert('0x', 'reverted')).toMatchObject({ class: 'waiting' })
  })

  it('puts the arguments in the detail, so a guard says what it wanted', () => {
    const data = encodeErrorResult({
      abi: GUARD_STEPS_ABI,
      errorName: 'BalanceTooLow',
      args: [1n, 1000n],
    })

    expect(classifyRevert(data, '').detail).toBe('BalanceTooLow(1, 1000)')
  })
})
