/** What one polling loop has managed lately. */
export interface LoopStatus {
  /** No successful pass for longer than the monitor allows. */
  stalled: boolean
  /** When the last pass succeeded, or `undefined` if none has since the process started. */
  lastSuccessAt?: number
  consecutiveFailures: number
}

export interface LoopMonitor {
  /** Report one pass: no argument for a success, the error for a failure. */
  record(error?: unknown): void
  status(): LoopStatus
}

/**
 * Whether a loop that swallows its own errors is still getting anywhere.
 *
 * `run` catches everything and retries, which is right for an RPC blip and wrong for a failure that
 * repeats forever: the process stays up, the HTTP surface stays green, and nothing activates. This is
 * the missing half — it measures time since the last pass that worked, so a pass that hangs counts
 * the same as one that throws.
 *
 * The error itself is deliberately not kept. It would end up in `/v1/health`, which is public, and an
 * RPC error message carries the RPC URL and whatever key is in it.
 */
export function createLoopMonitor(options: { now?: () => number; stallAfterMs?: number } = {}): LoopMonitor {
  const now = options.now ?? Date.now
  const stallAfterMs = options.stallAfterMs ?? 3 * 60_000
  const startedAt = now()
  let lastSuccessAt: number | undefined
  let consecutiveFailures = 0

  return {
    record(error) {
      if (error === undefined) {
        lastSuccessAt = now()
        consecutiveFailures = 0
      } else {
        consecutiveFailures++
      }
    },

    status: () => ({
      stalled: now() - (lastSuccessAt ?? startedAt) > stallAfterMs,
      ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
      consecutiveFailures,
    }),
  }
}

/** The loops of one chain, by the name `/v1/health` reports them under. */
export type ChainLoops = Record<'keeper' | 'watch-tower', LoopMonitor>

/** The stalled loops as `/v1/health` problems: `keeper-stalled`, `watch-tower-stalled`. */
export function stalledLoops(loops: Partial<ChainLoops> | undefined): string[] {
  return Object.entries(loops ?? {})
    .filter(([, monitor]) => monitor.status().stalled)
    .map(([name]) => `${name}-stalled`)
}
