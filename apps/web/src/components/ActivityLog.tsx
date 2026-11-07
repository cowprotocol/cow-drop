import { useEffect, useMemo, useState } from 'react'

import {
  clearActivity,
  dropName,
  listActivity,
  onActivityChanged,
  type ActivityEntry,
} from '../lib/activity.js'
import { chainLabel } from '../lib/chain.js'
import { ChainLogo } from './ChainLogo.js'
import { ChainTag } from './ChainTag.js'
import { Section } from './Section.js'
import { Select, type SelectOption } from './Select.js'

/**
 * The filter value meaning "no restriction".
 *
 * Safe for both filters: it is not an address, and `Select` compares chain options by number, so it
 * cannot collide with a chain id either.
 */
const ALL = 'all'

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
export function ActivityLog() {
  const [entries, setEntries] = useState(listActivity)
  const [only, setOnly] = useState<string>(ALL)
  const [chain, setChain] = useState<number | typeof ALL>(ALL)

  useEffect(() => onActivityChanged(() => setEntries(listActivity())), [])

  /** One option per chain in the history, each counting its own events. */
  const chainOptions = useMemo<SelectOption<number | typeof ALL>[]>(() => {
    const counts = new Map<number, number>()
    for (const entry of entries) counts.set(entry.chainId, (counts.get(entry.chainId) ?? 0) + 1)
    return [
      { value: ALL, label: 'All chains', description: `${entries.length} events` },
      ...[...counts].map(([chainId, count]) => ({
        value: chainId,
        label: chainLabel(chainId),
        description: `${count} ${count === 1 ? 'event' : 'events'}`,
        icon: <ChainLogo chainId={chainId} size={18} />,
      })),
    ]
  }, [entries])

  /*
   * The two filters compose, and the drop list narrows to the chosen chain rather than offering drops
   * that would produce an empty list. Picking a chain is the coarser cut, so it is the one that gets
   * to restrict the other.
   */
  const onChain = useMemo(
    () => (chain === ALL ? entries : entries.filter((entry) => entry.chainId === chain)),
    [entries, chain],
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
      { value: ALL, label: 'All drops', description: `${onChain.length} events` },
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
   * How many drops the *whole* history holds, which is what decides whether the drop filter is shown
   * at all — not how many survive the chain filter. Keyed off the full set so the control does not
   * appear and vanish as chains are picked: a filter with one option is a smaller surprise than a
   * filter that moves the thing under your cursor.
   */
  const dropCount = useMemo(() => new Set(entries.map(dropKey)).size, [entries])

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
     * The one panel on this tab that opens expanded. Everything else here is looked up on purpose;
     * this is the thing you did not know to ask about, so it has to be on screen without a click.
     */
    <Section title={<>Activity <span className="section-count">({entries.length})</span></>}>
      {/* Below the heading rather than beside it: a control inside a `<summary>` toggles the panel. */}
      {(chainOptions.length > 2 || dropCount > 1) && (
        <div className="activity-head">
          {/* Each filter appears only once it has something to choose between. */}
          {chainOptions.length > 2 && (
            <Select
              className="activity-filter"
              value={chain}
              options={chainOptions}
              onChange={setChain}
            />
          )}
          {dropCount > 1 && (
            <Select
              className="activity-filter"
              value={only}
              options={options}
              onChange={setOnly}
              searchable={options.length > 6}
              filterPlaceholder="Drop name or address"
            />
          )}
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
    </Section>
  )
}
