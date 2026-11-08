import { useEffect, useMemo, useState } from 'react'

import {
  clearActivity,
  dropName,
  listActivity,
  onActivityChanged,
  type ActivityEntry,
} from '../lib/activity.js'
import { chainLabel } from '../lib/chain.js'
import { listDrops } from '../lib/storage.js'
import { ChainLogo } from './ChainLogo.js'
import { ChainTag } from './ChainTag.js'
import {
  ALL,
  ChainFilterSelect,
  OwnerFilterSelect,
  ownerMatches,
  type ChainFilter,
  type OwnerFilter,
} from './ListFilters.js'
import { Select, type SelectOption } from './Select.js'

/** `1 event`, not `1 events`. */
function events(count: number): string {
  return `${count} ${count === 1 ? 'event' : 'events'}`
}

/** A drop's identity in this list: the same address on two chains is two drops. */
function dropKey(entry: ActivityEntry): string {
  return `${entry.chainId}:${entry.drop.toLowerCase()}`
}

/** Local calendar day, as a sortable key. Not the ISO date, which would group by UTC and split an evening. */
function dayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/**
 * What to call a day: `Today`, `Yesterday`, or the date itself.
 *
 * The weekday is included because these lists are read to answer "when did that happen" — and over a
 * week, `Thu 6 Nov` is placed instantly where `06/11/2026` has to be worked out. The year appears only
 * when it is not this one, which is the only time it carries information.
 */
function dayLabel(at: number): string {
  const date = new Date(at)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  if (dayKey(at) === dayKey(today.getTime())) return 'Today'
  if (dayKey(at) === dayKey(yesterday.getTime())) return 'Yesterday'

  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  })
}

/** The time of day, which is all a row needs once its group says the date. */
function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** Entries split into consecutive days, newest first — the order they already arrive in. */
function byDay(entries: ActivityEntry[]): { key: string; at: number; entries: ActivityEntry[] }[] {
  const days: { key: string; at: number; entries: ActivityEntry[] }[] = []
  for (const entry of entries) {
    const key = dayKey(entry.at)
    const current = days[days.length - 1]
    if (current?.key === key) current.entries.push(entry)
    else days.push({ key, at: entry.at, entries: [entry] })
  }
  return days
}

/**
 * The keeper's activity for this browser's drops, newest first, from local storage.
 *
 * Each line names the drop it belongs to. That was always in the record — the list just used to bury
 * it inside the title — and naming it is what makes the filter below possible: with three drops
 * running, a page of "Order posted" lines is not a history of anything.
 */
export function ActivityLog({ account }: { account: string | null }) {
  const [entries, setEntries] = useState(listActivity)
  const [only, setOnly] = useState<string>(ALL)
  const [chain, setChain] = useState<ChainFilter>(ALL)
  const [owner, setOwner] = useState<OwnerFilter>(ALL)

  useEffect(() => onActivityChanged(() => setEntries(listActivity())), [])

  /*
   * Who owns the drop a line belongs to.
   *
   * An activity entry records what happened, not who owns the thing it happened to — so the owner
   * is looked up in the saved recipes, the only place this browser holds one. A line about a drop
   * it has never saved has no owner to report, and says so rather than guessing.
   */
  const ownerOf = useMemo(() => {
    const byDrop = new Map<string, string>()
    for (const saved of listDrops()) {
      byDrop.set(`${saved.chainId}:${saved.address.toLowerCase()}`, saved.recipe.owner.toLowerCase())
    }
    return (entry: ActivityEntry) => byDrop.get(dropKey(entry)) ?? null
  }, [entries])

  /*
   * The two filters compose, and the drop list narrows to the chosen chain rather than offering drops
   * that would produce an empty list. Picking a chain is the coarser cut, so it is the one that gets
   * to restrict the other.
   */
  const onChain = useMemo(
    () =>
      entries.filter(
        (entry) => (chain === ALL || entry.chainId === chain) && ownerMatches(owner, ownerOf(entry)),
      ),
    [entries, chain, owner, ownerOf],
  )

  /** One option per drop on the chosen chain, newest first. */
  const options = useMemo<SelectOption<string>[]>(() => {
    const seen = new Map<string, { label: string; chainId: number; address: string }>()
    for (const entry of onChain) {
      if (!seen.has(dropKey(entry))) {
        seen.set(dropKey(entry), { label: dropName(entry), chainId: entry.chainId, address: entry.drop })
      }
    }
    return [
      { value: ALL, label: 'All drops', description: events(onChain.length) },
      ...[...seen].map(([key, drop]) => ({
        value: key,
        label: drop.label,
        description: chainLabel(drop.chainId),
        keywords: drop.address,
        icon: <ChainLogo chainId={drop.chainId} size={18} />,
      })),
    ]
  }, [onChain])

  /*
   * A drop selected on one chain is not on the list once another is chosen, and leaving it set would
   * filter everything away with no visible cause. Cleared during render rather than in an effect, so
   * no frame is ever painted showing that empty list.
   */
  const selectable = only === ALL || options.some((option) => option.value === only)
  if (!selectable) setOnly(ALL)

  const shown = useMemo(
    () => (only === ALL ? onChain : onChain.filter((entry) => dropKey(entry) === only)),
    [onChain, only],
  )

  const days = useMemo(() => byDay(shown), [shown])

  return (
    /*
     * Not foldable: on its own tab this is the whole page, and a page that opens collapsed is a page
     * with nothing on it.
     */
    <section>
      <div className="activity-title">
        <h2>
          Activity <span className="section-count">({entries.length})</span>
        </h2>
      </div>
      {/*
        Both filters, whenever there is anything at all to filter.
        
        They used to appear only once there were two chains or two drops to choose between, which read
        as tidy and was not: with one drop on one chain you got no controls, so nobody ever learnt the
        filters existed before the day they needed them. A dropdown reading "All chains · 1 event" is a
        smaller cost than a feature nobody can find.
      */}
      {entries.length > 0 && (
        <div className="activity-head">
          <ChainFilterSelect
            chainIds={entries.map((entry) => entry.chainId)}
            value={chain}
            onChange={setChain}
            noun="event"
            total={entries.length}
          />
          <OwnerFilterSelect
            owners={entries.map(ownerOf)}
            value={owner}
            onChange={setOwner}
            noun="event"
            total={entries.length}
            account={account}
          />
          <Select
            className="activity-filter"
            value={only}
            options={options}
            onChange={setOnly}
            searchable={options.length > 6}
            filterPlaceholder="Drop name or address"
          />
        </div>
      )}

      {entries.length === 0 ? (
        <p className="hint">
          Nothing yet. Activations and orders for drops handed to the keeper appear here.
        </p>
      ) : (
        <>
          {days.map((day) => (
            <div className="activity-day" key={day.key}>
              {/* The date is said once, per group, so every row below it is just a time. */}
              <h3>{dayLabel(day.at)}</h3>

              <ul className="activity">
                {day.entries.map((entry) => (
                  <li key={entry.id} className={`activity-${entry.tone}`}>
                    <div className="activity-line">
                      <span className="activity-title">{entry.title}</span>
                      {entry.detail && <span className="hint">{entry.detail}</span>}
                    </div>

                    <div className="activity-meta">
                      <ChainTag chainId={entry.chainId} address={entry.drop} label={dropName(entry)} />
                      {/* `dateTime` keeps the full instant, so what is read out is never just an hour. */}
                      <time dateTime={new Date(entry.at).toISOString()} title={new Date(entry.at).toLocaleString()}>
                        {timeLabel(entry.at)}
                      </time>
                      {entry.links.map((link) => (
                        <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
                          {link.label} ↗
                        </a>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {shown.length === 0 && <p className="hint">Nothing matches this filter.</p>}

          <div className="actions">
            <button onClick={clearActivity}>Clear history</button>
          </div>
        </>
      )}
    </section>
  )
}
