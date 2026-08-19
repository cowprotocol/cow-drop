import { describe, expect, it } from 'vitest'
import type { PublicClient } from 'viem'

import { COW_ORDER_TOPIC, viemChainReader } from './chain.js'

/** A client that records the requests made of it and replays a canned result. */
function stubClient(result: unknown = []) {
  const requests: { method: string; params: unknown }[] = []
  const client = {
    request: async ({
      method,
      params,
    }: {
      method: string
      params: unknown
    }) => {
      requests.push({ method, params })
      return result
    },
  } as unknown as PublicClient
  return { client, requests }
}

describe('viemChainReader.getLogs', () => {
  // The regression this file exists for: `client.getLogs` has no `topics` parameter, so passing one
  // silently sent `topics: []` and every log in the range came back to be counted as undecodable.
  it('sends the topics it was given', async () => {
    const { client, requests } = stubClient()

    await viemChainReader(client).getLogs({
      topics: [COW_ORDER_TOPIC],
      fromBlock: 100n,
      toBlock: 200n,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('eth_getLogs')
    expect(requests[0]?.params).toEqual([
      { topics: [COW_ORDER_TOPIC], fromBlock: '0x64', toBlock: '0xc8' },
    ])
  })

  it('sends an address filter only when there is one', async () => {
    const address = '0x1111111111111111111111111111111111111111' as const
    const { client, requests } = stubClient()
    const reader = viemChainReader(client)

    await reader.getLogs({
      address,
      topics: [COW_ORDER_TOPIC],
      fromBlock: 1n,
      toBlock: 1n,
    })
    expect((requests[0]?.params as [{ address?: string }])[0].address).toBe(
      address,
    )

    await reader.getLogs({
      topics: [COW_ORDER_TOPIC],
      fromBlock: 1n,
      toBlock: 1n,
    })
    expect(
      (requests[1]?.params as [{ address?: string }])[0],
    ).not.toHaveProperty('address')
  })

  it('formats the rpc log into the numeric shape the scanner reads', async () => {
    const { client } = stubClient([
      {
        address: '0x2222222222222222222222222222222222222222',
        topics: [COW_ORDER_TOPIC],
        data: '0xdeadbeef',
        blockNumber: '0xafd434',
        transactionHash: `0x${'11'.repeat(32)}`,
        logIndex: '0x2a',
        blockHash: `0x${'22'.repeat(32)}`,
        transactionIndex: '0x1',
        removed: false,
      },
    ])

    const [log] = await viemChainReader(client).getLogs({
      topics: [COW_ORDER_TOPIC],
      fromBlock: 11523124n,
      toBlock: 11523124n,
    })

    expect(log?.blockNumber).toBe(11523124n)
    expect(log?.logIndex).toBe(42)
    expect(log?.topics).toEqual([COW_ORDER_TOPIC])
    expect(log?.data).toBe('0xdeadbeef')
  })
})
