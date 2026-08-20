import { useEffect, useState } from 'react'

import { bridgeExplorerUrl } from '../lib/bridge.js'
import { blockExplorer, chainInfo, cowExplorer } from '../lib/chain.js'
import { forgetBridge, listBridges, type SavedBridge } from '../lib/storage.js'

/**
 * The bridges this browser has sent, newest first.
 *
 * Deliberately a list of links rather than a status poller. A bridge's real state lives on two chains
 * and a relayer's API, and the honest answer to "has it landed" is the drop's own balance — so this
 * carries you to the three places that answer it rather than paraphrasing them, and cannot go stale or
 * claim a fill that did not happen.
 *
 * Shown whether or not a recipe is loaded, because checking on a bridge from an hour ago is exactly the
 * case where you arrive with nothing else on screen.
 */
export function BridgeHistory({ revision }: { revision: number }) {
  const [bridges, setBridges] = useState<SavedBridge[]>([])

  useEffect(() => setBridges(listBridges()), [revision])

  if (bridges.length === 0) return null

  return (
    <section>
      <h3>Bridges you have sent</h3>
      <p className="hint">
        Kept in this browser. The order appears in CoW Explorer once the bridge fills and the drop
        activates — nothing here needs an action from you.
      </p>

      <ul className="bridge-history">
        {bridges.map((bridge) => (
          <li key={bridge.hash}>
            <div className="bridge-history-row">
              <strong>
                {bridge.sent.amount} {bridge.sent.symbol}
              </strong>
              <span className="muted">
                {chainName(bridge.sourceChainId)} → {chainName(bridge.destinationChainId)} · {bridge.route} ·{' '}
                {bridge.mode === 'atomic' ? 'atomic' : 'direct'} · {new Date(bridge.sentAt).toLocaleString()}
              </span>
            </div>
            <div className="bridge-history-row muted">
              for <code>{bridge.label}</code>, expecting ~{bridge.expected.amount} {bridge.expected.symbol}
            </div>
            <div className="bridge-history-row">
              <a href={bridgeExplorerUrl(bridge.hash as `0x${string}`)} target="_blank" rel="noreferrer">
                Bridge
              </a>
              <a
                href={`${explorerUrl(bridge.destinationChainId)}/address/${bridge.drop}`}
                target="_blank"
                rel="noreferrer"
              >
                Drop
              </a>
              <a
                href={`${cowExplorer(bridge.destinationChainId)}/address/${bridge.drop}`}
                target="_blank"
                rel="noreferrer"
              >
                Order
              </a>
              <button
                className="link"
                onClick={() => {
                  forgetBridge(bridge.hash)
                  setBridges(listBridges())
                }}
              >
                Forget
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Both of these fall back rather than throw: a stored row may name a chain this build dropped. */
function chainName(chainId: number): string {
  try {
    return chainInfo(chainId).label
  } catch {
    return `chain ${chainId}`
  }
}

function explorerUrl(chainId: number): string {
  try {
    return blockExplorer(chainId).url
  } catch {
    return ''
  }
}
