import { decodeFunctionData, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import { describeRecipe } from './describe.js'
import { PAYMENT_STEPS_ABI } from './generated/artifacts.js'
import { GENERATIONS, getDeployment } from './generated/deployments.js'
import { PAYMENT_SLIPPAGE_BPS, requiredPayment } from './price.js'
import { compileRecipe, type DropRecipeJson } from './recipe.js'
import { paymentRequest } from './templates.js'
import { buildActivatePaymentTx } from './tx.js'
import { COW_DROP_APP_DATA } from './appData.js'

const OWNER: Address = '0x1111111111111111111111111111111111111111'
const PAYEE: Address = '0x4444444444444444444444444444444444444444'
const WXDAI: Address = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'
const COW: Address = '0x177127622c4A00F3d409B75571e12cB3c8973d3c'

function paymentRecipe(overrides: Partial<Extract<DropRecipeJson['steps'][number], { type: 'payment' }>> = {}) {
  return {
    version: 1,
    generation: 2,
    label: 'invoice 42',
    chainId: 100,
    owner: OWNER,
    steps: [
      { type: 'payment', buyToken: COW, buyAmount: '100000000000000000000', validitySeconds: 3600, ...overrides },
    ],
  } satisfies DropRecipeJson
}

function decodePayment(callData: `0x${string}`) {
  return decodeFunctionData({ abi: PAYMENT_STEPS_ABI, data: callData })
}

describe('payment step', () => {
  it('compiles to a delegatecall into PaymentSteps that pays the owner by default', () => {
    const compiled = compileRecipe(paymentRecipe())
    const call = compiled.recipe.calls[0]!

    expect(call.target).toBe(compiled.deployment.paymentSteps)
    expect(call.isDelegateCall).toBe(true)
    expect(call.allowFailure).toBe(false)

    const decoded = decodePayment(call.callData)
    expect(decoded.functionName).toBe('presignPayment')
    expect(decoded.args).toEqual([COW, 100_000_000_000_000_000_000n, OWNER, 3600n, `0x${'00'.repeat(32)}`])
  })

  it('pays an explicit receiver when one is given', () => {
    const compiled = compileRecipe(paymentRecipe({ receiver: PAYEE }))
    expect(decodePayment(compiled.recipe.calls[0]!.callData).args[2]).toBe(PAYEE)
  })

  it('moves the address when the price changes', () => {
    expect(compileRecipe(paymentRecipe()).address).not.toBe(
      compileRecipe(paymentRecipe({ buyAmount: '100000000000000000001' })).address,
    )
  })

  it('rejects a zero price', () => {
    expect(() => compileRecipe(paymentRecipe({ buyAmount: '0' }))).toThrow(/positive buyAmount/)
  })

  it('rejects a generation without PaymentSteps', () => {
    expect(GENERATIONS[1]!.paymentSteps).toBeUndefined()
    expect(() => compileRecipe({ ...paymentRecipe(), generation: 1 })).toThrow(/no PaymentSteps/)
  })

  it('stands alone: no second payment and no other order step', () => {
    const base = paymentRecipe()
    expect(() => compileRecipe({ ...base, steps: [...base.steps, ...base.steps] })).toThrow(/at most one payment/)
    expect(() =>
      compileRecipe({
        ...base,
        steps: [
          ...base.steps,
          {
            type: 'presignSellAll',
            sellToken: WXDAI,
            buyToken: COW,
            limitPrice: { price: '1', sellDecimals: 18, buyDecimals: 18 },
            validitySeconds: 60,
          },
        ],
      }),
    ).toThrow(/cannot share a recipe/)
  })

  it('allows guards beside it', () => {
    const base = paymentRecipe()
    const compiled = compileRecipe({
      ...base,
      steps: [{ type: 'requireTimeWindow', notAfter: 2_000_000_000 }, ...base.steps],
    })
    expect(compiled.recipe.calls).toHaveLength(2)
  })

  it('is described as a PaymentSteps call', () => {
    const compiled = compileRecipe(paymentRecipe())
    const [step] = describeRecipe(compiled.setupData, compiled.deployment).steps
    expect(step!.known?.contract).toBe('PaymentSteps')
    expect(step!.known?.functionName).toBe('presignPayment')
    expect(step!.warnings).toEqual([])
  })
})

describe('buildActivatePaymentTx', () => {
  it('calls activatePayment with the chosen sell token', () => {
    const compiled = compileRecipe(paymentRecipe())
    const tx = buildActivatePaymentTx({
      deployment: compiled.deployment,
      owner: OWNER,
      setupData: compiled.setupData,
      sellToken: WXDAI,
    })

    expect(tx.to).toBe(getDeployment(100, 2).paymentSteps)
    expect(tx.value).toBe(0n)
    const decoded = decodeFunctionData({ abi: PAYMENT_STEPS_ABI, data: tx.data })
    expect(decoded.functionName).toBe('activatePayment')
    expect(decoded.args).toEqual([OWNER, compiled.setupData, WXDAI])
  })

  it('refuses a deployment without PaymentSteps', () => {
    expect(() =>
      buildActivatePaymentTx({ deployment: {}, owner: OWNER, setupData: '0x', sellToken: WXDAI }),
    ).toThrow(/no PaymentSteps/)
  })
})

describe('requiredPayment', () => {
  it('adds the fee, since the drop places a fee-less order', () => {
    expect(requiredPayment({ sellAmount: 1000n, feeAmount: 10n }, 0)).toBe(1010n)
  })

  it('adds the UI cushion by default and rounds up', () => {
    expect(PAYMENT_SLIPPAGE_BPS).toBe(50)
    expect(requiredPayment({ sellAmount: 10_000n, feeAmount: 0n })).toBe(10_050n)
    expect(requiredPayment({ sellAmount: 1n, feeAmount: 0n })).toBe(2n)
  })

  it('rejects a negative or fractional slippage', () => {
    expect(() => requiredPayment({ sellAmount: 1n, feeAmount: 0n }, -1)).toThrow()
    expect(() => requiredPayment({ sellAmount: 1n, feeAmount: 0n }, 0.5)).toThrow()
  })
})

describe('paymentRequest', () => {
  it('builds a reusable payment recipe that pays the owner', () => {
    const recipe = paymentRequest({ chainId: 100, owner: OWNER, buyToken: COW, buyAmount: 5n })
    expect(recipe.once).toBe(false)
    expect(recipe.steps).toEqual([
      {
        type: 'payment',
        buyToken: COW,
        buyAmount: '5',
        receiver: OWNER,
        validitySeconds: 1800,
        appData: COW_DROP_APP_DATA,
      },
    ])
    expect(() => compileRecipe(recipe)).not.toThrow()
  })
})
