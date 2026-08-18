import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'

import { describeRecipe, hasWarnings } from './describe.js'
import { getDeployment } from './generated/deployments.js'
import { compileRecipe, type DropRecipeJson } from './recipe.js'
import { steps } from './steps.js'
import { swapOnArrival, twapOnArrival } from './templates.js'

const OWNER: Address = '0x1111111111111111111111111111111111111111'
const WXDAI: Address = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'
const COW: Address = '0x177127622c4A00F3d409B75571e12cB3c8973d3c'
const GNOSIS = 100

const deployment = getDeployment(GNOSIS)

function twapRecipe(): DropRecipeJson {
  return twapOnArrival({
    chainId: GNOSIS,
    owner: OWNER,
    sellToken: WXDAI,
    buyToken: COW,
    parts: 12,
    partDuration: 3600,
    limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
    minAmount: 1000n * 10n ** 18n,
  })
}

describe('describeRecipe', () => {
  it('names every step of a template recipe and flags nothing', () => {
    const compiled = compileRecipe(twapRecipe())
    const described = describeRecipe(compiled.setupData, compiled.deployment)

    expect(described.once).toBe(true)
    expect(described.label).toBe('twap 12 parts')
    expect(described.steps.map((step) => step.known?.functionName)).toEqual([
      'requireMinBalance',
      'twapFromBalance',
    ])
    expect(described.steps.map((step) => step.known?.contract)).toEqual(['GuardSteps', 'TwapSteps'])
    expect(described.steps.map((step) => step.index)).toEqual([1, 2])
    // A recipe built entirely from the registry is exactly the case that must come back clean, or the
    // warnings mean nothing when they do appear.
    expect(hasWarnings(described)).toBe(false)
  })

  it('decodes arguments with the names the contract gives them', () => {
    const compiled = compileRecipe(twapRecipe())
    const described = describeRecipe(compiled.setupData, compiled.deployment)

    const guard = described.steps[0]!
    expect(guard.known!.args.map((arg) => arg.name)).toEqual(['token', 'minAmount'])
    expect(guard.known!.args[0]!.value).toBe(WXDAI)
    expect(guard.known!.args[1]!.value).toBe(1000n * 10n ** 18n)

    const twap = described.steps[1]!
    expect(twap.known!.args.map((arg) => arg.name)).toEqual([
      'sellToken',
      'buyToken',
      'receiver',
      'n',
      't',
      'span',
      'limitNumerator',
      'limitDenominator',
      'appData',
      'orderSalt',
    ])
    expect(twap.known!.args[3]!.value).toBe(12n)
  })

  it('warns loudly about a raw delegatecall to somewhere unknown', () => {
    const recipe: DropRecipeJson = {
      ...swapOnArrival({
        chainId: GNOSIS,
        owner: OWNER,
        sellToken: WXDAI,
        buyToken: COW,
        limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
      }),
      steps: [
        {
          type: 'raw',
          target: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          callData: '0x12345678',
          isDelegateCall: true,
        },
      ],
    }

    const compiled = compileRecipe(recipe)
    const described = describeRecipe(compiled.setupData, compiled.deployment)

    expect(described.steps[0]!.known).toBeNull()
    expect(described.steps[0]!.warnings).toEqual([
      expect.stringContaining('does not target a cow-drop step contract'),
      expect.stringContaining('runs foreign code in the drop’s own context'),
    ])
    expect(hasWarnings(described)).toBe(true)
  })

  it('does not warn about foreign code for a raw plain call', () => {
    // A plain call to an arbitrary contract is ordinary — paying an EOA, poking a protocol — and only
    // the "cannot be shown here" note applies.
    const recipe: DropRecipeJson = {
      ...swapOnArrival({
        chainId: GNOSIS,
        owner: OWNER,
        sellToken: WXDAI,
        buyToken: COW,
        limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
      }),
      steps: [{ type: 'raw', target: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', callData: '0x12345678' }],
    }

    const described = describeRecipe(compileRecipe(recipe).setupData, deployment)
    expect(described.steps[0]!.warnings).toEqual([
      expect.stringContaining('does not target a cow-drop step contract'),
    ])
  })

  it('catches a step contract targeted as a plain call', () => {
    // The quiet failure: `address(this)` would be the step contract, whose balance is always zero.
    const recipe: DropRecipeJson = {
      ...swapOnArrival({
        chainId: GNOSIS,
        owner: OWNER,
        sellToken: WXDAI,
        buyToken: COW,
        limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
      }),
      steps: [
        {
          type: 'raw',
          target: deployment.guardSteps,
          callData: steps.requireTimeWindow(deployment, { notAfter: 1n }).callData,
          isDelegateCall: false,
        },
      ],
    }

    const described = describeRecipe(compileRecipe(recipe).setupData, deployment)
    // Still named, because the target is known — the warning is about how it is invoked.
    expect(described.steps[0]!.known!.functionName).toBe('requireTimeWindow')
    expect(described.steps[0]!.warnings).toEqual([
      expect.stringContaining('plain call rather than a delegatecall'),
    ])
  })

  it('names the contract but not the function for an unrecognised selector', () => {
    const recipe: DropRecipeJson = {
      ...swapOnArrival({
        chainId: GNOSIS,
        owner: OWNER,
        sellToken: WXDAI,
        buyToken: COW,
        limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
      }),
      steps: [{ type: 'raw', target: deployment.twapSteps, callData: '0xdeadbeef', isDelegateCall: true }],
    }

    const described = describeRecipe(compileRecipe(recipe).setupData, deployment)
    expect(described.steps[0]!.known).toBeNull()
    expect(described.steps[0]!.warnings).toEqual([
      expect.stringContaining('calls TwapSteps with a function this SDK does not recognise'),
    ])
  })

  it('treats another generation’s step contracts as unknown', () => {
    // Not pedantry: those addresses host a different generation's code, so naming the step from this
    // generation's ABI could describe it wrongly. Unknown is the honest answer.
    const compiled = compileRecipe(twapRecipe())
    const otherGeneration = { ...compiled.deployment, guardSteps: OWNER, twapSteps: WXDAI }

    const described = describeRecipe(compiled.setupData, otherGeneration)
    expect(described.steps.every((step) => step.known === null)).toBe(true)
    expect(hasWarnings(described)).toBe(true)
  })

  it('flags allowFailure, which lets an activation complete having skipped the step', () => {
    const recipe = swapOnArrival({
      chainId: GNOSIS,
      owner: OWNER,
      sellToken: WXDAI,
      buyToken: COW,
      limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
    })
    recipe.steps = recipe.steps.map((step) => ({ ...step, allowFailure: true }))

    const described = describeRecipe(compileRecipe(recipe).setupData, deployment)
    expect(described.steps[0]!.warnings).toEqual([expect.stringContaining('may fail without stopping')])
  })

  it('names the allowance steps, so an approval need never be a raw call', () => {
    // The point of having them typed at all: a `raw` approve renders as "unrecognised call", which is
    // the wrong thing to show someone deciding whether to fund the address.
    const recipe: DropRecipeJson = {
      ...swapOnArrival({
        chainId: GNOSIS,
        owner: OWNER,
        sellToken: WXDAI,
        buyToken: COW,
        limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
      }),
      steps: [
        { type: 'approveMax', token: WXDAI, spender: COW },
        { type: 'approveBalance', token: WXDAI, spender: COW },
      ],
    }

    const described = describeRecipe(compileRecipe(recipe).setupData, deployment)
    expect(described.steps.map((step) => step.known?.functionName)).toEqual(['approveMax', 'approveBalance'])
    expect(described.steps.every((step) => step.known?.contract === 'TokenSteps')).toBe(true)
    expect(described.steps[1]!.known!.args.map((arg) => arg.name)).toEqual(['token', 'spender'])
    expect(hasWarnings(described)).toBe(false)
  })

  it('names the stop-loss step and decodes its trigger', () => {
    const recipe: DropRecipeJson = {
      ...swapOnArrival({
        chainId: GNOSIS,
        owner: OWNER,
        sellToken: WXDAI,
        buyToken: COW,
        limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
      }),
      steps: [
        {
          type: 'stopLossFromBalance',
          sellToken: WXDAI,
          buyToken: COW,
          limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
          validitySeconds: 7 * 24 * 3600,
          trigger: {
            sellTokenPriceOracle: '0x0000000000000000000000000000000000000fe1',
            buyTokenPriceOracle: '0x0000000000000000000000000000000000000fe2',
            strike: (18n * 10n ** 17n).toString(),
            maxTimeSinceLastOracleUpdate: 3600,
          },
        },
      ],
    }

    const described = describeRecipe(compileRecipe(recipe).setupData, deployment)
    const step = described.steps[0]!
    expect(step.known!.contract).toBe('StopLossSteps')
    expect(step.known!.functionName).toBe('stopLossFromBalance')
    // The trigger is a struct, so it decodes as one named argument rather than four.
    expect(step.known!.args.map((arg) => arg.name)).toContain('trigger')
    expect(hasWarnings(described)).toBe(false)
  })

  it('round-trips the label, salt and once flag', () => {
    const salt = `0x${'ab'.repeat(32)}` as const
    const compiled = compileRecipe({ ...twapRecipe(), label: 'payroll march', salt })
    const described = describeRecipe(compiled.setupData, compiled.deployment)

    expect(described.label).toBe('payroll march')
    expect(described.salt).toBe(salt)
    expect(described.once).toBe(true)
  })
})
