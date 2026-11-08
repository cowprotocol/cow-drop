import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'

import { describeRecipe } from './describe.js'
import { getDeployment } from './generated/deployments.js'
import { compileRecipe, type DropRecipeJson } from './recipe.js'
import { steps } from './steps.js'
import { twapOnArrival } from './templates.js'
import type { DropDeployment } from './types.js'

const OWNER: Address = '0x1111111111111111111111111111111111111111'
const WXDAI: Address = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'
const COW: Address = '0x177127622c4A00F3d409B75571e12cB3c8973d3c'
const GNOSIS = 100

/**
 * `CooldownSteps` is not in any deployment record yet, so every test here supplies the address.
 *
 * That is the honest state rather than a gap: the record is written by the deploy script when the
 * contract actually lands on a chain, and until then the SDK should say so — which the last test in
 * this file is what checks.
 */
const COOLDOWN_STEPS: Address = '0xa92B50b160e20554F9845BAaF52D42b70034657b'
const deployment = (): DropDeployment => ({ ...getDeployment(GNOSIS), cooldownSteps: COOLDOWN_STEPS })

const PRICE = { price: '0.02', sellDecimals: 18, buyDecimals: 18 } as const

function reusableTwap(overrides: Partial<Parameters<typeof twapOnArrival>[0]> = {}): DropRecipeJson {
  return twapOnArrival({
    chainId: GNOSIS,
    owner: OWNER,
    sellToken: WXDAI,
    buyToken: COW,
    parts: 12,
    partDuration: 3600,
    limitPrice: PRICE,
    minAmount: 1000n,
    reusableAfter: true,
    ...overrides,
  })
}

describe('steps.claimCooldown', () => {
  it('is a delegatecall into the cooldown contract, never failable', () => {
    const call = steps.claimCooldown(deployment(), { cooldownSeconds: 3600n })

    // Delegatecall or the write lands in the step contract, where it would gate every drop at once.
    expect(call.isDelegateCall).toBe(true)
    expect(call.target).toBe(COOLDOWN_STEPS)
    // A swallowed claim lets the recipe run without the gate it was given.
    expect(call.allowFailure).toBe(false)
  })

  it('refuses a zero cooldown, which gates nothing', () => {
    expect(() => steps.claimCooldown(deployment(), { cooldownSeconds: 0n })).toThrow(/positive/)
  })

  it('says so when the generation has no cooldown contract', () => {
    // The field is optional precisely because a generation can predate the contract. Reaching for it
    // there has to name the reason, not produce a step pointing at `undefined`.
    expect(() => steps.claimCooldown(getDeployment(GNOSIS), { cooldownSeconds: 3600n })).toThrow(
      /no CooldownSteps deployment/,
    )
  })
})

describe('twapOnArrival with a cooldown', () => {
  it('claims the window after the balance guard and before the order', () => {
    const recipe = reusableTwap()

    // The order is the protection. A claim before the guard could be spent on dust by anyone the
    // moment the window opened, pushing the next honest activation out by another full cooldown.
    expect(recipe.steps.map((step) => step.type)).toEqual([
      'requireMinBalance',
      'claimCooldown',
      'twapFromBalance',
    ])
  })

  it('defaults the cooldown to the length of the schedule it paces', () => {
    const step = reusableTwap().steps.find((s) => s.type === 'claimCooldown')

    // 12 parts an hour apart: by second 43200 the TWAP has run out of parts, so a re-activation
    // cannot overlap it. That is what "concurrency of one" means here.
    expect(step).toMatchObject({ cooldownSeconds: 12 * 3600 })
  })

  it('is reusable rather than one-shot', () => {
    expect(reusableTwap().once).toBe(false)
    expect(compileRecipe(reusableTwap(), deployment()).address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('refuses a cooldown shorter than the schedule', () => {
    // Overlap is the one thing this is for, so letting it through would be worse than no feature.
    expect(() => reusableTwap({ reusableAfter: 3600 })).toThrow(/second\s+TWAP while the first is still live/)
  })

  it('refuses to be reusable without a balance floor', () => {
    expect(() => reusableTwap({ minAmount: undefined })).toThrow(/needs minAmount/)
  })

  it('leaves the one-shot recipe exactly where it was', () => {
    // The regression that matters. Someone who wrote down TWAP parameters rather than the recipe file
    // and re-derives after this change must land on the address they funded.
    const unchanged = twapOnArrival({
      chainId: GNOSIS,
      owner: OWNER,
      sellToken: WXDAI,
      buyToken: COW,
      parts: 12,
      partDuration: 3600,
      limitPrice: PRICE,
    })

    expect(unchanged.once).toBe(true)
    expect(unchanged.steps.map((step) => step.type)).toEqual(['twapFromBalance'])
    // Taken from the commit before the cooldown step existed, and compiled against the real
    // generation 2 — which carries no cooldown contract, exactly as it did then.
    expect(compileRecipe(unchanged).address).toBe('0x44e33F562457a7D2c346C7a3cFDE77B3E62DFfAb')
  })
})

describe('compileRecipe with a cooldown', () => {
  it('refuses a one-shot recipe that also claims a cooldown', () => {
    // `once` is checked first and spends the run either way, so the cooldown would gate nothing —
    // a recipe that reads as paced and is not.
    const recipe = { ...reusableTwap(), once: true }
    expect(() => compileRecipe(recipe, deployment())).toThrow(/cannot also claim a cooldown/)
  })

  it('refuses allowFailure alongside a cooldown', () => {
    // The `once` rule, for the same reason: a step that fails without reverting lets the activation
    // succeed having done nothing, and the window is burnt until the next one opens.
    const recipe = reusableTwap()
    const twap = recipe.steps.find((step) => step.type === 'twapFromBalance')!
    Object.assign(twap, { allowFailure: true })

    expect(() => compileRecipe(recipe, deployment())).toThrow(/allowFailure in a recipe with a cooldown/)
  })

  it('describes the claim back as a named step', () => {
    // Activation is unsigned, so the only safeguard for whoever funds the address is reading the
    // recipe back. A cooldown that showed up as an unnamed delegatecall would read as the sharp edge
    // the warning is for.
    const compiled = compileRecipe(reusableTwap(), deployment())
    const described = describeRecipe(compiled.setupData, deployment())
    const claim = described.steps[1]!

    expect(claim.known?.contract).toBe('CooldownSteps')
    expect(claim.known?.functionName).toBe('claimCooldown')
    expect(claim.known?.args[0]).toMatchObject({ name: 'cooldownSeconds', value: 43200n })
    expect(claim.warnings).toEqual([])
  })
})
