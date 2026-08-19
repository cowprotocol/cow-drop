import { getDeployment } from '@cowprotocol/cow-drop-sdk'
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
import type { PublicClient } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'

import { keeperClient, viemKeeperChain, viemSubmitter } from './chain.js'
import { createEventBus } from './events.js'
import { createKeeper } from './keeper.js'
import { forwardOrderResults } from './orders.js'
import { DEFAULT_POLICY } from './policy.js'
import { createKeeperServer } from './server.js'
import { fileStore, memoryStore, type KeeperStore } from './store.js'
import type { SubsidyPolicy } from './types.js'

export interface KeeperServiceOptions {
  rpcUrl: string
  chainId: number
  generation?: number
  account: PrivateKeyAccount
  policy?: SubsidyPolicy
  /** Path for the registry and the spend ledger. Omit for memory only. */
  statePath?: string
  /** Separate file for the watch tower's block cursor. */
  cursorPath?: string
  port?: number
  allowOrigin?: string
  pollIntervalMs?: number
  dryRun?: boolean
  env?: 'prod' | 'staging'
  logger?: Logger
  client?: PublicClient
  store?: KeeperStore
}

export interface KeeperService {
  server: Server
  /** Runs both loops until the signal aborts. */
  run(signal: AbortSignal): Promise<void>
  close(): Promise<void>
}

/**
 * Wire the whole thing together: registry, watcher, activator, and the watch tower that posts.
 *
 * The only place that composes. Two loops run side by side — the keeper decides what to activate and
 * pays for it, and an in-process watch tower turns the resulting `CowOrderPlaced` logs into posted
 * orders. Neither knows about the other except through the event bus.
 */
export async function startKeeperService(options: KeeperServiceOptions): Promise<KeeperService> {
  const {
    rpcUrl,
    chainId,
    generation,
    account,
    policy = DEFAULT_POLICY,
    statePath,
    cursorPath,
    port = 8787,
    allowOrigin = '*',
    pollIntervalMs,
    dryRun = false,
    env = 'prod',
    logger = silentLogger,
  } = options

  const deployment = getDeployment(chainId, generation)
  const client = options.client ?? keeperClient(rpcUrl)
  const store = options.store ?? (statePath ? fileStore(statePath, chainId) : memoryStore())
  const events = createEventBus()
  const submitter = viemSubmitter(client, account, chainId)

  const keeper = createKeeper({
    chain: viemKeeperChain(client),
    submitter,
    store,
    deployment,
    policy,
    events,
    pollIntervalMs,
    dryRun,
    logger,
  })

  const watchTower = createWatchTower({
    reader: viemChainReader(client),
    orderBook: new OrderBookApi({ chainId: chainId as SupportedChainId, env }),
    deployment,
    cursor: cursorPath ? fileCursor(cursorPath, chainId) : memoryCursor(),
    // Rewind to the oldest activation still in flight, so a restart between broadcast and scan does
    // not skip the block the activation landed in and lose its orders outright.
    fromBlock: (await keeper.oldestPendingBlock()) ?? 'latest',
    onlyDrops: true,
    dryRun,
    logger,
    onResult: (result) => void forwardOrderResults({ store, events, chainId })(result),
  })

  const server = createKeeperServer({
    store,
    deployment,
    events,
    policy,
    submitter,
    allowOrigin,
    logger,
  })

  await new Promise<void>((resolve) => server.listen(port, resolve))
  logger.info(`keeper listening on :${port} for chain ${chainId}`)

  return {
    server,
    run: (signal) => Promise.all([keeper.run(signal), watchTower.run(signal)]).then(() => undefined),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
