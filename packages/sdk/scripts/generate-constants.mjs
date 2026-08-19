#!/usr/bin/env node
/**
 * Generates the SDK's ABIs, proxy creation code and per-chain addresses from the foundry build.
 *
 * Hand-transcribing any of these is how a drop address quietly becomes wrong: the shed
 * implementation address and the proxy creation code both feed the CREATE2 init code, so a stale
 * copy here means the SDK quotes an address that the contract will never deploy to. The build is
 * the single source of truth; this script just moves it.
 *
 * Run `forge build` (and `forge script script/Deploy.s.sol` for the addresses) first.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const contracts = resolve(here, '../../../contracts')
const outDir = resolve(here, '../src/generated')

function artifact(path) {
  const full = join(contracts, 'out', path)
  try {
    return JSON.parse(readFileSync(full, 'utf8'))
  } catch (error) {
    throw new Error(`missing artifact ${full} — run \`forge build\` in contracts/ first`, { cause: error })
  }
}

const proxy = artifact('COWShedProxy.sol/COWShedProxy.json')
const executor = artifact('DropExecutor.sol/DropExecutor.json')
const factory = artifact('COWShedExecutorFactory.sol/COWShedExecutorFactory.json')

// CoW's own on-chain order announcement, generated from the interface that redeclares it rather than
// from any contract that emits it — which is the point. An indexer decodes `OrderPlacement` from
// contracts this SDK has never heard of, including EthFlow's, and must not learn the shape from a
// cow-drop step. `test/OnchainOrders.t.sol` is what holds the redeclaration to the canonical topic0.
const onchainOrders = artifact('ICoWSwapOnchainOrders.sol/ICoWSwapOnchainOrders.json')
const cowOrderPoster = artifact('CowOrderPoster.sol/CowOrderPoster.json')

// One ABI per step contract. They are separate deployments so that each address depends only on what
// that contract needs — see `contracts/src/steps/`. Keeping the ABIs separate here is what lets a
// decoder resolve a step by `(target, selector)` rather than guessing.
const guards = artifact('GuardSteps.sol/GuardSteps.json')
const tokenOps = artifact('TokenSteps.sol/TokenSteps.json')
const presign = artifact('PresignSteps.sol/PresignSteps.json')
const twap = artifact('TwapSteps.sol/TwapSteps.json')
const stopLoss = artifact('StopLossSteps.sol/StopLossSteps.json')

const proxyCreationCode = proxy.bytecode.object
if (!proxyCreationCode || proxyCreationCode === '0x') {
  throw new Error('COWShedProxy creation code is empty — the build looks incomplete')
}

// Deployment records, one JSON per (generation, chain), written by script/Deploy.s.sol into
// deployments/gen<N>/<chainId>.json.
//
// Generations are kept rather than replaced. Every one of these addresses is part of the CREATE2
// preimage of every drop, so a redeploy moves every drop address — and a recipe file written against
// an older generation has to keep resolving to the address its author funded. Past generations stay
// deployed; this table is how the SDK still reaches them.
//
// Within a generation the addresses are chain-independent: every input to their CREATE2 derivation is
// itself deployed deterministically from addresses that are identical everywhere. So any record of a
// generation supplies them all — but if several exist they must agree, and disagreeing means something
// in the build changed between runs, which is worth failing on rather than silently picking one.
const deploymentsDir = join(contracts, 'deployments')
const FIELDS = [
  'factory',
  'executor',
  'guardSteps',
  'tokenSteps',
  'presignSteps',
  'twapSteps',
  'stopLossSteps',
  'cowOrderPoster',
  'settlement',
  'composableCow',
  'shedImplementation',
]

const byGeneration = new Map()
for (const dir of readdirSync(deploymentsDir)) {
  const generation = /^gen(\d+)$/.exec(dir)
  if (!generation) continue
  for (const file of readdirSync(join(deploymentsDir, dir))) {
    if (!/^\d+\.json$/.test(file)) continue
    const record = JSON.parse(readFileSync(join(deploymentsDir, dir, file), 'utf8'))
    if (record.generation !== Number(generation[1])) {
      throw new Error(
        `${dir}/${file} says generation ${record.generation} but sits in ${dir} — ` +
          `one of the two is wrong, and guessing which would put a wrong address in the SDK`,
      )
    }
    const records = byGeneration.get(record.generation) ?? []
    records.push(record)
    byGeneration.set(record.generation, records)
  }
}
if (byGeneration.size === 0) {
  throw new Error('no deployment records — run `forge script script/Deploy.s.sol` in contracts/ first')
}

const generations = [...byGeneration.keys()].sort((a, b) => a - b)
const latestGeneration = generations[generations.length - 1]

/** One address set per generation, having checked every record of that generation agrees. */
const addressesByGeneration = new Map()
for (const generation of generations) {
  const records = byGeneration.get(generation)
  const addresses = Object.fromEntries(FIELDS.map((field) => [field, records[0][field]]))
  for (const record of records.slice(1)) {
    for (const field of FIELDS) {
      if (record[field] !== addresses[field]) {
        throw new Error(
          `generation ${generation} records disagree on ${field}: ` +
            `${addresses[field]} (chain ${records[0].chainId}) vs ${record[field]} (chain ${record.chainId}). ` +
            `These addresses must be chain-independent.`,
        )
      }
    }
  }
  addressesByGeneration.set(generation, addresses)
}

const addresses = addressesByGeneration.get(latestGeneration)
const records = byGeneration.get(latestGeneration)

const banner = `// GENERATED by scripts/generate-constants.mjs — do not edit by hand.
// Regenerate with: pnpm --filter @cowprotocol/cow-drop-sdk generate
`

writeFileSync(
  join(outDir, 'artifacts.ts'),
  `${banner}
import type { Hex } from 'viem'

/** \`type(COWShedProxy).creationCode\`, the first half of every drop's CREATE2 init code. */
export const PROXY_CREATION_CODE: Hex = '${proxyCreationCode}'

/**
 * \`OrderPlacement\` and \`OrderInvalidation\`, CoW's own on-chain order events. Tied to no contract:
 * anything that pre-signs a CoW order can emit them, so an indexer filters on the topic0 alone.
 */
export const ONCHAIN_ORDERS_ABI = ${JSON.stringify(onchainOrders.abi, null, 2)} as const

/** The deployed helper: pre-sign and announce in one delegatecall, or announce what you signed. */
export const COW_ORDER_POSTER_ABI = ${JSON.stringify(cowOrderPoster.abi, null, 2)} as const

export const GUARD_STEPS_ABI = ${JSON.stringify(guards.abi, null, 2)} as const

export const TOKEN_STEPS_ABI = ${JSON.stringify(tokenOps.abi, null, 2)} as const

export const PRESIGN_STEPS_ABI = ${JSON.stringify(presign.abi, null, 2)} as const

export const TWAP_STEPS_ABI = ${JSON.stringify(twap.abi, null, 2)} as const

export const STOP_LOSS_STEPS_ABI = ${JSON.stringify(stopLoss.abi, null, 2)} as const

export const DROP_EXECUTOR_ABI = ${JSON.stringify(executor.abi, null, 2)} as const

export const COW_SHED_EXECUTOR_FACTORY_ABI = ${JSON.stringify(factory.abi, null, 2)} as const
`,
)

writeFileSync(
  join(outDir, 'deployments.ts'),
  `${banner}
import { DROP_CHAINS, getDropChain } from '../chains.js'
import type { DropAddresses, DropDeployment } from '../types.js'
import { PROXY_CREATION_CODE } from './artifacts.js'

/**
 * The contract addresses, per generation. Identical on every chain within a generation — see
 * \`chains.ts\` for why.
 *
 * A generation is one deployment of the stack. Every address here feeds the CREATE2 preimage of every
 * drop, so a new generation means new drop addresses for the same recipe — which is why old ones are
 * kept rather than replaced. A recipe file pinned to generation N keeps resolving to the address its
 * author funded, forever.
 */
export const GENERATIONS: Record<number, DropAddresses> = {
${generations
  .map((generation) => {
    const a = addressesByGeneration.get(generation)
    return `  ${generation}: {
${FIELDS.map((field) => `    ${field}: '${a[field]}',`).join('\n')}
  },`
  })
  .join('\n')}
}

/** The generation a recipe gets when it does not ask for one. */
export const LATEST_GENERATION = ${latestGeneration}

/**
 * The latest generation's addresses.
 * Recorded from: ${records.map((r) => `chain ${r.chainId}`).join(', ')}.
 */
export const ADDRESSES = GENERATIONS[LATEST_GENERATION]!

/** Every chain cow-drop supports, keyed by id, at the latest generation. */
export const DEPLOYMENTS: Record<number, DropDeployment> = Object.fromEntries(
  DROP_CHAINS.map((chain) => [chain.chainId, getDeployment(chain.chainId)]),
)

export function getDeployment(chainId: number, generation: number = LATEST_GENERATION): DropDeployment {
  if (!getDropChain(chainId)) {
    throw new Error(\`cow-drop does not support chain \${chainId}\`)
  }
  const addresses = GENERATIONS[generation]
  if (!addresses) {
    // Deliberately distinct from the unsupported-chain error: this one means the recipe is newer (or
    // older) than the SDK, and the fix is a version bump rather than a different chain.
    throw new Error(
      \`unknown cow-drop generation \${generation}; this SDK knows \${Object.keys(GENERATIONS).join(', ')}\`,
    )
  }
  return { chainId, generation, ...addresses, proxyCreationCode: PROXY_CREATION_CODE }
}
`,
)

console.log(
  `generated artifacts.ts and deployments.ts from ${records.length} record(s) ` +
    `across generation(s) ${generations.join(', ')} (latest ${latestGeneration}): ` +
    `factory ${addresses.factory}, executor ${addresses.executor}`,
)
