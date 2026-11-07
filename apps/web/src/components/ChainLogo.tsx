import { useState } from 'react'

import { chainColor, chainLabel, chainLogoUrl } from '../lib/chain.js'

/**
 * A chain's mark, from cow-sdk's own chain table — the same SVGs CoW Swap renders.
 *
 * No cascade is needed the way token logos need one: there is one URL per chain and cow-sdk ships it.
 * A failure still falls back rather than leaving a broken image, to the chain's initial on its own
 * brand colour, which stays recognisable.
 */
export function ChainLogo({ chainId, size = 20 }: { chainId: number; size?: number }) {
  const [failed, setFailed] = useState(false)
  const url = chainLogoUrl(chainId)

  if (!url || failed) {
    return (
      <span
        className="chain-logo chain-logo-fallback"
        style={{ width: size, height: size, background: chainColor(chainId) }}
        aria-hidden="true"
      >
        {chainLabel(chainId).slice(0, 1)}
      </span>
    )
  }

  return (
    <img
      className="chain-logo"
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}
