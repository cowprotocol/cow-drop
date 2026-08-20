import { formatUnits } from 'viem'

import type { BridgeRoutes } from '../lib/bridge.js'

/**
 * Every route the provider offered, and why the unusable ones cannot be used.
 *
 * The disabled rows are the point of this component, not a side effect of it. The route set used to be
 * reduced to a single winner before the app ever saw it, which meant a mode with no working route
 * showed as an empty screen — indistinguishable from an outage, and impossible to argue with. A list
 * where each refusal states its reason is the same refusal, made legible.
 *
 * `label.radio` because the tab already uses it for options whose label is a sentence, and a disabled
 * reason *is* a sentence. A table would have forced the reason into a column and lost it.
 */
export function BridgeRouteList({
  listing,
  selectedId,
  onSelect,
  busy,
}: {
  listing: BridgeRoutes
  selectedId: string | null
  onSelect: (routeId: string) => void
  busy: boolean
}) {
  const allDisabled = listing.routes.every((route) => !route.allowed)

  return (
    <>
      {allDisabled && (
        <p className="hint warn-box">
          Every route offered for this delivery is disabled, for the reasons below. This is a refusal
          rather than a failure — nothing here can be sent, and no amount of retrying changes that.
        </p>
      )}

      {listing.routes.map((route) => (
        <label key={route.id} className="radio">
          <input
            type="radio"
            name="route"
            checked={selectedId === route.id}
            onChange={() => onSelect(route.id)}
            disabled={!route.allowed || busy}
          />
          <span>
            <strong>{route.name}</strong>
            <span className="hint">
              {' · '}
              {`~${formatUnits(route.output.amount, route.output.token.decimals)} ${route.output.token.symbol}`}
              {' · '}
              {/* Never "about 0 min": a missing estimate is unknown, and zero is a claim. */}
              {route.estimatedSeconds === null ? 'time unknown' : describeDuration(route.estimatedSeconds)}
            </span>
            <div className="hint">
              at least {formatUnits(route.output.minAmount, route.output.token.decimals)}{' '}
              {route.output.token.symbol} — the bridge&apos;s own figures, which nothing here can check.
            </div>
            {!route.allowed && <div className="hint warn-note">{route.disabledReason}</div>}
          </span>
        </label>
      ))}
    </>
  )
}

/** Seconds as something readable, without rounding a real estimate down to nothing. */
export function describeDuration(seconds: number): string {
  if (seconds < 90) return `~${Math.round(seconds)}s`
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  return minutes === 0 ? `~${hours} h` : `~${hours} h ${minutes} min`
}
