import {
  DROP_EXECUTOR_ABI,
  GUARD_STEPS_ABI,
  PRESIGN_STEPS_ABI,
  STOP_LOSS_STEPS_ABI,
  TOKEN_STEPS_ABI,
  TWAP_STEPS_ABI,
} from '@cowprotocol/cow-drop-sdk'
import { decodeErrorResult, toFunctionSelector, type Hex } from 'viem'

/**
 * What a failed simulation means for a drop.
 *
 * - `waiting` — the recipe is fine, the moment is not. Keep polling.
 * - `blocked` — it cannot run here yet, but that could change without the recipe changing.
 * - `terminal` — it can never run again. Stop watching.
 */
export type RevertClass = 'waiting' | 'blocked' | 'terminal'

export interface ActivationRevert {
  /** The decoded error name, or `unknown` when nothing matched. */
  name: string
  class: RevertClass
  /** Something printable for a log line or the UI. */
  detail: string
}

/**
 * The errors that mean this drop is finished.
 *
 * Deliberately a short list, and deliberately a **allowlist rather than a denylist**: see
 * `classifyRevert` for why everything else has to be `waiting`.
 *
 * - `AlreadyConsumed` — a `once` recipe has run. Nothing will change that.
 * - `NotADrop` / `MalformedRecipe` — the recipe does not reproduce the address, so this was never
 *   this address's recipe and no amount of waiting makes it one.
 * - `TooLate` — the committed window has closed.
 */
const TERMINAL = new Set(['AlreadyConsumed', 'NotADrop', 'MalformedRecipe', 'TooLate'])

/**
 * A step contract has no code on this chain yet.
 *
 * Not terminal: `DropExecutor` rejects it precisely so the activation does not silently do nothing,
 * and the contract may be deployed later — at which point the same recipe works. So this parks the
 * drop rather than retiring it.
 */
const BLOCKED = new Set(['NoCodeAtDelegateTarget'])

const ABIS = [
  DROP_EXECUTOR_ABI,
  GUARD_STEPS_ABI,
  TOKEN_STEPS_ABI,
  PRESIGN_STEPS_ABI,
  TWAP_STEPS_ABI,
  STOP_LOSS_STEPS_ABI,
] as const

/** `Error(string)`, which is what a `require` with a message and most ERC20s produce. */
const ERROR_STRING = toFunctionSelector('Error(string)')

/**
 * Turn revert data into a verdict about the drop.
 *
 * ## Unknown is always `waiting`
 *
 * The single rule that must not regress. This decoder is the lossy part of the system: a recipe may
 * call anything, a `raw` step's target has its own errors, and a future step contract will have errors
 * this build has never heard of. If an unrecognised selector could retire a drop, one unfamiliar
 * revert would stop the keeper watching an address that is perfectly alive and about to be funded.
 *
 * Being wrong in the other direction costs a poll every few minutes. That is the right asymmetry.
 */
export function classifyRevert(data: Hex | undefined, message: string): ActivationRevert {
  if (!data || data === '0x') {
    // No revert data at all: an out-of-gas, a bare `revert()`, or a node that did not return it.
    return { name: 'unknown', class: 'waiting', detail: message }
  }

  if (data.startsWith(ERROR_STRING)) {
    return { name: 'Error', class: 'waiting', detail: decodeErrorString(data) ?? message }
  }

  for (const abi of ABIS) {
    try {
      const decoded = decodeErrorResult({ abi, data })
      return {
        name: decoded.errorName,
        class: TERMINAL.has(decoded.errorName) ? 'terminal' : BLOCKED.has(decoded.errorName) ? 'blocked' : 'waiting',
        detail: formatArgs(decoded.errorName, decoded.args),
      }
    } catch {
      // Not this ABI's error. Try the next.
    }
  }

  return { name: 'unknown', class: 'waiting', detail: `${message} (${data.slice(0, 10)})` }
}

/** The reason out of a plain `revert("...")`, if that is what this is. */
function decodeErrorString(data: Hex): string | undefined {
  try {
    const decoded = decodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] }],
      data,
    })
    return String(decoded.args?.[0])
  } catch {
    return undefined
  }
}

/** A custom error rendered the way it is written in Solidity: `Name(arg, arg)`. */
function formatArgs(name: string, args: readonly unknown[] | undefined): string {
  if (!args || args.length === 0) return name
  return `${name}(${args.map((arg) => String(arg)).join(', ')})`
}
