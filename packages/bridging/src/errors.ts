import type { Verification } from './checks.js'

/** Why a quote could not be produced. Codes rather than prose, so a UI can map them to a sentence. */
export type BridgeErrorCode =
  /** The provider is reachable but has no route for this pair and amount. */
  | 'no-routes'
  /**
   * The provider offered routes and every one of them is disabled.
   *
   * Kept apart from `no-routes` because the user's next move differs: `no-routes` means change the
   * chain, token or amount, while this means switch to direct delivery. It is also the code the
   * atomic path returns for as long as no bridge has been watched running a payload — a deliberate
   * refusal rather than an outage, and the message has to read that way.
   */
  | 'no-eligible-routes'
  /** The provider rejected the quote request. */
  | 'quote-failed'
  /** A route was quoted but its transaction could not be built. */
  | 'build-failed'
  /**
   * The selected route's quote expired before it could be built.
   *
   * Split out of `build-failed` because it is the one build failure with an obvious remedy, and a
   * two-step flow makes it common: the user reads a list of routes and then chooses from it.
   */
  | 'route-expired'
  /** A blocking check failed. `details` is the `Verification`. */
  | 'unsafe-quote'
  /** `buildQuote` was given an id that is not in the route set — usually a stale set. */
  | 'route-not-found'
  /** The quote being sent has expired. Thrown at the wallet boundary, not at quote time. */
  | 'expired'
  /** The provider could not be reached, or answered with something that is not a response. */
  | 'unreachable'

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

/**
 * Narrows a caught error to the one that carries a verdict worth displaying.
 *
 * Duck-typed on `code` rather than `instanceof`, matching how the web app already reads these — an
 * error crossing a bundle boundary can fail an `instanceof` while being exactly the right object.
 */
export function isUnsafeQuote(error: unknown): error is BridgeError & { details: Verification } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'unsafe-quote' &&
    'details' in error
  )
}
