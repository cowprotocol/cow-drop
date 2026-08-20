import type { CompiledRecipe } from '@cowprotocol/cow-drop-sdk'
import { formatUnits } from 'viem'

import { blockExplorer, chainLabel } from '../lib/chain.js'
import type { BridgeQuote, CheckOutcome } from '../lib/bridge.js'
import { BridgeChecks } from './BridgeChecks.js'
import { BridgeDeliveryPayload } from './BridgeDeliveryPayload.js'
import { CopyBlock } from './CopyBlock.js'

/**
 * Exactly what is about to be signed, and the evidence for every claim made about it.
 *
 * The order is deliberate: the verdict first, because it decides whether the button below works; then
 * the transaction itself; then where in the bytes each checked value was actually found; then what runs
 * on arrival; then the raw material, so none of the above has to be taken on faith.
 *
 * The byte offsets are the part that makes this more than reassurance. "The drop address is in the
 * calldata" is a claim; "at byte 52, and here are the bytes" is something a person can check against a
 * block explorer without trusting this page at all.
 */
export function BridgeReview({
  quote,
  checks,
  compiled,
  expired,
}: {
  quote: BridgeQuote
  /** The library's checks plus the app's, already merged — one list, one truth. */
  checks: readonly CheckOutcome[]
  compiled: CompiledRecipe
  expired: boolean
}) {
  const tx = quote.transactionSummary
  const source = explorerFor(tx.chainId)
  const destination = explorerFor(quote.route.output.token.chainId)
  const receiverIsDrop = quote.destination.receiver.toLowerCase() === quote.destination.predictedAddress.toLowerCase()
  const located = checks.filter((check) => check.state === 'pass' && check.where !== undefined)

  return (
    <>
      <BridgeChecks checks={checks} />

      <h4>The transaction</h4>
      <dl className="facts">
        <dt>Network</dt>
        <dd>
          {chainLabel(tx.chainId)} <span className="hint">(chain id {tx.chainId})</span>
        </dd>

        <dt>To</dt>
        <dd>
          {source ? (
            <a href={`${source.url}/address/${tx.to}`} target="_blank" rel="noreferrer">
              <code>{tx.to}</code>
            </a>
          ) : (
            <code>{tx.to}</code>
          )}
          <span className="hint">
            {' '}
            — the router {quote.route.name} named{source ? `. Worth a look on ${source.name}.` : '.'}
          </span>
        </dd>

        <dt>Value</dt>
        <dd>
          {formatUnits(tx.value, 18)}
          {tx.value === 0n && (
            <span className="hint"> — none: the tokens move by ERC-20 transfer, not with the call.</span>
          )}
        </dd>

        <dt>Function</dt>
        <dd>
          <code>{tx.selector}</code>
          <span className="hint"> — the selector. There is no ABI for this router here, so it is not decoded.</span>
        </dd>

        <dt>Calldata</dt>
        <dd>{tx.dataBytes} bytes</dd>

        <dt>Bridge pays</dt>
        <dd>
          {destination ? (
            <a href={`${destination.url}/address/${quote.destination.receiver}`} target="_blank" rel="noreferrer">
              <code>{quote.destination.receiver}</code>
            </a>
          ) : (
            <code>{quote.destination.receiver}</code>
          )}
          <span className="hint">
            {receiverIsDrop
              ? ' — the drop address itself. Nothing else is in the path.'
              : ' — a shared receiver, not the drop. It forwards on arrival, and holds the tokens until it does.'}
          </span>
        </dd>

        <dt>Money ends up</dt>
        <dd>
          {destination ? (
            <a href={`${destination.url}/address/${quote.destination.predictedAddress}`} target="_blank" rel="noreferrer">
              <code>{quote.destination.predictedAddress}</code>
            </a>
          ) : (
            <code>{quote.destination.predictedAddress}</code>
          )}
        </dd>

        <dt>Quote expires</dt>
        <dd className={expired ? 'error' : undefined}>
          {expired
            ? 'expired — this transaction must be rebuilt before it can be sent'
            : new Date(quote.expiresAt * 1000).toLocaleTimeString()}
        </dd>
      </dl>

      {located.length > 0 && (
        <>
          <p className="hint">
            Where each checked value sits in the calldata below. These are the bytes, not a description
            of them — you can find them yourself in the raw data.
          </p>
          <dl className="args">
            {located.map((check) => (
              <div key={check.check}>
                <dt>byte {check.state === 'pass' ? check.where : ''}</dt>
                <dd>{check.detail}</dd>
              </div>
            ))}
          </dl>
        </>
      )}

      {quote.destination.payload !== '0x' && (
        <BridgeDeliveryPayload payload={quote.destination.payload} compiled={compiled} />
      )}

      <details className="subsection">
        <summary>
          Raw ({tx.dataBytes} bytes of calldata, {sizeInKb(quote.raw)} kB of provider JSON)
        </summary>
        <CopyBlock
          label="Transaction calldata"
          hint="Exactly the bytes your wallet will be handed. Nothing is added between this and the signature."
          command={tx.data}
        />
        <CopyBlock label="Quote response" command={stringify(quote.raw.quote)} />
        <CopyBlock label="Build response" command={stringify(quote.raw.build)} />
      </details>
    </>
  )
}

/** Wire JSON, so this cannot throw on a bigint the way a mapped quote would. */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch (cause) {
    return `could not be rendered: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

function sizeInKb(raw: unknown): string {
  return (stringify(raw).length / 1024).toFixed(1)
}

/** A chain this build has no explorer for should still render its addresses, just without links. */
function explorerFor(chainId: number): { name: string; url: string } | null {
  try {
    return blockExplorer(chainId)
  } catch {
    return null
  }
}
