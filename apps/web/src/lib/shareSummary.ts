import type { DropRecipeJson, DropStepJson, LimitPriceJson } from '@cowprotocol/cow-drop-sdk'
import { formatUnits, type Address } from 'viem'

import { chainLabel } from './chain.js'

/**
 * A recipe in plain language, for the share card.
 *
 * Deliberately *not* `describeRecipe` from the SDK, which decodes the committed bytes into the calls
 * they really are — contract names, ABI argument names, atomic integers. That is the right answer for
 * someone auditing what they are about to fund, and it is what `StepTable` shows. It is the wrong
 * answer for a link posted in public, where the reader has not met the project and the question is
 * "what is this address going to do with my money".
 *
 * So this reads the recipe *file* instead of the bytes. The file is the authoring surface: it still
 * says `parts: 12` rather than an encoded uint, which is what makes a friendly rendering possible at
 * all. The honest-but-technical view stays one click away rather than being replaced.
 *
 * Pure, and free of React, so the wording can be tested without a DOM.
 */

export interface SummaryRow {
  label: string
  value: string
  /** Shown small, under the value. For the exact thing behind a rounded or friendly one. */
  hint?: string
}

export interface RecipeSummary {
  /** One sentence, for the top of the card. */
  headline: string
  rows: SummaryRow[]
  /**
   * Things a reader should know before funding, in the recipe's own terms.
   *
   * Only ever populated from what the recipe actually says — an empty list means there is nothing to
   * warn about, not that the check was skipped.
   */
  notes: string[]
}

/** Resolves a token address to a symbol, or returns undefined when the list has never heard of it. */
export type SymbolLookup = (address: Address) => string | undefined

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** A token as a reader should see it: its symbol when we know it, and always its address. */
function token(address: Address, symbolOf: SymbolLookup): { name: string; hint: string } {
  const symbol = symbolOf(address)
  return { name: symbol ?? short(address), hint: address }
}

/**
 * Seconds as a human duration. Exact multiples only — `90` minutes stays `90 minutes` rather than
 * becoming "1.5 hours", because a rounded duration in a schedule is a different schedule.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return `${String(seconds)} seconds`
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ]
  for (const [size, name] of units) {
    if (seconds % size === 0) {
      const count = seconds / size
      return `${count} ${name}${count === 1 ? '' : 's'}`
    }
  }
  return `${seconds} seconds`
}

const asNumber = (value: number | string): number => Number(value)

/**
 * A duration as it reads after "every": `every hour`, not `every 1 hour`. Anything that is not
 * exactly one unit keeps its number.
 */
function formatEvery(seconds: number): string {
  const once = formatDuration(seconds)
  return once.startsWith('1 ') ? once.slice(2) : once
}

/**
 * A limit price as the recipe wrote it.
 *
 * A decimal price is passed through verbatim rather than reformatted: it is a committed input, and a
 * display that disagreed with it in the last digit would be describing a different address. A raw
 * fraction is shown as a fraction for the same reason — dividing it out needs both tokens' decimals,
 * which that form does not carry.
 */
function formatLimitPrice(price: LimitPriceJson): string {
  if ('price' in price) return price.price
  return `${price.numerator} / ${price.denominator}`
}

/** The step that gives the drop its purpose, if it has one we can name. */
type ActionStep = Extract<
  DropStepJson,
  { type: 'presignSellAll' | 'twapFromBalance' | 'stopLossFromBalance' | 'presignSellAllAtOracle' }
>

const ACTION_TYPES = new Set([
  'presignSellAll',
  'twapFromBalance',
  'stopLossFromBalance',
  'presignSellAllAtOracle',
])

const isAction = (step: DropStepJson): step is ActionStep => ACTION_TYPES.has(step.type)

/** What each step type is called in a sentence, for the steps we do not give a bespoke row. */
const STEP_LABELS: Record<string, string> = {
  requireCallResult: 'checks a value on another contract',
  requireMinBalance: 'waits for a minimum balance',
  requireTimeWindow: 'only runs inside a time window',
  wrapNative: 'wraps the native token',
  approveMax: 'approves a spender',
  approveBalance: 'approves what arrived',
  sweep: 'sweeps the balance out',
  raw: 'makes a raw call',
}

/** Resolves a token address to its decimals, or undefined when the list has never heard of it. */
export type DecimalsLookup = (address: Address) => number | undefined

/**
 * An atomic amount in whole tokens, when the decimals are known. Unknown decimals leave the atomic
 * figure, labelled as such: guessing 18 would misstate a 6-decimal price a trillion-fold.
 */
function formatAmount(atomic: string, decimals: number | undefined): string {
  return decimals === undefined ? `${atomic} (atomic units)` : formatUnits(BigInt(atomic), decimals)
}

export function summariseRecipe(
  recipe: DropRecipeJson,
  symbolOf: SymbolLookup,
  decimalsOf?: DecimalsLookup,
): RecipeSummary {
  const rows: SummaryRow[] = []
  const notes: string[] = []

  const action = recipe.steps.find(isAction)
  const payment = recipe.steps.find(
    (step): step is Extract<DropStepJson, { type: 'payment' }> => step.type === 'payment',
  )
  const minBalance = recipe.steps.find((step) => step.type === 'requireMinBalance')
  const timeWindow = recipe.steps.find((step) => step.type === 'requireTimeWindow')

  rows.push({ label: 'Network', value: chainLabel(recipe.chainId) })

  let headline = 'Send tokens to this address and anyone can run the recipe committed into it.'

  if (payment) {
    const buy = token(payment.buyToken, symbolOf)
    const amount = formatAmount(String(payment.buyAmount), decimalsOf?.(payment.buyToken))
    const receiver = payment.receiver
    const toOwner = !receiver || receiver.toLowerCase() === recipe.owner.toLowerCase()

    // A payer needs the amount, who gets it and the network — nothing about how the address works.
    return {
      headline: `Pay ${amount} ${buy.name}, in any token.`,
      rows: [
        { label: 'Amount', value: `${amount} ${buy.name}`, hint: buy.hint },
        { label: 'To', value: short(toOwner ? recipe.owner : receiver!), hint: toOwner ? recipe.owner : receiver },
        { label: 'Network', value: chainLabel(recipe.chainId) },
      ],
      notes: [],
    }
  } else if (action) {
    const sell = token(action.sellToken, symbolOf)
    const buy = token(action.buyToken, symbolOf)

    rows.push({ label: 'Send it', value: sell.name, hint: sell.hint })
    rows.push({ label: 'It buys', value: buy.name, hint: buy.hint })

    switch (action.type) {
      case 'presignSellAll': {
        headline = `Send ${sell.name} here and it is sold for ${buy.name}.`
        rows.push({
          label: 'How',
          value: 'One swap',
          hint: `sells the whole balance, order valid for ${formatDuration(asNumber(action.validitySeconds))}`,
        })
        rows.push({ label: 'At least', value: `${formatLimitPrice(action.limitPrice)} ${buy.name} per ${sell.name}` })
        break
      }
      case 'twapFromBalance': {
        const parts = asNumber(action.parts)
        const every = formatEvery(asNumber(action.partDuration))
        headline = `Send ${sell.name} here and it is sold for ${buy.name} in ${parts} parts, one every ${every}.`
        rows.push({
          label: 'How',
          value: `TWAP — ${parts} parts, one every ${every}`,
          hint: `the whole schedule takes ${formatDuration(asNumber(action.partDuration) * parts)}`,
        })
        rows.push({ label: 'At least', value: `${formatLimitPrice(action.limitPrice)} ${buy.name} per ${sell.name}` })
        break
      }
      case 'stopLossFromBalance': {
        headline = `Send ${sell.name} here and it is sold for ${buy.name} if the price falls to the trigger.`
        rows.push({
          label: 'How',
          value: 'Stop-loss',
          hint: `fires when the oracle price drops to ${String(action.trigger.strike)}, then the order is valid for ${formatDuration(asNumber(action.validitySeconds))}`,
        })
        rows.push({ label: 'At least', value: `${formatLimitPrice(action.limitPrice)} ${buy.name} per ${sell.name}` })
        break
      }
      case 'presignSellAllAtOracle': {
        headline = `Send ${sell.name} here and it is sold for ${buy.name} at the oracle price.`
        rows.push({
          label: 'How',
          value: 'One swap, priced by an oracle',
          hint: `the oracle may only improve on the floor, and is ignored once ${formatDuration(asNumber(action.oracle.maxAge))} stale`,
        })
        rows.push({ label: 'At worst', value: `${formatLimitPrice(action.floorPrice)} ${buy.name} per ${sell.name}` })
        break
      }
    }

    const receiver = action.receiver
    const toOwner = !receiver || receiver.toLowerCase() === recipe.owner.toLowerCase()
    rows.push({
      label: 'Proceeds to',
      value: toOwner ? 'The owner' : short(receiver),
      hint: toOwner ? recipe.owner : receiver,
    })
  } else {
    // No order step. Say so rather than rendering a card that implies one.
    const named = recipe.steps.map((step) => STEP_LABELS[step.type] ?? step.type)
    rows.push({ label: 'What it does', value: named.join(', ') || 'nothing' })
    rows.push({ label: 'Owner', value: short(recipe.owner), hint: recipe.owner })
  }

  if (minBalance) {
    rows.push({
      label: 'Waits for',
      value: `${String(minBalance.minAmount)} (atomic units) to arrive`,
      hint: 'activating earlier reverts, so a part-filled bridge cannot size the order',
    })
  }

  if (timeWindow) {
    const from = timeWindow.notBefore ? new Date(asNumber(timeWindow.notBefore) * 1000).toUTCString() : null
    const until = timeWindow.notAfter ? new Date(asNumber(timeWindow.notAfter) * 1000).toUTCString() : null
    rows.push({
      label: 'Only between',
      value: [from ?? 'now', until ?? 'forever'].join(' → '),
    })
  }

  rows.push({
    label: 'Who can trigger it',
    value: 'Anyone',
    hint: 'no signature anywhere — the recipe is committed into the address, so triggering it cannot change it',
  })

  rows.push({
    label: 'Reusable',
    value: recipe.once ? 'No — runs once' : 'Yes — runs again each time it is funded',
  })

  /*
   * The one thing a public link makes materially more likely, straight out of docs/DESIGN.md:
   * activation is permissionless, so "nobody will trigger this early" is not a promise anyone can
   * make — and without a minimum balance the first tranche to land sizes the whole order. Posting the
   * link is precisely what puts that in front of strangers.
   */
  if (recipe.once && !minBalance) {
    notes.push(
      'This drop runs once and has no minimum balance, so whoever triggers it first sizes the order to whatever has arrived by then. Fund it in one go.',
    )
  }

  return { headline, rows, notes }
}
