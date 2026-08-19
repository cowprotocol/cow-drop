import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadPrivateKey, parseArgs, resolvePaths } from './cli.js'

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
