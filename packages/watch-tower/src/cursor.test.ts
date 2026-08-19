import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { fileCursor, memoryCursor } from './cursor.js'

async function tempPath(name = 'state.json'): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'cow-drop-watch-tower-')), name)
}

describe('memoryCursor', () => {
  it('starts empty and remembers what it was set to', async () => {
    const cursor = memoryCursor()

    expect(await cursor.get()).toBeUndefined()
    await cursor.set(42n)
    expect(await cursor.get()).toBe(42n)
  })
})

describe('fileCursor', () => {
  it('reads back what it wrote, creating the directory if needed', async () => {
    const path = join(await tempPath('nested'), 'state.json')
    const cursor = fileCursor(path, 100)

    await cursor.set(12_345_678n)

    expect(await fileCursor(path, 100).get()).toBe(12_345_678n)
  })

  it('is empty when the file does not exist yet', async () => {
    expect(await fileCursor(await tempPath(), 100).get()).toBeUndefined()
  })

  it('refuses a state file written for another chain', async () => {
    // Resuming a Gnosis run from a mainnet block number would skip everything in between.
    const path = await tempPath()
    await fileCursor(path, 1).set(100n)

    await expect(fileCursor(path, 100).get()).rejects.toThrow(/chain 1, not 100/)
  })

  it('stores the block as a string, so a tall chain cannot lose precision', async () => {
    const path = await tempPath()
    await fileCursor(path, 100).set(2n ** 60n)

    expect(JSON.parse(await readFile(path, 'utf8')).lastProcessedBlock).toBe((2n ** 60n).toString())
    expect(await fileCursor(path, 100).get()).toBe(2n ** 60n)
  })

  it('propagates a malformed file rather than silently restarting from scratch', async () => {
    const path = await tempPath()
    await writeFile(path, 'not json')

    await expect(fileCursor(path, 100).get()).rejects.toThrow()
  })
})
