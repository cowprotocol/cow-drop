import { getDeployment, getDropChain } from '@cowprotocol/cow-drop-sdk'
import { OrderBookApi, type SupportedChainId } from '@cowprotocol/cow-sdk'
import {
  createWatchTower,
  fileCursor,
  memoryCursor,
  silentLogger,
  viemChainReader,
  type Logger,
} from '@cowprotocol/cow-drop-watch-tower'
import type { Server } from 'node:http'
import { formatEther, type Address, type PublicClient } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'

import { keeperClient, viemKeeperChain, viemSubmitter } from './chain.js'
import { createEventBus } from './events.js'
import { createKeeper } from './keeper.js'
import { forwardOrderResults } from './orders.js'
import { DEFAULT_POLICY } from './policy.js'
import { orderBookPaymentQuoter, orderBookPrices } from './revenue.js'
import { createMultiChainServer, type ChainMount } from './multiChain.js'
import { createKeeperHandler, ROUTES } from './server.js'
import { fileStore, memoryStore, utcDay, type KeeperStore } from './store.js'
import type { DropStatus, SubsidyPolicy } from './types.js'
import { knownAppDataDocument } from '@cowprotocol/cow-drop-sdk'

/** One chain this process keeps: where to reach it, and how to run its keeper there. */
export interface ChainKeeperOptions {
  rpcUrl: string
  chainId: number
  generation?: number
  policy?: SubsidyPolicy
  /** Path for the registry and the spend ledger. Omit for memory only. */
  statePath?: string
  /** Separate file for the watch tower's block cursor. */
  cursorPath?: string
  pollIntervalMs?: number
  dryRun?: boolean
  env?: 'prod' | 'staging'
  /** Should name the chain: every line it prints is about that chain alone. */
  logger?: Logger
  /**
   * Warn at boot when the payer holds less than this.
   *
   * Advisory and distinct from `policy.minPayerBalanceWei`, which is a hard floor the spend gate
   * refuses to cross. This one is the earlier signal: still able to pay, but not for long. Default
   * 0.1 native.
   */
  minBalanceWarnWei?: bigint
  client?: PublicClient
  store?: KeeperStore
}

export interface KeeperServiceOptions {
  chains: readonly ChainKeeperOptions[]
  /** One hot key for every chain. Its nonce is per chain, so sharing it across chains is safe. */
  account: PrivateKeyAccount
  port?: number
  allowOrigin?: string
  /** For what is not about one chain: the HTTP server and its routes. */
  logger?: Logger
}

export interface KeeperService {
  server: Server
  /** Runs every chain's loops until the signal aborts. */
  run(signal: AbortSignal): Promise<void>
  close(): Promise<void>
}

/**
 * Wire the whole thing together: for each chain a registry, watcher, activator and the watch tower
 * that posts; and one HTTP server in front of them all.
 *
 * Each chain is fully separate — its own RPC, store, budget, nonce and cursor — because those are all
 * per chain on-chain too. What is shared is the process, the hot key and the port: the server mounts
 * each chain under its CoW network name (`/xdai/v1/…`), see `createMultiChainServer`.
 */
export async function startKeeperService(options: KeeperServiceOptions): Promise<KeeperService> {
  const { chains, account, port = 8787, allowOrigin = '*', logger = silentLogger } = options
  if (chains.length === 0) throw new Error('the keeper needs at least one chain')

  const seen = new Set<number>()
  for (const chain of chains) {
    if (seen.has(chain.chainId)) throw new Error(`chain ${chain.chainId} is configured twice`)
    seen.add(chain.chainId)
  }

  const started = await Promise.all(chains.map((chain) => startChain(chain, account, allowOrigin)))

  const server = createMultiChainServer({ mounts: started.map((chain) => chain.mount), allowOrigin, logger })
  await new Promise<void>((resolve) => server.listen(port, resolve))

  logger.info(`up — HTTP on :${port}, ${started.length} chain(s)`)
  for (const { mount } of started) {
    logger.info(`  ${mount.network.padEnd(14)} http://localhost:${port}/${mount.network}/v1  (chain ${mount.chainId})`)
  }
  if (started.length === 1) logger.info(`  also unprefixed at http://localhost:${port}/v1`)
  logger.info(`api docs at /<network>/v1/docs; GET /v1/networks lists the chains. Routes per chain:`)
  for (const route of ROUTES) {
    logger.info(`  ${route.method.padEnd(4)} ${route.path.padEnd(24)} ${route.summary}`)
  }

  for (const chain of started) await chain.report()

  return {
    server,
    run: (signal) => Promise.all(started.map((chain) => chain.run(signal))).then(() => undefined),
    close: () =>
      new Promise<void>((resolve) => {
        // `close` alone waits for open connections to finish, and an SSE stream never does — a
        // shutdown with one subscriber attached would hang forever. Cut them first.
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** One chain's keeper and watch tower, ready to run, and its HTTP surface ready to mount. */
async function startChain(options: ChainKeeperOptions, account: PrivateKeyAccount, allowOrigin: string) {
  const {
    rpcUrl,
    chainId,
    generation,
    policy = DEFAULT_POLICY,
    statePath,
    cursorPath,
    pollIntervalMs,
    dryRun = false,
    env = 'prod',
    logger = silentLogger,
    minBalanceWarnWei = 10n ** 17n, // 0.1 native
  } = options

  const network = getDropChain(chainId)?.network
  if (!network) throw new Error(`cow-drop does not support chain ${chainId}`)

  const deployment = getDeployment(chainId, generation)
  const client = options.client ?? keeperClient(rpcUrl)
  const store = options.store ?? (statePath ? fileStore(statePath, chainId) : memoryStore())
  const events = createEventBus()
  const submitter = viemSubmitter(client, account, chainId)
  const orderBook = new OrderBookApi({ chainId: chainId as SupportedChainId, env })

  const keeper = createKeeper({
    chain: viemKeeperChain(client),
    submitter,
    store,
    deployment,
    policy,
    events,
    // Only `paying` mode consults this, but wiring it unconditionally means a dry run reports the
    // revenue estimate whatever the mode — which is how an operator sanity-checks the numbers
    // before turning the gate on.
    prices: orderBookPrices(orderBook),
    quoter: orderBookPaymentQuoter(orderBook),
    pollIntervalMs,
    dryRun,
    logger,
  })

  const watchTower = createWatchTower({
    reader: viemChainReader(client),
    orderBook,
    deployment,
    cursor: cursorPath ? fileCursor(cursorPath, chainId) : memoryCursor(),
    // Rewind to the oldest activation still in flight, so a restart between broadcast and scan does
    // not skip the block the activation landed in and lose its orders outright.
    fromBlock: (await keeper.oldestPendingBlock()) ?? 'latest',
    onlyDrops: true,
    // The order book rejects an appData hash it has never seen, and the keeper is the only place
    // holding the documents — they arrive with the registration and cannot be recovered from the
    // chain, which carries the hash alone.
    appData: async (hash) => {
      for (const drop of await store.all(chainId)) {
        const document = drop.appDataDocuments?.[hash]
        if (document) return document
      }
      // A drop registered before the client sent documents still carries the standard appData.
      return knownAppDataDocument(hash)
    },
    dryRun,
    logger,
    onResult: (result) => void forwardOrderResults({ store, events, chainId })(result),
  })

  const handler = createKeeperHandler({ store, deployment, events, policy, submitter, allowOrigin, logger })

  return {
    mount: { chainId, network, handler } satisfies ChainMount,
    run: (signal: AbortSignal) =>
      Promise.all([keeper.run(signal), watchTower.run(signal)]).then(() => undefined),
    report: async () => {
      await reportPayerBalance({ submitter, policy, minBalanceWarnWei, logger })
      await reportState({ store, chainId, policy, logger })
    },
  }
}

/**
 * The payer and what it holds, and a warning while there is still time to act on it.
 *
 * Two thresholds, because they mean different things: below `minPayerBalanceWei` the spend gate
 * refuses outright and the keeper is already inert, and that is an error. Below the advisory
 * watermark it still works, and that is a warning.
 *
 * A failed read is not fatal. The balance is re-read every tick and on `/v1/health`, so an RPC that
 * is briefly unreachable at boot should cost a log line rather than the process.
 */
async function reportPayerBalance({
  submitter,
  policy,
  minBalanceWarnWei,
  logger,
}: {
  submitter: { payer(): Promise<Address>; balance(): Promise<bigint> }
  policy: SubsidyPolicy
  minBalanceWarnWei: bigint
  logger: Logger
}): Promise<void> {
  const payer = await submitter.payer()

  let balance: bigint
  try {
    balance = await submitter.balance()
  } catch (error) {
    logger.warn(
      `could not read the balance of payer ${payer}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  logger.info(`payer ${payer} holds ${formatEther(balance)} native`)

  if (balance === 0n) {
    logger.error(`payer ${payer} is out of funds — it can pay for nothing until it is funded`)
  } else if (balance < policy.minPayerBalanceWei) {
    logger.error(
      `payer balance ${formatEther(balance)} is below the policy floor of ` +
        `${formatEther(policy.minPayerBalanceWei)} — every activation will be refused as payer-balance-low`,
    )
  } else if (balance < minBalanceWarnWei) {
    logger.warn(
      `payer balance ${formatEther(balance)} is below the ${formatEther(minBalanceWarnWei)} warning ` +
        `threshold — top it up, or raise $KEEPER_MIN_BALANCE if this is expected`,
    )
  }
}

/**
 * What was on disk, in one or two lines.
 *
 * Worth saying because the state file is the process's whole memory: it decides what gets watched and
 * how much of today's budget is already gone. Booting against the wrong file, or against one a
 * previous run left mid-activation, is invisible otherwise.
 */
async function reportState({
  store,
  chainId,
  policy,
  logger,
}: {
  store: KeeperStore
  chainId: number
  policy: SubsidyPolicy
  logger: Logger
}): Promise<void> {
  const drops = await store.all(chainId)
  const spend = await store.spendOn(utcDay(Date.now()))

  if (drops.length === 0) {
    logger.info('state: no drops registered yet')
  } else {
    const counts = new Map<DropStatus, number>()
    for (const drop of drops) counts.set(drop.status, (counts.get(drop.status) ?? 0) + 1)
    const byStatus = [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(', ')

    logger.info(`state: ${drops.length} drop(s) — ${byStatus}`)

    // Called out separately: a record left in `activating` is a transaction a previous run committed
    // to and never reconciled, and nothing will re-simulate or re-send it. It needs an operator.
    const pending = drops.filter((drop) => drop.status === 'activating')
    for (const drop of pending) {
      logger.warn(
        `drop ${drop.address} was left activating by an earlier run (tx ${drop.pending?.ref ?? 'unknown'})`,
      )
    }
  }

  logger.info(
    `spent ${formatEther(spend.totalWei)} of ${formatEther(policy.dailyBudgetWei)} native today ` +
      `across ${spend.byOwner.size} owner(s)`,
  )
}
