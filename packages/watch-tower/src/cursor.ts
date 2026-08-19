import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Where the watch tower left off.
 *
 * One number, deliberately: the last block whose orders have all been dealt with. Nothing records
 * *which* orders were posted, because the order book already knows — a re-post of an order it holds
 * comes back as `DuplicatedOrder`, which is a success. So the worst a lost cursor costs is a rescan.
 */
export interface Cursor {
  /** The last fully-processed block, or `undefined` if nothing has been processed yet. */
  get(): Promise<bigint | undefined>
  set(block: bigint): Promise<void>
}

/**
 * Where a cursor lives when the caller names no file.
 *
 * Chain-scoped: `fileCursor` refuses a file written for another chain, but only once the second
 * process is already up, and a path per chain means it never comes to that.
 */
export function defaultCursorPath(chainId: number): string {
  return `out/watch-tower/cursor-${chainId}.json`
}

/** A cursor that lives only as long as the process. */
export function memoryCursor(initial?: bigint): Cursor {
  let last = initial
  return {
    get: async () => last,
    set: async (block) => {
      last = block
    },
  }
}

/**
 * A cursor persisted as JSON.
 *
 * Carries the chain id and refuses to answer for a different one. Pointing a Gnosis watch tower at a
 * mainnet state file would otherwise resume from a block number that means nothing there, and quietly
 * skip every order in between.
 */
export function fileCursor(path: string, chainId: number): Cursor {
  return {
    async get() {
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }

      const state = JSON.parse(raw) as { chainId?: number; lastProcessedBlock?: string }
      if (state.chainId !== chainId) {
        throw new Error(`${path} holds state for chain ${state.chainId}, not ${chainId}`)
      }
      return state.lastProcessedBlock === undefined ? undefined : BigInt(state.lastProcessedBlock)
    },

    async set(block) {
      await mkdir(dirname(path), { recursive: true })
      // A string, because JSON has no bigint and the number would silently lose precision on a chain
      // whose height ever exceeded 2^53. Cheap insurance for a field that must not drift.
      await writeFile(path, `${JSON.stringify({ chainId, lastProcessedBlock: block.toString() }, null, 2)}\n`)
    },
  }
}
