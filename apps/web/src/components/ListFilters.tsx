import { useMemo } from 'react'

import { chainLabel } from '../lib/chain.js'
import { ChainLogo } from './ChainLogo.js'
import { Select, type SelectOption } from './Select.js'

/**
 * The chain and owner filters, shared by the activity feed and the saved-drops list.
 *
 * One component because they are the same question asked of two lists, and two implementations of
 * it would drift — the activity feed already had a chain filter with counts, a specific empty state
 * and a rule about when it appears, and none of that is worth writing twice.
 *
 * Both filters are shown whenever the list has anything in it at all, even with one option. They
 * used to appear only once there were two things to choose between, which read as tidy and was not:
 * with one drop on one chain nobody ever learnt the filters existed before the day they needed them.
 */

/** "No restriction". Not an address and not a chain id, so it cannot collide with either. */
export const ALL = 'all'

export type ChainFilter = number | typeof ALL
export type OwnerFilter = string

/** `n items`, pluralised. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** An address as it is shown in a filter row: short, but long enough to tell two apart. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`
}

export function ChainFilterSelect({
  chainIds,
  value,
  onChange,
  noun,
  total,
}: {
  /** One entry per item, not a unique set — the counts come from the repetition. */
  chainIds: number[]
  value: ChainFilter
  onChange: (value: ChainFilter) => void
  /** What the things being counted are called: `event`, `drop`. */
  noun: string
  total: number
}) {
  const options = useMemo<SelectOption<ChainFilter>[]>(() => {
    const counts = new Map<number, number>()
    for (const id of chainIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    return [
      { value: ALL, label: 'All chains', description: count(total, noun) },
      ...[...counts].map(([chainId, n]) => ({
        value: chainId,
        label: chainLabel(chainId),
        description: count(n, noun),
        icon: <ChainLogo chainId={chainId} size={18} />,
      })),
    ]
  }, [chainIds, noun, total])

  return <Select className="list-filter" value={value} options={options} onChange={onChange} />
}

export function OwnerFilterSelect({
  owners,
  value,
  onChange,
  noun,
  total,
  account,
}: {
  /**
   * One entry per item, lowercased, or null where the owner is not known.
   *
   * Null is a real answer, not missing data: a drop the keeper holds and this browser does not has
   * no recipe here, and the owner lives in the recipe. Those are counted separately rather than
   * silently folded into one of the real owners.
   */
  owners: (string | null)[]
  value: OwnerFilter
  onChange: (value: OwnerFilter) => void
  noun: string
  total: number
  /** The connected account, so its own row says so rather than being one hex string among several. */
  account: string | null
}) {
  const options = useMemo<SelectOption<OwnerFilter>[]>(() => {
    const counts = new Map<string, number>()
    let unknown = 0
    for (const owner of owners) {
      if (owner === null) unknown += 1
      else counts.set(owner, (counts.get(owner) ?? 0) + 1)
    }

    const connected = account?.toLowerCase()
    const rows = [...counts].map(([owner, n]) => ({
      value: owner,
      label: owner === connected ? 'You' : shortAddress(owner),
      description: owner === connected ? `${shortAddress(owner)} · ${count(n, noun)}` : count(n, noun),
      keywords: owner,
    }))

    // The connected account first: it is the one row anybody is looking for.
    rows.sort((a, b) => Number(b.value === connected) - Number(a.value === connected))

    return [
      { value: ALL, label: 'All owners', description: count(total, noun) },
      ...rows,
      ...(unknown > 0
        ? [{ value: 'unknown', label: 'Owner unknown', description: count(unknown, noun) }]
        : []),
    ]
  }, [owners, noun, total, account])

  return (
    <Select
      className="list-filter"
      value={value}
      options={options}
      onChange={onChange}
      searchable={options.length > 6}
      filterPlaceholder="Owner address"
    />
  )
}

/** Whether an item's owner passes the filter. `null` is matched only by the explicit unknown row. */
export function ownerMatches(filter: OwnerFilter, owner: string | null): boolean {
  if (filter === ALL) return true
  if (filter === 'unknown') return owner === null
  return owner !== null && owner.toLowerCase() === filter
}
