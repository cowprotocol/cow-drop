import { BRIDGE_PROVIDERS, providerInfo } from '../lib/bridge.js'

/**
 * Which bridge aggregator to quote through.
 *
 * Shaped exactly like `NetworkPicker`, down to annotating the option's *text* rather than badging it —
 * this app already teaches that idiom for "an option plus its current state", and a second convention
 * for the same job would be a third thing to learn.
 *
 * Deliberately a real, enabled `<select>` even with one entry. A disabled control reads as broken, and
 * static text hides the fact that this is the extension point; an option that names itself as the only
 * one wired up says both true things at once.
 */
export function BridgeProviderPicker({
  value,
  onChange,
  busy,
}: {
  value: string
  onChange: (key: string) => void
  busy: boolean
}) {
  const info = providerInfo(value) ?? BRIDGE_PROVIDERS[0]
  const only = BRIDGE_PROVIDERS.length === 1

  return (
    <div className="network">
      <label>
        Bridge provider
        <select value={value} onChange={(event) => onChange(event.target.value)} disabled={busy || only}>
          {BRIDGE_PROVIDERS.map((provider) => (
            <option key={provider.key} value={provider.key}>
              {only ? `${provider.name} — the only one wired up` : provider.name}
            </option>
          ))}
        </select>
      </label>
      {info && (
        <p className="hint">
          The routes below are {info.name}&apos;s own (
          <a href={info.website} target="_blank" rel="noreferrer">
            {info.website}
          </a>
          ). Nothing here takes them on trust: each route is checked against this drop before it can be
          picked, and the transaction {info.name} builds is checked again before it can be signed.
        </p>
      )}
    </div>
  )
}
