import type { ReactNode } from 'react'

import { chainLabel, explorerAddressUrl } from '../lib/chain.js'
import { ChainLogo } from './ChainLogo.js'

/**
 * Which chain something is on, and where to go and look at it.
 *
 * One component for every list in the app, because these lists answer the same question and a reader
 * should not have to learn a different shape per tab. Given an `address` it becomes a link to that
 * address on the chain's own explorer — the chain mark is the cue, and clicking it is the obvious
 * next move from any row naming a drop.
 */
export function ChainTag({
  chainId,
  address,
  label,
  size = 16,
  className,
}: {
  chainId: number
  /** When given, the tag links to this address on the chain's block explorer. */
  address?: string
  /** What to call it. Defaults to the chain's own name. */
  label?: ReactNode
  size?: number
  className?: string
}) {
  const classes = ['chain-tag', className].filter(Boolean).join(' ')
  const body = (
    <>
      <ChainLogo chainId={chainId} size={size} />
      <span className="chain-tag-label">{label ?? chainLabel(chainId)}</span>
    </>
  )

  const href = address ? explorerAddressUrl(chainId, address) : null
  if (!href) return <span className={classes}>{body}</span>

  return (
    <a
      className={classes}
      href={href}
      target="_blank"
      rel="noreferrer"
      // The full address, since the label is usually a name or a truncation of it.
      title={`${address} on ${chainLabel(chainId)}`}
    >
      {body}
    </a>
  )
}
