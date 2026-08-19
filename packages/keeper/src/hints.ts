import type { DropRecipeJson, DropStepJson } from '@cowprotocol/cow-drop-sdk'
import type { Address, Hex } from 'viem'

import type { WatchHints } from './types.js'

/**
 * Bump when this file learns to read something it could not before.
 *
 * Hints are cached on the record, so without a version a lossy inference made by an older build would
 * pin the poll set for the life of a registration — a drop stuck `blind` forever because the SDK that
 * first saw it could not name a step the current one can.
 */
export const HINTS_VERSION = '1'

const ZERO: Address = '0x0000000000000000000000000000000000000000'

/**
 * What to poll, from the recipe.
 *
 * ## This decides nothing
 *
 * Readiness is decided by simulating the activation, because a recipe can express conditions nothing
 * off-chain can read: `requireCallResult` carries opaque inner calldata, and a `raw` step is opaque
 * entirely. So everything here only answers *"is an `eth_call` worth spending yet?"*, and being wrong
 * costs latency, never a wrong activation.
 *
 * That is why `minBalance` is advisory and why an unreadable recipe is `blind` rather than rejected: a
 * blind drop is simulated on a timer instead, and activates a few minutes later than it might have.
 */
export function deriveHints(recipe: DropRecipeJson): WatchHints {
  const tokens = new Set<Address>()
  const minBalance: Record<Address, string> = {}
  const warnings: string[] = []

  let native = false
  let notBefore: number | null = null
  let notAfter: number | null = null
  let timeWindows = 0

  for (const [index, step] of recipe.steps.entries()) {
    switch (step.type) {
      case 'presignSellAll':
      case 'presignSellAllAtOracle':
      case 'twapFromBalance':
      case 'stopLossFromBalance':
        tokens.add(lower(step.sellToken))
        break

      case 'wrapNative':
        // Funded in the chain's own currency, then wrapped at activation. The wrapped token shows up
        // as some later step's `sellToken`; what has to *arrive* is the native balance.
        native = true
        break

      case 'requireMinBalance': {
        const token = lower(step.token)
        if (token === ZERO) native = true
        else tokens.add(token)
        minBalance[token] = String(step.minAmount)
        break
      }

      case 'requireTimeWindow': {
        timeWindows++
        if (step.notBefore !== undefined) notBefore = maxOf(notBefore, Number(step.notBefore))
        if (step.notAfter !== undefined) notAfter = minOf(notAfter, Number(step.notAfter))
        break
      }

      case 'requireCallResult':
        // Decodable as a call, not as a meaning: the SDK deliberately refuses to interpret the inner
        // calldata, so this guard is invisible here and only the simulation will see it.
        warnings.push(`step ${index + 1} is a requireCallResult guard, which only the simulation can evaluate`)
        break

      case 'raw':
        warnings.push(`step ${index + 1} is a raw call, so nothing about it can be inferred`)
        break

      case 'approveBalance':
      case 'approveMax':
        tokens.add(lower(step.token))
        break

      case 'sweep':
        break
    }
  }

  const blind = tokens.size === 0 && !native

  return {
    tokens: [...tokens],
    native,
    minBalance,
    notBefore,
    notAfter,
    // Narrow on purpose: exactly one window, and every step readable. With two windows the earliest
    // bound is still right but the reasoning is no longer obvious, and with any step we could not
    // read there may be another deadline we cannot see — retiring on it would stop watching a live
    // drop. (A window can never be `allowFailure`: the SDK forces guards to non-failable, which is
    // why that case is absent rather than handled.)
    notAfterIsHard: notAfter !== null && timeWindows === 1 && warnings.length === 0,
    blind,
    warnings,
  }
}

/** Addresses are compared as lowercase strings throughout, so normalise on the way in. */
function lower(address: Address): Address {
  return address.toLowerCase() as Address
}

/** The strictest lower bound wins: the drop cannot run until every `notBefore` has passed. */
function maxOf(current: number | null, next: number): number {
  return current === null ? next : Math.max(current, next)
}

/** The strictest upper bound wins: the drop is dead once the earliest `notAfter` has passed. */
function minOf(current: number | null, next: number): number {
  return current === null ? next : Math.min(current, next)
}

/** Every `(token | native)` balance worth reading for a drop. */
/**
 * Steps that hand the drop to ComposableCoW rather than signing one order here.
 *
 * `twapFromBalance` splits the balance into parts CoW's watch tower posts as they come due;
 * `stopLossFromBalance` registers an order that waits on an oracle. Either way the order this keeper
 * can see — `OrderPlacement` — is never emitted, so there is no uid, no `validTo`, and no way to tell
 * a finished schedule from a running one.
 */
const SELF_DRIVING_STEPS = new Set<DropStepJson['type']>(['twapFromBalance', 'stopLossFromBalance'])

/**
 * Whether activating this recipe leaves behind a conditional order the keeper cannot see the end of.
 *
 * The reason a reusable drop is not always re-armed after it activates. A TWAP's balance *falls as its
 * parts fill*, so no balance-watching gate can hold it — activating again would register a second TWAP
 * over what the first has left. Such a drop is parked in `activated`; every other reusable recipe signs
 * a discrete order with a deadline this keeper can read, and goes back to watching.
 */
export function selfDriving(recipe: DropRecipeJson): boolean {
  return recipe.steps.some((step) => SELF_DRIVING_STEPS.has(step.type))
}

export function pollTargets(hints: WatchHints): (Address | null)[] {
  return [...(hints.native || hints.blind ? [null] : []), ...hints.tokens]
}

/**
 * A fingerprint of what a poll saw, so an unchanged set can skip the simulation.
 *
 * This is the whole cost control: without it a funded-but-not-ready drop — one waiting on a time
 * window, or on a `requireCallResult` — costs an `eth_call` every single tick, forever.
 */
export function balancesDigest(balances: readonly bigint[]): string {
  return balances.join(',')
}

/** Whether the recipe's own step list can be read at all. Kept next to the union it switches on. */
export function isKnownStep(step: DropStepJson): boolean {
  return step.type !== 'raw'
}

/** One order a recipe will place, and the appData hash it commits to. */
export interface RecipeTrade {
  sellToken: Address
  /** The committed hash. The document behind it, if any, has to be supplied separately. */
  appData: Hex
}

const ZERO_APP_DATA: Hex = `0x${'00'.repeat(32)}`

/**
 * The trades a recipe will place.
 *
 * Read off the typed step union rather than the decoder, so `sellToken` and `appData` come out
 * exactly as the SDK will compile them. A step with no `appData` commits the zero hash, which is the
 * "no document" case and can carry no fee.
 */
export function tradesOf(recipe: DropRecipeJson): RecipeTrade[] {
  const trades: RecipeTrade[] = []

  for (const step of recipe.steps) {
    switch (step.type) {
      case 'presignSellAll':
      case 'presignSellAllAtOracle':
      case 'twapFromBalance':
      case 'stopLossFromBalance':
        trades.push({ sellToken: lower(step.sellToken), appData: step.appData ?? ZERO_APP_DATA })
        break
      default:
        break
    }
  }

  return trades
}
