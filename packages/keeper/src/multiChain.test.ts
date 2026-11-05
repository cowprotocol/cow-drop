import type { AddressInfo } from 'node:net'
import type { RequestListener } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { createMultiChainServer, type ChainMount } from './multiChain.js'

/** A chain handler that answers with what it was asked, so the test sees the rewritten path. */
function echo(network: string): RequestListener {
  return (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ network, url: request.url }))
  }
}

const servers: ReturnType<typeof createMultiChainServer>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function start(mounts: ChainMount[]) {
  const server = createMultiChainServer({ mounts })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return async (path: string) => {
    const response = await fetch(`${base}${path}`)
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
}

const XDAI: ChainMount = { chainId: 100, network: 'xdai', handler: echo('xdai') }
const BASE: ChainMount = { chainId: 8453, network: 'base', handler: echo('base') }

describe('createMultiChainServer', () => {
  it('routes by network and hands over the path relative to the mount, query intact', async () => {
    const get = await start([XDAI, BASE])

    expect((await get('/xdai/v1/drops?owner=0xabc')).body).toEqual({ network: 'xdai', url: '/v1/drops?owner=0xabc' })
    expect((await get('/base/v1/health')).body).toEqual({ network: 'base', url: '/v1/health' })
  })

  it('lists the networks', async () => {
    const get = await start([XDAI, BASE])

    expect((await get('/v1/networks')).body).toEqual({
      networks: [
        { chainId: 100, network: 'xdai', path: '/xdai/v1' },
        { chainId: 8453, network: 'base', path: '/base/v1' },
      ],
    })
  })

  it('answers process liveness at /v1/health with several chains', async () => {
    const get = await start([XDAI, BASE])

    expect(await get('/v1/health')).toEqual({ status: 200, body: { ok: true, networks: ['xdai', 'base'] } })
  })

  it('names the networks when the path has none of them', async () => {
    const get = await start([XDAI, BASE])

    const { status, body } = await get('/gnosis/v1/drops')
    expect(status).toBe(404)
    expect(body).toMatchObject({ error: 'unknown-network', networks: ['xdai', 'base'] })
  })

  it('also serves a single chain unprefixed, as a single-chain keeper always did', async () => {
    const get = await start([XDAI])

    expect((await get('/v1/drops')).body).toEqual({ network: 'xdai', url: '/v1/drops' })
    expect((await get('/xdai/v1/drops')).body).toEqual({ network: 'xdai', url: '/v1/drops' })
  })
})
