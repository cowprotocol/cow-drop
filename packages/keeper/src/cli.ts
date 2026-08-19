#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { formatEther, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { DEFAULT_POLICY, parsePolicy } from './policy.js'
import { startKeeperService } from './service.js'
import { createLogger } from '@cowprotocol/cow-drop-watch-tower'

const USAGE = `cow-drop-keeper — watch registered drops, activate them, pay the gas

Holds a registry of drops the UI explicitly registered, watches their counterfactual addresses,
and activates each one once the recipe would actually succeed. Runs a watch tower alongside, so
the orders an activation places are posted too.

Registering is not authorisation: activation is permissionless anyway, so this only decides who
pays. What it does spend is real money — see --policy.

Usage:
  cow-drop-keeper --rpc-url <url> --private-key-file <path> [options]

Options:
  --rpc-url <url>            RPC endpoint. Defaults to $RPC_URL.
  --chain-id <id>            Defaults to $CHAIN_ID, else whatever the RPC says.
  --generation <n>           Contract generation. Defaults to the SDK's latest.
  --private-key-file <path>  File holding the hot key. Defaults to $KEEPER_PRIVATE_KEY.
  --policy <path>            JSON subsidy policy. Defaults to subsidise-all with small budgets.
  --state <path>             Registry and spend ledger. Default out/keeper/state-<chainId>.json.
  --cursor <path>            Watch tower block cursor. Default out/keeper/cursor-<chainId>.json.
  --port <n>                 HTTP port. Default 8787.
  --allow-origin <origins>   CORS origins, comma separated. Default *.
  --poll <seconds>           Seconds between passes. Default 12.
  --min-balance <native>     Warn at boot below this balance. Defaults to $KEEPER_MIN_BALANCE, else 0.1.
  --env <prod|staging>       Which order book to post to. Default prod.
  --dry-run                  Decide and simulate everything, broadcast nothing.
  --quiet                    Errors only.
  --help                     This.

Browsable API docs are served at http://localhost:<port>/v1/docs once it is up.

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
  return {
    statePath: str(args, 'state') ?? `out/keeper/state-${chainId}.json`,
    cursorPath: str(args, 'cursor') ?? `out/keeper/cursor-${chainId}.json`,
  }
}

/** Resolve the configuration, print it, and run the service until a signal stops it. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args['help']) {
    console.log(USAGE)
    return
  }

  const rpcUrl = str(args, 'rpc-url') ?? process.env['RPC_URL']
  if (!rpcUrl) throw new Error('an RPC endpoint is required: pass --rpc-url or set $RPC_URL')

  const account = privateKeyToAccount(await loadPrivateKey(args))

  const policyPath = str(args, 'policy')
  const policy = policyPath ? parsePolicy(JSON.parse(await readFile(policyPath, 'utf8'))) : DEFAULT_POLICY

  const chainId = num(args, 'chain-id') ?? Number(process.env['CHAIN_ID'] ?? 0)
  const resolvedChainId = chainId || (await chainIdFromRpc(rpcUrl))

  // After the chain is resolved, not before: every line this process prints carries the chain, and a
  // boot banner logged under the wrong one is exactly the confusion the prefix exists to remove.
  const logger = createLogger({ name: 'keeper', chainId: resolvedChainId, quiet: args['quiet'] === true })

  const { statePath, cursorPath } = resolvePaths(args, resolvedChainId)

  const port = num(args, 'port') ?? 8787
  const pollSeconds = num(args, 'poll') ?? 12
  const dryRun = args['dry-run'] === true
  const minBalanceWarnWei = parseEther(str(args, 'min-balance') ?? process.env['KEEPER_MIN_BALANCE'] ?? '0.1')

  // The whole configuration, at boot, before the first RPC call that can hang.
  //
  // This process spends real money on behalf of whoever can reach it, and every line here changes how
  // much and for whom. Printing it is what makes a running keeper auditable from its logs alone
  // rather than from whichever shell invocation someone has since scrolled past.
  logger.info(`starting — generation ${num(args, 'generation') ?? 'latest'}`)
  logger.info(`paying from payer ${account.address}`)
  logger.info(`state ${statePath}`)
  logger.info(`block cursor ${cursorPath}`)
  logger.info(
    `policy ${policy.mode}, ${policy.dailyBudgetWei} wei/day` +
      `${policy.perOwnerDailyBudgetWei > 0n ? `, ${policy.perOwnerDailyBudgetWei} wei/day per owner` : ''}`,
  )
  logger.info(`polling every ${pollSeconds}s`)
  logger.info(`warning below ${formatEther(minBalanceWarnWei)} native`)
  if (policy.mode === 'all') {
    // Said out loud, because the default is the risky one: `owner` comes from the submitted recipe,
    // so per-owner caps do not bind and the daily budget is the only thing that does.
    logger.warn(
      `subsidising every owner, capped at ${policy.dailyBudgetWei} wei per day. ` +
        `Anyone who can reach this service can spend that.`,
    )
  }
  if (dryRun) logger.warn('dry run: everything is decided and simulated, nothing is broadcast')

  const service = await startKeeperService({
    rpcUrl,
    chainId: resolvedChainId,
    generation: num(args, 'generation'),
    account,
    policy,
    statePath,
    cursorPath,
    port,
    allowOrigin: str(args, 'allow-origin') ?? '*',
    pollIntervalMs: pollSeconds * 1000,
    dryRun,
    env: str(args, 'env') === 'staging' ? 'staging' : 'prod',
    minBalanceWarnWei,
    logger,
  })

  // Stop after the tick in flight, so a run is never cut between broadcasting and recording it.
  const stop = new AbortController()
  process.on('SIGINT', () => stop.abort())
  process.on('SIGTERM', () => stop.abort())

  await service.run(stop.signal)
  await service.close()
}

/** Ask the endpoint which chain it is, for when neither the flag nor the environment says. */
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
