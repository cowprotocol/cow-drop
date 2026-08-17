import { decodeFunctionData, toFunctionSelector } from 'viem'
import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'

import { saltOf } from './encoding.js'
import { COW_SHED_EXECUTOR_FACTORY_ABI, DROP_RECIPES_ABI } from './generated/artifacts.js'
import { compileRecipe } from './recipe.js'
import {
  buildDeployOnlyTx,
  buildOwnerSweepTx,
  buildRescueForState,
  buildRescueTx,
  buildSweepCalls,
} from './rescue.js'
import { swapOnArrival } from './templates.js'

const OWNER: Address = '0x1111111111111111111111111111111111111111'
const WXDAI: Address = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'
const COW: Address = '0x177127622c4A00F3d409B75571e12cB3c8973d3c'
const NATIVE: Address = '0x0000000000000000000000000000000000000000'

const compiled = compileRecipe(
  swapOnArrival({
    chainId: 100,
    owner: OWNER,
    sellToken: WXDAI,
    buyToken: COW,
    limitPrice: { price: '0.02', sellDecimals: 18, buyDecimals: 18 },
    salt: `0x${'00'.repeat(31)}09`,
  }),
)

describe('buildSweepCalls', () => {
  it('makes one delegatecall per token', () => {
    const calls = buildSweepCalls({ deployment: compiled.deployment, to: OWNER, tokens: [WXDAI, NATIVE] })

    expect(calls).toHaveLength(2)
    // Must be delegatecalls, or `sweep` would read the helper's own balance.
    expect(calls.every((call) => call.isDelegateCall)).toBe(true)
    expect(calls.every((call) => call.target === compiled.deployment.recipes)).toBe(true)

    const decoded = calls.map((call) => decodeFunctionData({ abi: DROP_RECIPES_ABI, data: call.callData }))
    expect(decoded.map((d) => d.functionName)).toEqual(['sweep', 'sweep'])
    expect(decoded.map((d) => d.args?.[0])).toEqual([WXDAI, NATIVE])
  })

  it('refuses an empty token list and a zero recipient', () => {
    expect(() => buildSweepCalls({ deployment: compiled.deployment, to: OWNER, tokens: [] })).toThrow(
      /at least one token/,
    )
    expect(() =>
      buildSweepCalls({ deployment: compiled.deployment, to: NATIVE, tokens: [WXDAI] }),
    ).toThrow(/non-zero recipient/)
  })
})

describe('buildRescueTx', () => {
  it('targets the factory and passes the commitment back verbatim', () => {
    const calls = buildSweepCalls({ deployment: compiled.deployment, to: OWNER, tokens: [WXDAI] })
    const tx = buildRescueTx({ deployment: compiled.deployment, owner: OWNER, setupData: compiled.setupData, calls })

    expect(tx.to).toBe(compiled.deployment.factory)

    const { functionName, args } = decodeFunctionData({ abi: COW_SHED_EXECUTOR_FACTORY_ABI, data: tx.data })
    expect(functionName).toBe('initializeProxyWithoutSetup')

    // The hatch deploys at the *same* address, so every committed input has to be reproduced
    // exactly: owner, executor (as both trusted executor and setup target), the recipe's own salt,
    // and the setupData itself.
    expect(args?.[0]).toBe(OWNER)
    expect(args?.[1]).toBe(compiled.deployment.executor)
    expect(args?.[2]).toBe(saltOf(compiled.setupData))
    expect(args?.[3]).toBe(compiled.deployment.executor)
    expect(args?.[4]).toBe(compiled.setupData)
    expect(args?.[5]).toHaveLength(1)
  })

  it('buildDeployOnlyTx is the same call with no rescue calls', () => {
    const deployOnly = buildDeployOnlyTx({
      deployment: compiled.deployment,
      owner: OWNER,
      setupData: compiled.setupData,
    })
    const { args } = decodeFunctionData({ abi: COW_SHED_EXECUTOR_FACTORY_ABI, data: deployOnly.data })

    expect(args?.[5]).toHaveLength(0)
    expect(deployOnly.to).toBe(compiled.deployment.factory)
  })
})

describe('buildOwnerSweepTx', () => {
  it('goes straight to the drop, not the factory', () => {
    const tx = buildOwnerSweepTx({
      deployment: compiled.deployment,
      drop: compiled.address,
      to: OWNER,
      tokens: [WXDAI],
    })

    // A deployed drop needs no hatch: the owner is the admin, so `trustedExecuteHooks` on the drop
    // itself is enough.
    expect(tx.to).toBe(compiled.address)
    // Computed rather than hardcoded, so the assertion cannot drift from the real signature.
    expect(tx.data.slice(0, 10)).toBe(
      toFunctionSelector('trustedExecuteHooks((address,uint256,bytes,bool,bool)[])'),
    )
  })
})

describe('buildRescueForState', () => {
  const common = {
    deployment: compiled.deployment,
    owner: OWNER,
    setupData: compiled.setupData,
    drop: compiled.address,
    to: OWNER,
    tokens: [WXDAI],
  }

  it('uses the hatch before deployment', () => {
    const { tx, path } = buildRescueForState({ ...common, deployed: false })
    expect(path).toBe('without-setup')
    expect(tx.to).toBe(compiled.deployment.factory)
  })

  it('goes direct once deployed', () => {
    const { tx, path } = buildRescueForState({ ...common, deployed: true })
    expect(path).toBe('owner-execute')
    expect(tx.to).toBe(compiled.address)
  })
})
