import { getDropChain } from '@cowprotocol/cow-drop-sdk'
import { useEffect, useState } from 'react'

import { readKeeperHealth, type KeeperHealth } from '../lib/keeper.js'

/** Often enough to notice an outage before funding into it, rarely enough to cost nothing. */
const REFRESH_MS = 60_000

/** What each problem means for someone about to fund a drop. */
const SENTENCES: Record<string, string> = {
  'keeper-stalled':
    'has stopped activating drops. A drop funded now will sit untouched until it recovers, unless you activate it yourself.',
  'watch-tower-stalled':
    'has stopped posting orders. A drop can still activate, but its order will not reach the order book until this recovers.',
  'payer-below-floor': 'is out of gas money, so it is not paying for activations. You can still activate a drop yourself.',
  unreachable: 'cannot be reached, so nothing is watching drops there. You can still activate a drop yourself.',
}

/**
 * Says so when the keeper for `chainId` is not doing its job.
 *
 * A keeper that fails every pass still answers every request, so without this the page went on
 * offering "hand to keeper" and showing drops as watched while nothing was being activated. Silent
 * while the keeper is healthy, and absent when none is configured.
 */
export function KeeperNotice({ chainId }: { chainId: number }) {
  const [health, setHealth] = useState<KeeperHealth | null>(null)

  useEffect(() => {
    let live = true
    const refresh = () =>
      void readKeeperHealth(chainId).then((next) => {
        if (live) setHealth(next)
      })

    setHealth(null)
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [chainId])

  if (!health || health.problems.length === 0) return null
  const chain = getDropChain(chainId)?.name ?? `chain ${chainId}`

  return (
    <div className="keeper-notice" role="alert">
      {health.problems.map((problem) => (
        <p key={problem}>
          <strong>The keeper on {chain}</strong> {SENTENCES[problem] ?? `reports a problem: ${problem}.`}
        </p>
      ))}
    </div>
  )
}
