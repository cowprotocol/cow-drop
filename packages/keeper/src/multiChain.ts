import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http'
import type { Logger } from '@cowprotocol/cow-drop-watch-tower'
import { silentLogger } from '@cowprotocol/cow-drop-watch-tower'

import { stalledLoops, type ChainLoops } from './liveness.js'
import { applyCors } from './server.js'

/** One chain's HTTP surface, and the network name it is mounted under. */
export interface ChainMount {
  chainId: number
  /** CoW's name for the chain — `xdai`, `mainnet`, `base` — and its path prefix here. */
  network: string
  handler: RequestListener
  /** The chain's polling loops, for `/metrics` and the `degraded` list on `/v1/health`. */
  loops?: Partial<ChainLoops>
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
 * liveness. `GET /metrics` is every chain's loops in Prometheus' text format, which is what to alert
 * on. Anything else outside a mount is a 404 naming the networks, so a typo in a base URL says what
 * would have worked.
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

    if (request.method === 'GET' && url.pathname === '/metrics') {
      applyCors(allowOrigin, request, response)
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
      response.end(metrics(mounts))
      return
    }

    if (only) return only.handler(request, response)

    // Process liveness, for a probe that cannot name a network. Deliberately not the per-chain health,
    // which answers 503 when a payer runs low or a loop stalls: restarting the process would not fund
    // the payer, rarely unsticks a loop, and stops every other chain with it. So this stays 200 and
    // names the chains in trouble in `degraded`; each chain's own is at `/<network>/v1/health`.
    if (request.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/v1/health') {
      const degraded = Object.fromEntries(
        mounts.map((mount) => [mount.network, stalledLoops(mount.loops)] as const).filter(([, stalled]) => stalled.length > 0),
      )
      return send(request, response, 200, { ok: true, networks: mounts.map((mount) => mount.network), degraded })
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

/**
 * Every chain's loops in Prometheus' text exposition format.
 *
 * Written by hand because it is three gauges. `last_success` is absent until a loop has succeeded
 * once, so alert on `stalled`, which covers a loop that never has.
 */
export function metrics(mounts: readonly ChainMount[]): string {
  const series: Record<string, { help: string; lines: string[] }> = {
    cow_drop_loop_stalled: { help: '1 when the loop has had no successful pass for too long.', lines: [] },
    cow_drop_loop_consecutive_failures: { help: 'Passes that have failed since the last success.', lines: [] },
    cow_drop_loop_last_success_timestamp_seconds: { help: 'When the loop last completed a pass.', lines: [] },
  }

  for (const mount of mounts) {
    for (const [loop, monitor] of Object.entries(mount.loops ?? {})) {
      const labels = `{network="${mount.network}",chain_id="${mount.chainId}",loop="${loop}"}`
      const status = monitor.status()
      series.cow_drop_loop_stalled!.lines.push(`cow_drop_loop_stalled${labels} ${status.stalled ? 1 : 0}`)
      series.cow_drop_loop_consecutive_failures!.lines.push(
        `cow_drop_loop_consecutive_failures${labels} ${status.consecutiveFailures}`,
      )
      if (status.lastSuccessAt !== undefined) {
        series.cow_drop_loop_last_success_timestamp_seconds!.lines.push(
          `cow_drop_loop_last_success_timestamp_seconds${labels} ${Math.floor(status.lastSuccessAt / 1000)}`,
        )
      }
    }
  }

  return Object.entries(series)
    .flatMap(([name, { help, lines }]) => [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...lines])
    .join('\n')
    .concat('\n')
}
