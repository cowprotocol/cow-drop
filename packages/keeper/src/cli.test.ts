import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CONVERT_HAIRCUT_BPS } from '@cowprotocol/cow-drop-sdk'

import {
  loadPrivateKey,
  parseArgs,
  policyFor,
  resolveChains,
  resolveConvertHaircutBps,
  resolvePaths,
} from './cli.js'

const KEY = `0x${'11'.repeat(32)}`

describe('parseArgs', () => {
  it('reads flags with and without values', () => {
    expect(parseArgs(['--rpc-url', 'http://x', '--dry-run', '--port', '9'])).toEqual({
      'rpc-url': 'http://x',
      'dry-run': true,
      port: '9',
    })
  })

  it('refuses a bare positional rather than ignoring it', () => {
    expect(() => parseArgs(['oops'])).toThrow(/unexpected argument/)
  })
})

describe('loadPrivateKey', () => {
  it('reads a key from a file', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'keeper-key-')), 'key')
    await writeFile(path, `${KEY}\n`)

    expect(await loadPrivateKey({ 'private-key-file': path })).toBe(KEY)
  })

  it('refuses --private-key, and says what to use instead', async () => {
    // A key on a command line is visible in `ps` to anything else on the machine.
    await expect(loadPrivateKey({ 'private-key': KEY })).rejects.toThrow(/--private-key-file/)
  })

  it('refuses something that is not a 32-byte key', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'keeper-key-')), 'key')
    await writeFile(path, 'hunter2')

    await expect(loadPrivateKey({ 'private-key-file': path })).rejects.toThrow(/32 bytes of hex/)
  })

  it('says what is missing when there is no key at all', async () => {
    const saved = process.env['KEEPER_PRIVATE_KEY']
    delete process.env['KEEPER_PRIVATE_KEY']
    await expect(loadPrivateKey({})).rejects.toThrow(/hot key is required/)
    if (saved) process.env['KEEPER_PRIVATE_KEY'] = saved
  })
})

describe('resolvePaths', () => {
  it('defaults to chain-scoped files, so two chains in one directory do not collide', () => {
    expect(resolvePaths({}, 100)).toEqual({
      statePath: 'out/keeper/state-100.json',
      cursorPath: 'out/keeper/cursor-100.json',
    })
    expect(resolvePaths({}, 1).statePath).toBe('out/keeper/state-1.json')
  })

  it('takes the flags when they are given', () => {
    expect(resolvePaths({ state: './s.json', cursor: './c.json' }, 100)).toEqual({
      statePath: './s.json',
      cursorPath: './c.json',
    })
  })
})

describe('resolvePaths with --state-dir', () => {
  it('puts each chain\'s files in the directory', () => {
    expect(resolvePaths({ 'state-dir': '/data/' }, 8453)).toEqual({
      statePath: '/data/state-8453.json',
      cursorPath: '/data/cursor-8453.json',
    })
  })
})

describe('resolveChains', () => {
  it('reads each chain\'s RPC from RPC_URL_<id>, and flags the ones falling back to public', () => {
    expect(resolveChains({ chains: '100,8453' }, { RPC_URL_100: 'https://gnosis' })).toEqual([
      { chainId: 100, rpcUrl: 'https://gnosis', publicRpc: false },
      { chainId: 8453, rpcUrl: undefined, publicRpc: true },
    ])
  })

  it('takes the list from $CHAINS', () => {
    expect(resolveChains({}, { CHAINS: '1', RPC_URL_1: 'https://eth' })).toEqual([
      { chainId: 1, rpcUrl: 'https://eth', publicRpc: false },
    ])
  })

  it('keeps the single-chain form working', () => {
    expect(resolveChains({ 'rpc-url': 'https://x', 'chain-id': '100' }, {})).toEqual([
      { chainId: 100, rpcUrl: 'https://x', publicRpc: false },
    ])
  })

  it('refuses one-chain flags alongside several chains', () => {
    expect(() => resolveChains({ chains: '100,1', state: './s.json' }, {})).toThrow(/--state-dir/)
    expect(() => resolveChains({ chains: '100,1', 'rpc-url': 'https://x' }, {})).toThrow(/RPC_URL_<chainId>/)
  })

  it('refuses nonsense and duplicates, and says what is needed when nothing is given', () => {
    expect(() => resolveChains({ chains: '100,gnosis' }, {})).toThrow(/not a chain id/)
    expect(() => resolveChains({ chains: '100,100' }, {})).toThrow(/twice/)
    expect(() => resolveChains({}, {})).toThrow(/--chains/)
  })
})

describe('policyFor', () => {
  it('applies a plain policy to every chain', () => {
    const policy = { mode: 'all' }
    expect(policyFor(policy, 100)).toBe(policy)
  })

  it('picks the chain\'s entry from a file keyed by chain id', () => {
    expect(policyFor({ '100': { mode: 'all' }, '1': { mode: 'paying' } }, 1)).toEqual({ mode: 'paying' })
  })

  it('refuses a keyed file with no entry for the chain, rather than silently using defaults', () => {
    expect(() => policyFor({ '100': { mode: 'all' } }, 8453)).toThrow(/none for 8453/)
  })
})

describe('resolveConvertHaircutBps', () => {
  it('defaults to the SDK constant, so the keeper and the panel agree out of the box', () => {
    expect(resolveConvertHaircutBps({}, {})).toBe(CONVERT_HAIRCUT_BPS)
    expect(CONVERT_HAIRCUT_BPS).toBe(100)
  })

  it('reads the environment', () => {
    expect(resolveConvertHaircutBps({}, { KEEPER_CONVERT_HAIRCUT_BPS: '250' })).toBe(250)
  })

  it('lets the flag win over the environment', () => {
    expect(
      resolveConvertHaircutBps({ 'convert-haircut-bps': '25' }, { KEEPER_CONVERT_HAIRCUT_BPS: '250' }),
    ).toBe(25)
  })

  it('treats a blank or absent variable as unset rather than as zero', () => {
    expect(resolveConvertHaircutBps({}, { KEEPER_CONVERT_HAIRCUT_BPS: '' })).toBe(CONVERT_HAIRCUT_BPS)
    expect(resolveConvertHaircutBps({}, { KEEPER_CONVERT_HAIRCUT_BPS: '   ' })).toBe(CONVERT_HAIRCUT_BPS)
  })

  it('accepts an explicit zero, which is "take whatever the market pays"', () => {
    expect(resolveConvertHaircutBps({}, { KEEPER_CONVERT_HAIRCUT_BPS: '0' })).toBe(0)
  })

  it('refuses a value that is not a whole number of bps under 10000', () => {
    for (const bad of ['-1', '1.5', '10000', 'abc']) {
      expect(() => resolveConvertHaircutBps({}, { KEEPER_CONVERT_HAIRCUT_BPS: bad })).toThrow(
        /convert-haircut-bps/,
      )
    }
  })
})
