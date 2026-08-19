import type { AddressInfo } from 'node:net'
import { compileRecipe } from '@cowprotocol/cow-drop-sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { createEventBus } from './events.js'
import { CHAIN_ID, deployment, fakeSubmitter, recipeJson } from './fixtures.js'
import { DEFAULT_POLICY } from './policy.js'
import { createKeeperServer, type ServerOptions } from './server.js'
import { memoryStore } from './store.js'

const servers: { close: () => void }[] = []
afterEach(() => servers.forEach((server) => server.close()))

async function serve(overrides: Partial<ServerOptions> = {}) {
  const store = overrides.store ?? memoryStore()
  const events = overrides.events ?? createEventBus()
  const server = createKeeperServer({
    store,
    deployment: deployment(),
    events,
    policy: DEFAULT_POLICY,
    submitter: fakeSubmitter([]).submitter,
    ...overrides,
  })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  servers.push(server)
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, store, events }
}

/** `Response.json()` is `unknown` under strict TS, and every assertion here reaches into the body. */
async function json(response: Response): Promise<any> {
  return response.json()
}

function post(base: string, path: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  })
}

describe('POST /v1/drops', () => {
  it('creates on the first call and reports the same drop on the second', async () => {
    // Idempotent, so a client whose POST timed out can retry — and be told truthfully that it is safe.
    const { base } = await serve()
    const recipe = recipeJson()
    const address = compileRecipe(recipe).address

    const first = await post(base, '/v1/drops', { recipe, address })
    const second = await post(base, '/v1/drops', { recipe, address })

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect((await json(second)).drop.address).toBe(address.toLowerCase())
  })

  it('409s an address the client derived differently, and names both', async () => {
    const { base } = await serve()
    const recipe = recipeJson()
    const wrong = `0x${'11'.repeat(20)}`

    const response = await post(base, '/v1/drops', { recipe, address: wrong })
    const body = await json(response)

    expect(response.status).toBe(409)
    expect(body).toMatchObject({ error: 'address-mismatch', supplied: wrong })
    expect(body.derived).toBe(compileRecipe(recipe).address)
  })

  it('400s a recipe that does not compile, with the SDK\'s own message', async () => {
    const { base } = await serve()
    const response = await post(base, '/v1/drops', { recipe: { ...recipeJson(), version: 99 } })

    expect(response.status).toBe(400)
    expect((await json(response)).error).toBe('invalid-recipe')
  })

  it('422s a recipe for a chain this keeper does not serve', async () => {
    const { base } = await serve()
    const response = await post(base, '/v1/drops', { recipe: recipeJson({ chainId: 1 }) })

    expect(response.status).toBe(422)
    expect((await json(response))).toMatchObject({ error: 'wrong-chain', expected: CHAIN_ID })
  })

  it('415s anything that is not JSON, and 400s JSON that is not', async () => {
    const { base } = await serve()

    expect((await fetch(`${base}/v1/drops`, { method: 'POST', body: 'hi' })).status).toBe(415)
    expect(
      (await fetch(`${base}/v1/drops`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{oops',
      })).status,
    ).toBe(400)
  })

  it('413s a body past the cap without buffering all of it', async () => {
    const { base } = await serve({ maxBodyBytes: 512 })
    const response = await post(base, '/v1/drops', { recipe: recipeJson({ label: 'x'.repeat(4096) }) })

    expect(response.status).toBe(413)
  })

  it('429s once the registry is full', async () => {
    // Registration grants nothing, but it is not free — every entry is a recipe stored forever.
    const { base } = await serve({ maxDrops: 1 })
    await post(base, '/v1/drops', { recipe: recipeJson() })

    const response = await post(base, '/v1/drops', { recipe: recipeJson({ label: 'second' }) })
    expect(response.status).toBe(429)
  })
})

describe('POST /v1/drops/unregister', () => {
  it('takes the recipe, not just the address', async () => {
    // Unregistering someone else's drop costs them their subsidy for free, so it asks for the one
    // thing only somebody holding the recipe has.
    const { base, store } = await serve()
    const recipe = recipeJson()
    await post(base, '/v1/drops', { recipe })

    const response = await post(base, '/v1/drops/unregister', { recipe })

    expect(response.status).toBe(200)
    expect((await store.get(CHAIN_ID, compileRecipe(recipe).address))?.status).toBe('retired')
  })

  it('404s a recipe nobody registered', async () => {
    const { base } = await serve()
    expect((await post(base, '/v1/drops/unregister', { recipe: recipeJson() })).status).toBe(404)
  })

  it('400s without a recipe, rather than accepting an address', async () => {
    const { base } = await serve()
    expect((await post(base, '/v1/drops/unregister', {})).status).toBe(400)
  })
})

describe('GET /v1/drops/:address', () => {
  it('serves the drop, case-insensitively, and 404s otherwise', async () => {
    const { base } = await serve()
    const recipe = recipeJson()
    const address = compileRecipe(recipe).address
    await post(base, '/v1/drops', { recipe })

    expect((await fetch(`${base}/v1/drops/${address}`)).status).toBe(200)
    expect((await fetch(`${base}/v1/drops/${address.toLowerCase()}`)).status).toBe(200)
    expect((await fetch(`${base}/v1/drops/0x${'22'.repeat(20)}`)).status).toBe(404)
  })

  it('includes the activation history, so a reload can reconcile what it missed', async () => {
    const { base } = await serve()
    await post(base, '/v1/drops', { recipe: recipeJson() })

    const drop = (await json(await fetch(`${base}/v1/drops/${compileRecipe(recipeJson()).address}`))).drop
    expect(drop.activations).toEqual([])
    expect(drop.hints.tokens).toHaveLength(1)
  })
})

describe('CORS', () => {
  it('answers the preflight a JSON POST always triggers', async () => {
    // The web app has no dev proxy, so this is on the critical path rather than an afterthought.
    const { base } = await serve()
    const response = await fetch(`${base}/v1/drops`, { method: 'OPTIONS' })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
    expect(response.headers.get('access-control-allow-headers')).toContain('content-type')
  })

  it('sets the origin header on every response, 404s included', async () => {
    const { base } = await serve()
    expect((await fetch(`${base}/nope`)).headers.get('access-control-allow-origin')).toBe('*')
  })

  it('echoes a configured origin and varies on it', async () => {
    const { base } = await serve({ allowOrigin: 'https://drop.cow.fi' })
    const allowed = await fetch(`${base}/v1/health`, { headers: { origin: 'https://drop.cow.fi' } })
    const other = await fetch(`${base}/v1/health`, { headers: { origin: 'https://evil.example' } })

    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://drop.cow.fi')
    expect(allowed.headers.get('vary')).toBe('Origin')
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('GET /v1/health and /v1/policy', () => {
  it('reports the payer and the budget left', async () => {
    const { base } = await serve()
    const health = await json(await fetch(`${base}/v1/health`))

    expect(health.ok).toBe(true)
    expect(health.chainId).toBe(CHAIN_ID)
    expect(health.remainingTodayWei).toBe(DEFAULT_POLICY.dailyBudgetWei.toString())
  })

  it('is unhealthy when the payer cannot cover its floor', async () => {
    // So a keeper that has run out of gas is noticed by a monitor, not by a user.
    const { base } = await serve({ submitter: { ...fakeSubmitter([]).submitter, balance: async () => 0n } })
    expect((await fetch(`${base}/v1/health`)).status).toBe(503)
  })

  it('says whether it is subsidising before anyone commits to registering', async () => {
    const { base } = await serve()
    expect((await json(await fetch(`${base}/v1/policy`))).subsidising).toBe(true)
  })
})

describe('GET /v1/events', () => {
  it('requires a drop filter', async () => {
    const { base } = await serve()
    expect((await fetch(`${base}/v1/events`)).status).toBe(400)
  })

  it('opens with a hello carrying the head and a snapshot', async () => {
    // So a client that connects late is never blank, and never has to guess what it missed.
    const { base } = await serve()
    const recipe = recipeJson()
    await post(base, '/v1/drops', { recipe })
    const address = compileRecipe(recipe).address.toLowerCase()

    const response = await fetch(`${base}/v1/events?drop=${address}`)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    const hello = await readUntil(reader, 'event: hello')
    expect(hello).toContain('event: hello')
    expect(hello).toContain(address)
    // The browser is told how fast to reconnect, once, before anything else.
    expect(hello).toContain('retry: 3000')
    await reader.cancel()
  })

  it('streams an event for a watched drop, framed on one line', async () => {
    const { base, events } = await serve()
    const address = compileRecipe(recipeJson()).address.toLowerCase() as `0x${string}`

    const response = await fetch(`${base}/v1/events?drop=${address}`)
    const reader = response.body!.getReader()
    await readUntil(reader, 'event: hello')

    events.emit({ type: 'registered', chainId: CHAIN_ID, drop: address, owner: address, label: 'x' })
    const chunk = await readUntil(reader, 'event: registered')

    const registered = chunk.slice(chunk.indexOf('id:'))
    expect(registered).toMatch(/^id: \d+\nevent: registered\ndata: \{.*\}\n\n/)
    // A newline inside `data:` would silently truncate the frame, so the payload must be one line.
    expect(registered.split('data: ')[1]?.split('\n')[0]).toContain('"type":"registered"')
    await reader.cancel()
  })

  it('does not send another drop\'s events', async () => {
    const { base, events } = await serve()
    const mine = `0x${'11'.repeat(20)}` as `0x${string}`
    const theirs = `0x${'22'.repeat(20)}` as `0x${string}`

    const response = await fetch(`${base}/v1/events?drop=${mine}`)
    const reader = response.body!.getReader()
    await readUntil(reader, 'event: hello')

    events.emit({ type: 'registered', chainId: CHAIN_ID, drop: theirs, owner: theirs, label: 'not mine' })
    events.emit({ type: 'registered', chainId: CHAIN_ID, drop: mine, owner: mine, label: 'mine' })

    const chunk = await readUntil(reader, 'event: registered')
    expect(chunk).toContain('"label":"mine"')
    expect(chunk).not.toContain('not mine')
    await reader.cancel()
  })
})

/**
 * Read the stream until `marker` shows up.
 *
 * Chunk boundaries are the transport's business, not the protocol's — `retry:` may or may not share a
 * packet with the `hello` frame — so a test that counts reads is testing TCP rather than the server.
 */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
  limit = 20,
): Promise<string> {
  let text = ''
  for (let i = 0; i < limit && !text.includes(marker); i++) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  return text
}
