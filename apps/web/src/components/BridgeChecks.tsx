import { CHECK_TITLES, type CheckOutcome } from '../lib/bridge.js'

/**
 * The verdict on a transaction, check by check.
 *
 * Every row carries three things, and all three are load-bearing: what was checked, what the answer
 * was, and whether the answer *stops* you. The last one is why severity is shown on passing rows too —
 * a reader who only learns that a check was advisory at the moment it fails has no way to calibrate,
 * and a list of undifferentiated alarms is a list people learn to click past.
 *
 * The two middle states are rendered differently on purpose. `unknown` means we could not tell, and it
 * stops a blocking check — folding it into a pass is the exact move that strands money. `not applicable`
 * means the question does not arise in this mode, and it must read as the non-event it is, or people
 * start looking for a way to override something that was never in the way.
 */
export function BridgeChecks({ checks }: { checks: readonly CheckOutcome[] }) {
  if (checks.length === 0) return null

  return (
    <ul className="status">
      {checks.map((check) => (
        <li key={`${check.check}:${check.detail}`} className={rowClass(check)}>
          {CHECK_TITLES[check.check] ?? check.check}: <strong>{verdict(check)}</strong>
          <span
            className={tagClass(check)}
            title={
              check.severity === 'blocking'
                ? 'Blocking: this must pass before the transaction can be sent.'
                : 'Advisory: worth reading, but it does not stop the send.'
            }
            aria-label={
              check.severity === 'blocking'
                ? 'Blocking: this must pass before the transaction can be sent.'
                : 'Advisory: worth reading, but it does not stop the send.'
            }
          >
            {check.severity}
          </span>
          <div className="hint">{check.detail}</div>
        </li>
      ))}
    </ul>
  )
}

/** Colour follows the answer, not the severity — a failed advisory is a warning, not an error. */
function rowClass(check: CheckOutcome): string | undefined {
  // Nothing is wrong when a check does not apply, so it gets no colour at all.
  if (check.state === 'pass' || check.state === 'not-applicable') return undefined
  if (check.state === 'unknown') return check.severity === 'blocking' ? 'error' : 'warn'
  return check.severity === 'blocking' ? 'error' : 'warn'
}

function tagClass(check: CheckOutcome): string {
  if (check.severity === 'advisory' || check.state === 'not-applicable') return 'keeper-tag muted'
  return check.state === 'pass' ? 'keeper-tag' : 'keeper-tag warn'
}

function verdict(check: CheckOutcome): string {
  if (check.state === 'pass') return 'ok'
  if (check.state === 'not-applicable') return 'not applicable'
  if (check.state === 'unknown') return 'could not be checked'
  return 'FAILED'
}
