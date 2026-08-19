import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { DropDeployment, DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Logger } from '@cowprotocol/cow-drop-watch-tower'
import { silentLogger } from '@cowprotocol/cow-drop-watch-tower'
import type { Address } from 'viem'

import type { Submitter } from './chain.js'
import type { EventBus } from './events.js'
import { registerDrop, unregisterDrop } from './registry.js'
import { frame, keepalive, retryAfter, SSE_HEADERS, writeEvent } from './sse.js'
import type { KeeperStore } from './store.js'
import { utcDay } from './store.js'
import type { RegisteredDrop, SubsidyPolicy } from './types.js'

export interface ServerOptions {
  store: KeeperStore
  deployment: DropDeployment
  events: EventBus
  policy: SubsidyPolicy
  submitter: Submitter
  now?: () => number
  /** Registration is open, so it is bounded by capacity rather than by identity. */
  maxDrops?: number
  maxBodyBytes?: number
  /** `*` by default. A specific list is echoed back per request, with `Vary: Origin`. */
  allowOrigin?: string
  keepaliveMs?: number
  logger?: Logger
}

/** Everything the UI needs about one drop, with every bigint already a string. */
function toWire(drop: RegisteredDrop) {
  return {
    address: drop.address,
    chainId: drop.chainId,
    generation: drop.generation,
    owner: drop.owner,
    label: drop.label,
    status: drop.status,
    everFunded: drop.everFunded,
    watching: drop.status !== 'retired',
    registeredAt: drop.registeredAt,
    retiredReason: drop.retiredReason,
    blockedReason: drop.blockedReason,
    hints: {
      tokens: drop.hints.tokens,
      native: drop.hints.native,
      minBalance: drop.hints.minBalance,
      notBefore: drop.hints.notBefore,
      notAfter: drop.hints.notAfter,
      blind: drop.hints.blind,
      warnings: drop.hints.warnings,
    },
    lastPoll: drop.lastPoll,
    // The whole history, so a page opened hours later can reconcile what it missed rather than
    // guessing from an event stream it was not connected to.
    activations: drop.activations,
    pending: drop.pending ? { ref: drop.pending.ref, sentAt: drop.pending.sentAt } : undefined,
  }
}

/**
 * The HTTP surface, described once.
 *
 * Kept immediately above the router that serves it so the two are edited together, and given a real
 * consumer — `GET /v1/openapi.json` is generated from this list, and so is the boot banner. A route
 * added to the router and not to this table is therefore undocumented in two visible places rather
 * than silently absent from one.
 */
export interface RouteDoc {
  method: 'GET' | 'POST'
  /** OpenAPI-style, so `{address}` rather than a regex. */
  path: string
  summary: string
  /** What a 200 carries. Default `application/json`. */
  produces?: string
}

export const ROUTES: readonly RouteDoc[] = [
  { method: 'GET', path: '/v1/health', summary: 'Liveness, payer balance, today\'s spend. 503 when the payer is below its floor.' },
  { method: 'GET', path: '/v1/policy', summary: 'The subsidy policy in force.' },
  { method: 'GET', path: '/v1/openapi.json', summary: 'This surface as an OpenAPI 3.1 document.' },
  { method: 'GET', path: '/v1/docs', summary: 'Swagger UI over that document.', produces: 'text/html' },
  { method: 'POST', path: '/v1/drops', summary: 'Register a drop for the keeper to watch and pay for.' },
  { method: 'POST', path: '/v1/drops/unregister', summary: 'Stop watching a drop. Body carries the recipe, which is the proof.' },
  { method: 'GET', path: '/v1/drops/{address}', summary: 'One registered drop, with its last poll and simulation.' },
  {
    method: 'GET',
    path: '/v1/events',
    summary: 'Server-sent event stream of registrations, activations and posted orders.',
    produces: 'text/event-stream',
  },
]

/**
 * A minimal OpenAPI 3.1 document, built from `ROUTES`.
 *
 * Paths and summaries only, with no request or response schemas: those live in `types.ts` and
 * hand-copying them here would produce a document that lies as soon as one changes. This is enough to
 * point Swagger UI, Redoc or `curl` at the surface and see what exists.
 */
export function openApiDocument(chainId: number, generation: number): unknown {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of ROUTES) {
    const parameters =
      route.path === '/v1/drops/{address}'
        ? [{ name: 'address', in: 'path', required: true, schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } }]
        : undefined

    paths[route.path] = {
      ...paths[route.path],
      [route.method.toLowerCase()]: {
        summary: route.summary,
        ...(parameters ? { parameters } : {}),
        responses: { '200': { description: 'OK', content: { [route.produces ?? 'application/json']: {} } } },
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'cow-drop keeper',
      version: '0.0.0',
      description: `Watches registered drops on chain ${chainId} (generation ${generation}), activates them when the recipe would succeed, and pays the gas.`,
    },
    paths,
  }
}

/**
 * Swagger UI over `/v1/openapi.json`.
 *
 * The assets come from a pinned CDN build rather than a bundled `swagger-ui-dist`, because this
 * package has no runtime dependencies beyond viem and the CoW SDK and an operator-facing docs page is
 * not the thing to break that for. The trade is that this page — and only this page — needs the
 * internet; `/v1/openapi.json` is served locally and works offline.
 *
 * The spec URL is derived from `location.pathname` rather than hardcoded, so the page works behind
 * whatever host, port or subpath a proxy puts the keeper on. Derived rather than written as
 * `./openapi.json` because the router strips trailing slashes and therefore also serves `/v1/docs/`,
 * where a relative URL would resolve to `/v1/docs/openapi.json` and 404.
 *
 * Derived with string operations rather than a regex on purpose: this script is the body of a
 * template literal, so TypeScript consumes `\/` before the browser ever sees it. A regex written the
 * obvious way arrives as `//docs/?$/` — a line comment that silently deletes the call, which renders
 * as a blank page with no error anywhere.
 */
const SWAGGER_UI_VERSION = '5.17.14'

function docsPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>cow-drop keeper API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css" />
    <style>
      body { margin: 0 }
      .swagger-ui .topbar { display: none }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js" crossorigin></script>
    <script>
      var path = location.pathname
      if (path.charAt(path.length - 1) === '/') path = path.slice(0, -1)
      window.ui = SwaggerUIBundle({
        url: path.slice(0, path.lastIndexOf('/') + 1) + 'openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
      })
    </script>
  </body>
</html>
`
}

/**
 * The keeper's HTTP surface.
 *
 * `node:http` rather than a framework: five routes and an event stream is not a framework's worth of
 * work, and this repo has no runtime dependencies beyond viem and the CoW SDK.
 *
 * ## There is no unauthenticated DELETE
 *
 * Registering someone else's drop grants nothing — activation is permissionless already — so
 * registration is open. *Un*registering is not symmetric: it costs the owner their gas subsidy for
 * free, which is a cheap denial of service. So it goes through `POST /v1/drops/unregister` with the
 * recipe in the body, which proves the caller holds the one thing that matters.
 */
export function createKeeperServer(options: ServerOptions): Server {
  const {
    store,
    deployment,
    events,
    policy,
    submitter,
    now = Date.now,
    maxDrops = 10_000,
    maxBodyBytes = 64 * 1024,
    allowOrigin = '*',
    keepaliveMs = 15_000,
    logger = silentLogger,
  } = options

  const started = now()

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      logger.error(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) send(response, 500, { error: 'internal' })
      else response.end()
    })
  })

  function cors(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin
    if (allowOrigin === '*') {
      response.setHeader('access-control-allow-origin', '*')
    } else if (origin && allowOrigin.split(',').includes(origin)) {
      response.setHeader('access-control-allow-origin', origin)
      response.setHeader('vary', 'Origin')
    }
    // Never `allow-credentials`: there is no auth on these routes, and it is invalid with `*`.
  }

  function sendHtml(response: ServerResponse, status: number, body: string): void {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body)
  }

  function send(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(payload)
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    cors(request, response)

    const url = new URL(request.url ?? '/', 'http://keeper.local')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (request.method === 'OPTIONS') {
      // A JSON POST is outside the CORS safelist, so the browser always preflights it. The web app
      // has no dev proxy, so this is on the critical path rather than an afterthought.
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, last-event-id',
        'access-control-max-age': '86400',
      })
      response.end()
      return
    }

    if (request.method === 'GET' && path === '/v1/health') return health(response)
    if (request.method === 'GET' && path === '/v1/policy') return describePolicy(response)
    if (request.method === 'GET' && path === '/v1/docs') return sendHtml(response, 200, docsPage())
    if (request.method === 'GET' && path === '/v1/openapi.json') {
      return send(response, 200, openApiDocument(deployment.chainId, deployment.generation))
    }
    if (request.method === 'POST' && path === '/v1/drops') return register(request, response)
    if (request.method === 'POST' && path === '/v1/drops/unregister') return unregister(request, response)
    if (request.method === 'GET' && path === '/v1/events') return stream(request, response, url)

    const drop = /^\/v1\/drops\/(0x[0-9a-fA-F]{40})$/.exec(path)
    if (drop && request.method === 'GET') return readDrop(response, drop[1] as Address)

    send(response, 404, { error: 'not-found' })
  }

  async function health(response: ServerResponse): Promise<void> {
    const all = await store.all(deployment.chainId)
    const balance = await submitter.balance()
    const spend = await store.spendOn(utcDay(now()))
    const healthy = balance >= policy.minPayerBalanceWei

    send(response, healthy ? 200 : 503, {
      ok: healthy,
      chainId: deployment.chainId,
      generation: deployment.generation,
      payer: await submitter.payer(),
      payerBalanceWei: balance.toString(),
      uptimeMs: now() - started,
      spentTodayWei: spend.totalWei.toString(),
      remainingTodayWei: max(policy.dailyBudgetWei - spend.totalWei, 0n).toString(),
      counts: {
        total: all.length,
        watching: all.filter((d) => d.status === 'watching').length,
        activating: all.filter((d) => d.status === 'activating').length,
        retired: all.filter((d) => d.status === 'retired').length,
      },
      head: events.head(),
    })
  }

  /**
   * What the keeper will and will not pay for, before anyone commits to registering.
   *
   * Without this the UI has to offer "and it pays the gas" and only discover otherwise afterwards,
   * which is exactly the kind of overselling this project avoids.
   */
  async function describePolicy(response: ServerResponse): Promise<void> {
    const spend = await store.spendOn(utcDay(now()))
    const balance = await submitter.balance()

    send(response, 200, {
      mode: policy.mode,
      maxCostPerActivationWei: policy.maxCostPerActivationWei.toString(),
      dailyBudgetWei: policy.dailyBudgetWei.toString(),
      remainingTodayWei: max(policy.dailyBudgetWei - spend.totalWei, 0n).toString(),
      // What `paying` mode requires, stated up front. Without this the UI would have to offer
      // "and it pays the gas" and only discover otherwise after the user had committed.
      fee:
        policy.mode === 'paying'
          ? {
              recipient: policy.feeRecipient ?? (await submitter.payer()),
              minVolumeBps: policy.minFeeBps,
              minRevenueRatio: policy.minRevenueRatio,
            }
          : undefined,
      // The honest answer to "will you pay for mine?" without knowing whose it is yet. In `paying`
      // mode that depends on the recipe, so the answer is "it depends" rather than a boolean.
      subsidising:
        policy.mode === 'paying'
          ? undefined
          : policy.mode === 'all' && balance >= policy.minPayerBalanceWei && spend.totalWei < policy.dailyBudgetWei,
    })
  }

  async function register(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request, response, maxBodyBytes)
    if (!body.ok) return

    const input = body.value as { recipe?: DropRecipeJson; address?: Address; appData?: string[] | string }
    if (!input.recipe || typeof input.recipe !== 'object') {
      send(response, 400, { error: 'invalid-request', message: 'a `recipe` is required' })
      return
    }

    const result = await registerDrop({
      recipe: input.recipe,
      address: input.address,
      // One document or several — a recipe may place more than one order, and a client with only one
      // should not have to wrap it.
      appDataDocuments: input.appData === undefined ? [] : Array.isArray(input.appData) ? input.appData : [input.appData],
      store,
      deployment,
      maxDrops,
      now: now(),
      // `paying` mode is the only one that asks the recipe for anything. The recipient defaults to the
      // payer, so an operator does not have to keep two addresses in step.
      requireFeeFor: policy.mode === 'paying' ? (policy.feeRecipient ?? (await submitter.payer())) : undefined,
      minFeeBps: policy.minFeeBps,
    })

    if (result.ok) {
      if (result.created) {
        events.emit({
          type: 'registered',
          chainId: result.drop.chainId,
          drop: result.drop.address,
          owner: result.drop.owner,
          label: result.drop.label,
        })
        logger.info(`registered ${result.drop.address} (${result.drop.label})`)
      }
      // 200 on a repeat, not an error: a client whose POST timed out will retry, and it can only be
      // honestly told that retrying is safe if it is.
      send(response, result.created ? 201 : 200, { drop: toWire(result.drop) })
      return
    }

    send(response, statusFor(result.error), result)
  }

  async function unregister(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request, response, maxBodyBytes)
    if (!body.ok) return

    const input = body.value as { recipe?: DropRecipeJson }
    if (!input.recipe) {
      send(response, 400, { error: 'invalid-request', message: 'a `recipe` is required to unregister' })
      return
    }

    const result = await unregisterDrop({ recipe: input.recipe, store, deployment, now: now() })
    if (result.ok) send(response, 200, { ok: true })
    else send(response, result.error === 'not-found' ? 404 : 400, result)
  }

  async function readDrop(response: ServerResponse, address: Address): Promise<void> {
    const drop = await store.get(deployment.chainId, address)
    if (!drop) {
      send(response, 404, { error: 'not-found' })
      return
    }
    send(response, 200, { drop: toWire(drop) })
  }

  /**
   * The event stream.
   *
   * Sends a `hello` carrying the current head and a snapshot of each requested drop, so a client that
   * connects late — or reconnects after the tab was asleep — is never blank and never has to guess
   * what it missed. `Last-Event-ID` replays from the bus's ring; past its end the honest answer is a
   * `gap`, which tells the client to refetch state rather than assume it saw everything.
   */
  async function stream(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const drops = url.searchParams.getAll('drop').map((drop) => drop.toLowerCase() as Address)
    if (drops.length === 0) {
      send(response, 400, { error: 'invalid-request', message: 'at least one `drop` is required' })
      return
    }

    response.writeHead(200, { ...SSE_HEADERS, ...corsHeader(request) })
    response.write(retryAfter(3000))

    const snapshots = []
    for (const address of drops) {
      const drop = await store.get(deployment.chainId, address)
      if (drop) snapshots.push(toWire(drop))
    }
    response.write(frame({ name: 'hello', data: { head: events.head(), drops: snapshots } }))

    const lastEventId = Number(request.headers['last-event-id'])
    if (Number.isFinite(lastEventId)) {
      const missed = events.since(lastEventId)
      if (missed === undefined) response.write(frame({ name: 'gap', data: { head: events.head() } }))
      else for (const event of missed.filter((e) => drops.includes(e.drop))) writeEvent(response, event)
    }

    const unsubscribe = events.subscribe(drops, (event) => writeEvent(response, event))
    // `unref` so a quiet stream does not by itself keep the process alive — the server's own handle
    // is what should decide that.
    const timer = setInterval(() => response.write(keepalive()), keepaliveMs)
    timer.unref?.()

    const close = () => {
      clearInterval(timer)
      unsubscribe()
    }
    request.on('close', close)
    response.on('error', close)
  }

  function corsHeader(request: IncomingMessage): Record<string, string> {
    const origin = request.headers.origin
    if (allowOrigin === '*') return { 'access-control-allow-origin': '*' }
    if (origin && allowOrigin.split(',').includes(origin)) {
      return { 'access-control-allow-origin': origin, vary: 'Origin' }
    }
    return {}
  }

  /** Read a JSON body, refusing one that is too big *while streaming* rather than after buffering. */
  async function readJson(
    request: IncomingMessage,
    response: ServerResponse,
    limit: number,
  ): Promise<{ ok: true; value: unknown } | { ok: false }> {
    if (!(request.headers['content-type'] ?? '').includes('application/json')) {
      send(response, 415, { error: 'unsupported-media-type' })
      return { ok: false }
    }

    const chunks: Buffer[] = []
    let size = 0

    try {
      for await (const chunk of request) {
        size += (chunk as Buffer).length
        if (size > limit) {
          send(response, 413, { error: 'too-large', maxBytes: limit })
          request.destroy()
          return { ok: false }
        }
        chunks.push(chunk as Buffer)
      }
    } catch {
      return { ok: false }
    }

    try {
      return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    } catch {
      send(response, 400, { error: 'invalid-json' })
      return { ok: false }
    }
  }
}

function statusFor(error: string): number {
  switch (error) {
    case 'invalid-recipe':
      return 400
    case 'address-mismatch':
    case 'conflict':
      return 409
    case 'wrong-chain':
    case 'wrong-generation':
      return 422
    case 'app-data-mismatch':
      return 409
    // Not 403: nothing is forbidden, the terms were simply not met. 402 says exactly that.
    case 'no-fee':
      return 402
    case 'at-capacity':
      return 429
    default:
      return 400
  }
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}
