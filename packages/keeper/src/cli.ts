#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { formatEther, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { DEFAULT_POLICY, TYPICAL_ACTIVATION_GAS, activationCostAt, defaultPolicyFor, parsePolicy } from './policy.js'
import { startKeeperService } from './service.js'
import { createLogger } from '@cowprotocol/cow-drop-watch-tower'
import { getChainInfo, type SupportedChainId } from '@cowprotocol/cow-sdk'

const USAGE = `cow-drop-keeper — watch registered drops, activate them, pay the gas

Holds a registry of drops the UI explicitly registered, watches their counterfactual addresses,
and activates each one once the recipe would actually succeed. Runs a watch tower alongside, so
the orders an activation places are posted too.

Registering is not authorisation: activation is permissionless anyway, so this only decides who
pays. What it does spend is real money — see --policy.

Usage:
  cow-drop-keeper --chains 100,1,8453 --private-key-file <path> [options]
  cow-drop-keeper --rpc-url <url> --private-key-file <path> [options]     (one chain)

One process keeps any number of chains, each served under its CoW network name:
http://localhost:8787/xdai/v1/drops, /mainnet/v1/…, /base/v1/… — GET /v1/networks lists them.

Options:
  --chains <ids>             Chain ids to keep, comma separated. Defaults to $CHAINS. Each chain's RPC
                             is $RPC_URL_<chainId>, falling back to a public endpoint (with a warning).
  --rpc-url <url>            One chain only: its RPC. Defaults to $RPC_URL.
  --chain-id <id>            One chain only. Defaults to $CHAIN_ID, else whatever the RPC says.
  --generation <n>           Contract generation. Defaults to the SDK's latest.
  --private-key-file <path>  File holding the hot key. Defaults to $KEEPER_PRIVATE_KEY.
  --policy <path>            JSON subsidy policy: one policy for every chain, or one per chain keyed by
                             chain id ({"100": {…}, "1": {…}}). Omitted fields fall back to limits sized
                             from that chain's gas price. Default: subsidise-all within those limits.
  --state-dir <dir>          Where each chain's state-<id>.json and cursor-<id>.json live.
                             Default out/keeper.
  --state <path>             One chain only: the registry and spend ledger file.
  --cursor <path>            One chain only: the watch tower block cursor file.
  --port <n>                 HTTP port. Default 8787.
  --allow-origin <origins>   CORS origins, comma separated. Default *.
  --poll <seconds>           Seconds between passes. Default 12.
  --min-balance <native>     Warn at boot below this balance. Defaults to $KEEPER_MIN_BALANCE, else 0.1.
  --env <prod|staging>       Which order book to post to. Default prod.
  --dry-run                  Decide and simulate everything, broadcast nothing.
  --quiet                    Errors only.
  --help                     This.

Browsable API docs are served at http://localhost:<port>/<network>/v1/docs once it is up.

The hot key is read from a file or the environment, never from the command line: an argument is
readable by every other process on the machine.
`

type Args = Record<string, string | boolean>

/** `--flag value` and `--flag`, and nothing else. The whole surface is the list above. */
export function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`)
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[name] = true
    else {
      args[name] = next
      i++
    }
  }
  return args
}

/** A flag's string value, or undefined. Present-but-valueless is an error, not an empty string. */
function str(args: Args, name: string): string | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`--${name} needs a value`)
  return value
}

/** A flag's numeric value, or undefined. */
function num(args: Args, name: string): number | undefined {
  const value = str(args, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got ${value}`)
  return parsed
}

/**
 * The hot key, from a file or the environment.
 *
 * Never from argv, and `--private-key` is rejected rather than ignored: a key on a command line is
 * visible in `ps` and in shell history to anything running on the same box.
 */
export async function loadPrivateKey(args: Args): Promise<`0x${string}`> {
  if (args['private-key'] !== undefined) {
    throw new Error('refusing --private-key: it is visible in `ps`. Use --private-key-file, or $KEEPER_PRIVATE_KEY.')
  }

  const path = str(args, 'private-key-file')
  const raw = path ? await readFile(path, 'utf8') : process.env['KEEPER_PRIVATE_KEY']
  if (!raw) {
    throw new Error('a hot key is required: pass --private-key-file, or set $KEEPER_PRIVATE_KEY')
  }

  const key = raw.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('the private key must be 32 bytes of hex with an 0x prefix')
  return key as `0x${string}`
}

/**
 * Where the registry, the spend ledger and the block cursor live when nothing says otherwise.
 *
 * On disk rather than in memory, because both files exist to survive a restart: the registry holds
 * drops nobody else knows about, and the ledger holds the day's spend — a memory-only default
 * resets the daily budget on every crash, which is the moment the budget matters most.
 *
 * Chain-scoped, because a process serves one chain and two of them sharing a working directory
 * would otherwise fight over the same file.
 */
export function resolvePaths(args: Args, chainId: number): { statePath: string; cursorPath: string } {
  const dir = (str(args, 'state-dir') ?? 'out/keeper').replace(/\/+$/, '')
  return {
    statePath: str(args, 'state') ?? `${dir}/state-${chainId}.json`,
    cursorPath: str(args, 'cursor') ?? `${dir}/cursor-${chainId}.json`,
  }
}

/**
 * The chains to keep, and the RPC each is reached on.
 *
 * `--chains` (or `$CHAINS`) is the multi-chain form: each chain reads `$RPC_URL_<chainId>`, else the
 * public endpoint cow-sdk names, which works and is rate limited — fine to try, wrong to rely on for a
 * key that pays gas, so it is flagged. Without `--chains`, the single-chain form stands as it always did:
 * `--rpc-url` / `$RPC_URL`, with the chain id from `--chain-id`, `$CHAIN_ID` or the RPC itself.
 *
 * The per-file flags (`--state`, `--cursor`, `--rpc-url`) name one chain's resources, so they are
 * refused alongside several chains rather than silently applied to all of them.
 */
export function resolveChains(
  args: Args,
  env: Record<string, string | undefined> = process.env,
): { chainId: number | undefined; rpcUrl: string | undefined; publicRpc: boolean }[] {
  const list = str(args, 'chains') ?? env['CHAINS']

  if (list === undefined || list.trim() === '') {
    const rpcUrl = str(args, 'rpc-url') ?? env['RPC_URL']
    if (!rpcUrl) {
      throw new Error('say which chains to keep: --chains 100,1 (or $CHAINS), or --rpc-url for a single chain')
    }
    const chainId = num(args, 'chain-id') ?? (Number(env['CHAIN_ID'] ?? 0) || undefined)
    return [{ chainId, rpcUrl, publicRpc: false }]
  }

  const chainIds = list.split(',').map((part) => {
    const id = Number(part.trim())
    if (!Number.isInteger(id) || id <= 0) throw new Error(`--chains: ${JSON.stringify(part.trim())} is not a chain id`)
    return id
  })
  if (new Set(chainIds).size !== chainIds.length) throw new Error('--chains names a chain twice')

  if (chainIds.length > 1) {
    for (const flag of ['rpc-url', 'chain-id', 'state', 'cursor']) {
      if (args[flag] !== undefined) {
        throw new Error(`--${flag} names one chain's resource; with several chains use ${flag === 'rpc-url' ? '$RPC_URL_<chainId>' : '--state-dir'}`)
      }
    }
  }

  return chainIds.map((chainId) => {
    const configured = env[`RPC_URL_${chainId}`] ?? (chainIds.length === 1 ? (str(args, 'rpc-url') ?? env['RPC_URL']) : undefined)
    return { chainId, rpcUrl: configured, publicRpc: configured === undefined }
  })
}

/**
 * The policy for one chain, from a file that holds either one policy for every chain or one per chain
 * keyed by chain id. Budgets are in each chain's native token, so a shared file is usually the wrong
 * shape for more than one chain — but it is what a single-chain keeper always took.
 */
export function policyFor(raw: unknown, chainId: number): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const keys = Object.keys(raw)
  const keyed = keys.length > 0 && keys.every((key) => /^\d+$/.test(key))
  if (!keyed) return raw
  const entry = (raw as Record<string, unknown>)[String(chainId)]
  if (entry === undefined) {
    throw new Error(`the policy file has entries for chains ${keys.join(', ')} but none for ${chainId}`)
  }
  return entry
}

/** Resolve the configuration, print it, and run the service until a signal stops it. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args['help']) {
    console.log(USAGE)
    return
  }

  const account = privateKeyToAccount(await loadPrivateKey(args))
  const quiet = args['quiet'] === true
  const logger = createLogger({ name: 'keeper', quiet })

  const policyPath = str(args, 'policy')
  const policyFile: unknown = policyPath ? JSON.parse(await readFile(policyPath, 'utf8')) : undefined

  const pollSeconds = num(args, 'poll') ?? 12
  const dryRun = args['dry-run'] === true
  const minBalanceWarnWei = parseEther(str(args, 'min-balance') ?? process.env['KEEPER_MIN_BALANCE'] ?? '0.1')
  const env = str(args, 'env') === 'staging' ? 'staging' : 'prod'
  const generation = num(args, 'generation')

  // The whole configuration, at boot, before the first RPC call that can hang.
  //
  // This process spends real money on behalf of whoever can reach it, and every line here changes how
  // much and for whom. Printing it is what makes a running keeper auditable from its logs alone
  // rather than from whichever shell invocation someone has since scrolled past.
  logger.info(`starting — generation ${generation ?? 'latest'}, paying from payer ${account.address}`)
  logger.info(`polling every ${pollSeconds}s, warning below ${formatEther(minBalanceWarnWei)} native`)
  if (dryRun) logger.warn('dry run: everything is decided and simulated, nothing is broadcast')

  const chains = []
  for (const resolved of resolveChains(args)) {
    const rpcUrl = resolved.rpcUrl ?? publicRpcUrl(resolved.chainId!)
    const chainId = resolved.chainId ?? (await chainIdFromRpc(rpcUrl))
    chains.push(await configureChain({ args, chainId, rpcUrl, publicRpc: resolved.publicRpc, policyFile, quiet }))
  }

  const service = await startKeeperService({
    account,
    port: num(args, 'port') ?? 8787,
    allowOrigin: str(args, 'allow-origin') ?? '*',
    logger,
    chains: chains.map((chain) => ({
      ...chain,
      generation,
      pollIntervalMs: pollSeconds * 1000,
      dryRun,
      env,
      minBalanceWarnWei,
    })),
  })

  // Stop after the tick in flight, so a run is never cut between broadcasting and recording it.
  const stop = new AbortController()
  process.on('SIGINT', () => stop.abort())
  process.on('SIGTERM', () => stop.abort())

  await service.run(stop.signal)
  await service.close()
}

/**
 * One chain's resolved configuration, printed as it is resolved.
 *
 * The policy is sized from the chain's own gas price rather than from a constant, because two of the
 * limits mean nothing in absolute wei: the same 0.02 native is five activations of reserve on Ethereum
 * and six thousand on Base. Sampled once, here, so `/v1/health` stays a cheap read and the numbers hold
 * still for the process — an operator reading a log line needs the figure that will actually apply.
 */
async function configureChain(params: {
  args: Args
  chainId: number
  rpcUrl: string
  publicRpc: boolean
  policyFile: unknown
  quiet: boolean
}) {
  const { args, chainId, rpcUrl, publicRpc, policyFile, quiet } = params

  // Every line about this chain carries it, so several chains in one log stay readable.
  const logger = createLogger({ name: 'keeper', chainId, quiet })

  const activationCostWei = activationCostAt(await gasPriceFromRpc(rpcUrl))
  const defaults = defaultPolicyFor(activationCostWei)
  const policy = policyFile === undefined ? defaults : parsePolicy(policyFor(policyFile, chainId), defaults)
  const { statePath, cursorPath } = resolvePaths(args, chainId)

  if (publicRpc) {
    logger.warn(`no $RPC_URL_${chainId}: using the public endpoint ${rpcUrl}, which is rate limited`)
  }
  logger.info(`state ${statePath}, block cursor ${cursorPath}`)
  logger.info(
    `policy ${policy.mode}, ${policy.dailyBudgetWei} wei/day` +
      `${policy.perOwnerDailyBudgetWei > 0n ? `, ${policy.perOwnerDailyBudgetWei} wei/day per owner` : ''}`,
  )
  // The floor and the per-activation cap, in the unit that makes them legible. A refusal naming only
  // the wei figure is unreadable — "below its 20000000000000000 floor" tells you nothing about whether
  // that is one activation or six thousand.
  logger.info(
    `one activation costs about ${formatEther(activationCostWei)} native here, so the floor is ` +
      `${formatEther(policy.minPayerBalanceWei)} (${policy.minPayerBalanceWei / activationCostWei} activations) ` +
      `and one activation may cost up to ${formatEther(policy.maxCostPerActivationWei)}`,
  )
  if (policy.mode === 'all') {
    // Said out loud, because the default is the risky one: `owner` comes from the submitted recipe,
    // so per-owner caps do not bind and the daily budget is the only thing that does.
    logger.warn(
      `subsidising every owner, capped at ${policy.dailyBudgetWei} wei per day. ` +
        `Anyone who can reach this service can spend that.`,
    )
  }

  return { chainId, rpcUrl, policy, statePath, cursorPath, logger }
}

/**
 * The public RPC for a chain, for when `$RPC_URL_<chainId>` is unset.
 *
 * cow-sdk's endpoint, except where it does not answer — the same overrides the web app carries.
 */
export function publicRpcUrl(chainId: number): string {
  const override = PUBLIC_RPC_OVERRIDES[chainId]
  if (override) return override
  const info = getChainInfo(chainId as SupportedChainId)
  const url = info && 'rpcUrls' in info ? info.rpcUrls.default.http[0] : undefined
  if (!url) throw new Error(`no public RPC known for chain ${chainId}; set $RPC_URL_${chainId}`)
  return url
}

const PUBLIC_RPC_OVERRIDES: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  137: 'https://polygon-bor-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
}

/** Ask the endpoint which chain it is, for when neither the flag nor the environment says. */
/**
 * The chain's current gas price, for sizing the defaults.
 *
 * `eth_gasPrice` rather than a fee-history percentile: this only has to be the right *order of
 * magnitude*, and the difference between chains is three orders. A chain that will not answer falls
 * back to Ethereum-shaped numbers, which are conservative everywhere — the failure mode is a keeper
 * that reserves too much, not one that spends too much.
 */
async function gasPriceFromRpc(rpcUrl: string): Promise<bigint> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }),
    })
    const body = (await response.json()) as { result?: string }
    const price = body.result ? BigInt(body.result) : 0n
    if (price > 0n) return price
  } catch {
    // Fall through to the conservative default below.
  }
  return DEFAULT_POLICY.minPayerBalanceWei / TYPICAL_ACTIVATION_GAS
}

async function chainIdFromRpc(rpcUrl: string): Promise<number> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  })
  const body = (await response.json()) as { result?: string }
  if (!body.result) throw new Error(`could not read the chain id from ${rpcUrl}`)
  return Number(BigInt(body.result))
}

/**
 * Only run when this file *is* the program.
 *
 * `cli.test.ts` imports `parseArgs` and `loadPrivateKey` from here, and a bare `main()` at module
 * scope would run the whole keeper on import — failing for want of an RPC url and, worse, setting
 * `process.exitCode` so a passing test run still exits non-zero.
 */
const entryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (entryPoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
