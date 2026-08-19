/** Why a quote could not be produced. Codes rather than prose, so a UI can map them to a sentence. */
export type BridgeErrorCode =
  /** The provider is reachable but has no route for this pair and amount. */
  | 'no-routes'
  /** The provider rejected the quote request. */
  | 'quote-failed'
  /** A route was quoted but its transaction could not be built — usually an expired quote. */
  | 'build-failed'
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
