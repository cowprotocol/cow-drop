import { compileRecipe, getDeployment, type DropRecipeJson, type DropStepJson } from '@cowprotocol/cow-drop-sdk'
import type { Address } from 'viem'

import { deriveHints, HINTS_VERSION } from './hints.js'
import type { RegisteredDrop } from './types.js'

/**
 * Builders for the tests. Not shipped — `tsconfig.build.json` excludes it.
 *
 * Recipes go through `compileRecipe` rather than being hand-written records, so a fixture cannot drift
 * into describing a drop the SDK would never produce.
 */
export const CHAIN_ID = 100
export const GENERATION = 1

export const OWNER: Address = '0x00000000000000000000000000000000000a11ce'
export const WXDAI: Address = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'
export const COW: Address = '0x177127622c4A00F3d409B75571e12cB3c8973d3c'

export function deployment() {
  return getDeployment(CHAIN_ID, GENERATION)
}

/** A swap-on-arrival recipe, with whatever steps a test needs instead of the default one. */
export function recipeJson(overrides: Partial<DropRecipeJson> = {}): DropRecipeJson {
  const steps: DropStepJson[] = overrides.steps ?? [
    {
      type: 'presignSellAll',
      sellToken: WXDAI,
      buyToken: COW,
      limitPrice: { price: '45', sellDecimals: 18, buyDecimals: 18 },
      validitySeconds: 1800,
    },
  ]

  return {
    version: 1,
    generation: GENERATION,
    label: 'test drop',
    chainId: CHAIN_ID,
    owner: OWNER,
    once: true,
    ...overrides,
    steps,
  }
}

/** A stored record for a recipe, as `registerDrop` would have written it. */
export function registered(overrides: Partial<RegisteredDrop> = {}): RegisteredDrop {
  const recipe = overrides.recipe ?? recipeJson()
  const compiled = compileRecipe(recipe)

  return {
    address: compiled.address.toLowerCase() as Address,
    chainId: CHAIN_ID,
    generation: GENERATION,
    owner: recipe.owner.toLowerCase() as Address,
    label: recipe.label,
    recipe,
    setupData: compiled.setupData,
    status: 'watching',
    hints: deriveHints(recipe),
    hintsVersion: HINTS_VERSION,
    registeredAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    everFunded: false,
    activations: [],
    backoff: { failures: 0, nextAttemptAt: 0 },
    ...overrides,
  }
}

/** A clock a test drives by hand. The day boundary is the thing most worth pinning. */
export function manualClock(start = Date.UTC(2026, 0, 15, 12, 0, 0)) {
  let at = start
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms
    },
    set: (to: number) => {
      at = to
    },
  }
}

// --- chain and submitter fakes -------------------------------------------------------------------

/**
 * A chain a test drives by hand.
 *
 * Records the order calls arrive in, which is how the crash-safety invariant is asserted: the store
 * write has to happen before the broadcast, and only call ordering can show that.
 */
export function fakeChain(setup: {
  balances?: bigint[]
  simulate?: import('./chain.js').SimulationResult
  receipt?: { status: 'success' | 'reverted'; blockNumber: bigint; costWei: bigint }
  nonce?: number
  head?: bigint
  maxFeePerGas?: bigint
} = {}) {
  const calls: string[] = []
  const state = {
    balances: setup.balances ?? [0n],
    simulate: setup.simulate ?? ({ ok: true, gas: 300_000n } as import('./chain.js').SimulationResult),
    receipt: setup.receipt,
    nonce: setup.nonce ?? 0,
    head: setup.head ?? 1000n,
    maxFeePerGas: setup.maxFeePerGas ?? 10n ** 9n,
  }

  const chain: import('./chain.js').KeeperChain = {
    getBlockNumber: async () => state.head,
    getBalances: async (requests) => {
      calls.push('getBalances')
      return requests.map((_, index) => state.balances[index] ?? state.balances[0] ?? 0n)
    },
    simulateActivation: async () => {
      calls.push('simulate')
      return state.simulate
    },
    getFees: async () => ({ maxFeePerGas: state.maxFeePerGas, maxPriorityFeePerGas: 10n ** 8n }),
    getTransactionCount: async () => state.nonce,
    getReceipt: async () => state.receipt,
  }

  return { chain, calls, state }
}

export function fakeSubmitter(calls: string[], balance = 10n ** 18n) {
  let broadcasts = 0
  let failNext: Error | undefined

  const submitter: import('./chain.js').Submitter = {
    payer: async () => '0x00000000000000000000000000000000000cafe0',
    balance: async () => balance,
    prepare: async ({ gasLimit, maxFeePerGas, maxPriorityFeePerGas, nonce }) => {
      calls.push('prepare')
      return {
        ref: `0x${'ab'.repeat(32)}`,
        nonce,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        payload: '0x00',
      }
    },
    broadcast: async () => {
      calls.push('broadcast')
      broadcasts++
      if (failNext) throw failNext
    },
  }

  return {
    submitter,
    get broadcasts() {
      return broadcasts
    },
    failBroadcast: (error: Error) => {
      failNext = error
    },
  }
}
