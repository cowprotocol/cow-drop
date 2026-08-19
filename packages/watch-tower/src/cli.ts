#!/usr/bin/env node
import { getDeployment, LATEST_GENERATION } from '@cowprotocol/cow-drop-sdk'
import { OrderBookApi, type SupportedChainId } from '@cowprotocol/cow-sdk'
import { createPublicClient, http } from 'viem'

import { viemChainReader } from './chain.js'
import { fileCursor, memoryCursor } from './cursor.js'
import { createWatchTower, type Logger } from './watchTower.js'

const USAGE = `cow-drop-watch-tower — post the discrete CoW orders contracts place on-chain

Watches for CowOrderPlaced across a whole chain and submits each order to the CoW order book.
Nothing here is privileged: the orders are already signed on-chain, so this only makes them
visible to solvers, and running two of these is harmless.

Usage:
  cow-drop-watch-tower --rpc-url <url> [options]

Options:
  --rpc-url <url>       RPC endpoint. Defaults to $RPC_URL.
  --chain-id <id>       Chain to watch. Defaults to $CHAIN_ID, else the RPC's own chain id.
  --generation <n>      Contract generation to watch. Defaults to ${LATEST_GENERATION}.
  --from-block <n>      First block when there is no saved state. Default: the current head.
  --state <path>        JSON file to persist the block cursor in. Default: none (memory only).
  --confirmations <n>   Blocks to stay behind the head. Default 2.
  --max-block-range <n> Largest getLogs range. Default 10000.
  --poll <seconds>      Seconds between passes once caught up. Default 15.
  --env <prod|staging>  Which order book to post to. Default prod.
  --only-drops          Post only orders from a cow-drop activation, not every contract's.
  --once                Scan one range and exit. Useful in cron.
  --dry-run             Find and verify orders, post nothing.
  --quiet               Errors only.
  --help                This.
`

type Args = Record<string, string | boolean>

/**
 * `--flag value` and `--flag`, and nothing else.
 *
 * Hand-rolled because the alternative is a dependency, and the whole surface is the list above.
 */
function parseArgs(argv: string[]): Args {
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

function str(args: Args, name: string): string | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`--${name} needs a value`)
  return value
}

function num(args: Args, name: string): number | undefined {
  const value = str(args, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got ${value}`)
  return parsed
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args['help']) {
    console.log(USAGE)
    return
  }

  const rpcUrl = str(args, 'rpc-url') ?? process.env['RPC_URL']
  if (!rpcUrl) throw new Error('an RPC endpoint is required: pass --rpc-url or set $RPC_URL')

  const client = createPublicClient({ transport: http(rpcUrl) })

  // Asking the node rather than requiring the flag: a state file bound to the wrong chain is the
  // failure this avoids, and the node is the only authority on which chain the URL points at.
  const chainId = num(args, 'chain-id') ?? Number(process.env['CHAIN_ID'] ?? 0) ?? 0
  const resolvedChainId = chainId || (await client.getChainId())

  const deployment = getDeployment(resolvedChainId, num(args, 'generation') ?? LATEST_GENERATION)

  const statePath = str(args, 'state')
  const fromBlock = str(args, 'from-block')

  const quiet = args['quiet'] === true
  const logger: Logger = {
    info: (message) => !quiet && console.log(message),
    warn: (message) => !quiet && console.warn(message),
    error: (message) => console.error(message),
  }

  const watchTower = createWatchTower({
    reader: viemChainReader(client),
    orderBook: new OrderBookApi({
      chainId: resolvedChainId as SupportedChainId,
      env: str(args, 'env') === 'staging' ? 'staging' : 'prod',
    }),
    deployment,
    cursor: statePath ? fileCursor(statePath, resolvedChainId) : memoryCursor(),
    fromBlock: fromBlock === undefined ? 'latest' : BigInt(fromBlock),
    confirmations: num(args, 'confirmations') ?? 2,
    maxBlockRange: BigInt(str(args, 'max-block-range') ?? 10_000),
    pollIntervalMs: (num(args, 'poll') ?? 15) * 1000,
    onlyDrops: args['only-drops'] === true,
    dryRun: args['dry-run'] === true,
    logger,
  })

  if (args['once'] === true) {
    const result = await watchTower.tick()
    logger.info(result ? `scanned ${result.fromBlock}-${result.toBlock}` : 'nothing new to scan')
    return
  }

  // SIGINT stops after the tick in flight, so a run is never cut between posting an order and
  // recording the block it came from.
  const stop = new AbortController()
  process.on('SIGINT', () => stop.abort())
  process.on('SIGTERM', () => stop.abort())

  await watchTower.run(stop.signal)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
