import { useMemo, useState } from 'react'

import { CHAIN_ID } from '../lib/chain.js'
import type { TokenInfo } from '../lib/tokenList.js'
import { tokenLogoUrls } from '../lib/tokenLogo.js'

/**
 * A token logo that walks the fallback cascade on error, as cowswap does.
 *
 * Sources fail routinely — CoW's CDN answers 403 for addresses it does not carry — so a single `src`
 * would leave broken images all over the picker. When every source fails, falls back to the token's
 * initial rather than a broken-image icon.
 */
export function TokenLogo({ token, size = 22 }: { token: TokenInfo; size?: number }) {
  const urls = useMemo(() => tokenLogoUrls(token, CHAIN_ID), [token])
  const [index, setIndex] = useState(0)

  const exhausted = index >= urls.length

  if (exhausted) {
    return (
      <span className="token-logo token-logo-fallback" style={{ width: size, height: size }} aria-hidden="true">
        {token.symbol.slice(0, 1)}
      </span>
    )
  }

  return (
    <img
      className="token-logo"
      src={urls[index]}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setIndex((current) => current + 1)}
    />
  )
}
