import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http'
import type { Logger } from '@cowprotocol/cow-drop-watch-tower'
import { silentLogger } from '@cowprotocol/cow-drop-watch-tower'

import { applyCors } from './server.js'

/** One chain's HTTP surface, and the network name it is mounted under. */
export interface ChainMount {
  chainId: number
  /** CoW's name for the chain — `xdai`, `mainnet`, `base` — and its path prefix here. */
  network: string
  handler: RequestListener
}

/**
 * One server for every chain this process keeps, each under its own network name.
 *
 * `/xdai/v1/drops` reaches Gnosis's keeper with `/v1/drops`, so each chain's handler is unchanged and
 * answers exactly what a single-chain keeper does. The names are the ones CoW's order book API uses, so
 * a deployment that already proxies `/keeper/<network>` to one process per chain points the same paths
 * at this one process instead.
 *
 * With a single chain, its routes are also served unprefixed — `/v1/drops` — which is what a
 * single-chain keeper always served, so nothing pointed at one breaks.
 *
 * `GET /v1/networks` lists what is mounted where, and with several chains `GET /v1/health` is process
 * liveness. Anything else outside a mount is a 404 naming the networks, so a typo in a base URL says
 * what would have worked.
 */
export function createMultiChainServer(options: {
  mounts: readonly ChainMount[]
  allowOrigin?: string
  logger?: Logger
}): Server {
  const { mounts, allowOrigin = '*', logger = silentLogger } = options
  const byNetwork = new Map(mounts.map((mount) => [mount.network, mount]))
  const only = mounts.length === 1 ? mounts[0] : undefined

  return createServer((request, response) => {
    try {
      route(request, response)
    } catch (error) {
      logger.error(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) send(request, response, 500, { error: 'internal' })
      else response.end()
    }
  })

  function route(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://keeper.local')
    const [, first = '', ...rest] = url.pathname.split('/')

    const mount = byNetwork.get(first)
    if (mount) {
      // Hand over the path relative to the mount, query string intact.
      request.url = `/${rest.join('/')}${url.search}`
      return mount.handler(request, response)
    }

    if (request.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/v1/networks') {
      return send(request, response, 200, {
        networks: mounts.map(({ chainId, network }) => ({ chainId, network, path: `/${network}/v1` })),
      })
    }

    if (only) return only.handler(request, response)

    // Process liveness, for a probe that cannot name a network. Deliberately not the per-chain health,
    // which answers 503 when a payer runs low: restarting the process would not fund it, and would stop
    // every other chain with it. Each chain's own is at `/<network>/v1/health`.
    if (request.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/v1/health') {
      return send(request, response, 200, { ok: true, networks: mounts.map((mount) => mount.network) })
    }

    if (request.method === 'OPTIONS') {
      applyCors(allowOrigin, request, response)
      response.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS' })
      response.end()
      return
    }

    send(request, response, 404, {
      error: 'unknown-network',
      networks: mounts.map((mount) => mount.network),
      hint: 'prefix the path with a network, e.g. /xdai/v1/drops',
    })
  }

  function send(request: IncomingMessage, response: ServerResponse, status: number, body: unknown): void {
    applyCors(allowOrigin, request, response)
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }
}
