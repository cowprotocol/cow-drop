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
import { orderBookPrices } from './revenue.js'
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
 * pays for it, and an in-process watch tower turns the resulting `OrderPlacement` logs into posted
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
      return undefined
    },
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
    close: () =>
      new Promise<void>((resolve) => {
        // `close` alone waits for open connections to finish, and an SSE stream never does — a
        // shutdown with one subscriber attached would hang forever. Cut them first.
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
