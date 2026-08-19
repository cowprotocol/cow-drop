import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'

import {
  DEFAULT_DESTINATION_GAS_LIMIT,
  bungeeDelivery,
  bungeeReceiverOf,
  decodeDeliveryPayload,
  encodeDeliveryPayload,
} from './bridge.js'
import { getDeployment } from './generated/deployments.js'
import { compileRecipe, type DropRecipeJson } from './recipe.js'
import { swapOnArrival } from './templates.js'

const OWNER: Address = '0x1111111111111111111111111111111111111111'
const ZERO: Address = '0x0000000000000000000000000000000000000000'
const WXDAI: Address = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'
const COW: Address = '0x177127622c4A00F3d409B75571e12cB3c8973d3c'
const GNOSIS = 100

function swapRecipe(overrides: Partial<Parameters<typeof swapOnArrival>[0]> = {}): DropRecipeJson {
  return swapOnArrival({
    chainId: GNOSIS,
    owner: OWNER,
    sellToken: WXDAI,
    buyToken: COW,
    limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
    ...overrides,
  })
}

describe('bungeeDelivery', () => {
  it('names the receiver, the drop, and a gas limit', () => {
    const compiled = compileRecipe(swapRecipe())
    const target = bungeeDelivery(compiled)

    expect(target.receiver).toBe(getDeployment(GNOSIS).bungeeReceiver)
    // The funds end up at the drop; the receiver only ever passes them through.
    expect(target.predictedAddress).toBe(compiled.address)
    expect(target.gasLimit).toBe(DEFAULT_DESTINATION_GAS_LIMIT)
  })

  it('carries the recipe the drop address already commits to', () => {
    const compiled = compileRecipe(swapRecipe())
    const decoded = decodeDeliveryPayload(bungeeDelivery(compiled).payload)

    expect(decoded.setupData).toBe(compiled.setupData)
    expect(decoded.owner.toLowerCase()).toBe(OWNER.toLowerCase())
    expect(decoded.onFailure).toBe('leave-at-drop')
  })

  /**
   * The property the whole quoting order depends on: a bridge quote can be refreshed as often as the
   * user likes without the destination address moving underneath it. Nothing in the payload is a
   * function of the amount or the route.
   */
  it('does not depend on the amount or the route', () => {
    const compiled = compileRecipe(swapRecipe())
    expect(bungeeDelivery(compiled)).toEqual(bungeeDelivery(compiled))
  })

  it('takes an explicit gas limit and failure mode', () => {
    const compiled = compileRecipe(swapRecipe())
    const target = bungeeDelivery(compiled, { onFailure: 'refund-owner', gasLimit: 900_000 })

    expect(target.gasLimit).toBe(900_000)
    expect(decodeDeliveryPayload(target.payload).onFailure).toBe('refund-owner')
  })

  /**
   * Two individually sensible settings that are a bug together. The guard exists so a tranche-paying
   * bridge accumulates; `refund-owner` reads the guard's refusal as a broken recipe and sends the
   * tranche back, so every tranche bounces and the drop never fills.
   */
  it('refuses refund-owner on a recipe that is waiting for more money', () => {
    const compiled = compileRecipe(swapRecipe({ minAmount: 1000n }))

    expect(() => bungeeDelivery(compiled, { onFailure: 'refund-owner' })).toThrow(/requireMinBalance/)
    // ...and the same recipe is fine on the mode that lets the tranches gather.
    expect(() => bungeeDelivery(compiled, { onFailure: 'leave-at-drop' })).not.toThrow()
  })

  it('refuses a refund when there is no owner to refund', () => {
    const compiled = compileRecipe(swapRecipe({ owner: ZERO }))

    expect(() => bungeeDelivery(compiled, { onFailure: 'refund-owner' })).toThrow(/zero address/)
    // A zero-owner drop is a legitimate recipe, so the safe mode still works.
    expect(() => bungeeDelivery(compiled)).not.toThrow()
  })
})

describe('bungeeReceiverOf', () => {
  it('explains itself on a generation cut before the receiver existed', () => {
    const compiled = compileRecipe({ ...swapRecipe(), generation: 1 }, getDeployment(GNOSIS, 1))

    expect(compiled.deployment.bungeeReceiver).toBeUndefined()
    expect(() => bungeeReceiverOf(compiled.deployment)).toThrow(/generation 1 has no Bungee receiver/)
  })
})

describe('encodeDeliveryPayload', () => {
  it('round-trips both modes', () => {
    for (const onFailure of ['leave-at-drop', 'refund-owner'] as const) {
      const payload = encodeDeliveryPayload({ owner: OWNER, setupData: '0xdeadbeef', onFailure })
      expect(decodeDeliveryPayload(payload).onFailure).toBe(onFailure)
    }
  })

  it('defaults to the mode that is safe with any recipe', () => {
    const payload = encodeDeliveryPayload({ owner: OWNER, setupData: '0xdeadbeef' })
    expect(decodeDeliveryPayload(payload).onFailure).toBe('leave-at-drop')
  })

  it('rejects a failure code the contract does not define', () => {
    const payload = encodeDeliveryPayload({ owner: OWNER, setupData: '0xdeadbeef' })
    // The `uint8` is the third head word: address, offset-to-bytes, then this. Set it to a 7.
    const tampered = `${payload.slice(0, 192)}07${payload.slice(194)}` as `0x${string}`

    expect(() => decodeDeliveryPayload(tampered)).toThrow(/unknown onFailure code/)
  })
})
