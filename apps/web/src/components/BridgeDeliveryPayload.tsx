import { decodeDeliveryPayload, type CompiledRecipe } from '@cowprotocol/cow-drop-sdk'
import type { Hex } from 'viem'

import { StepTable } from './StepTable.js'

/**
 * What the bridge would run when the money lands.
 *
 * Only reachable in atomic mode, where the payload *is* the instruction — so it is the one thing on the
 * review screen that a person cannot check by looking at an address. Decoding it and rendering the
 * recipe through the same `StepTable` the builder uses means "what you are funding" and "what will run"
 * are shown by the same code, and a difference between them has nowhere to hide.
 *
 * The comparison against the compiled recipe is the assertion that matters: the payload's bytes are
 * what the receiver acts on, so bytes that are not this recipe's would activate a different one.
 */
export function BridgeDeliveryPayload({
  payload,
  compiled,
}: {
  payload: Hex
  compiled: CompiledRecipe
}) {
  const decoded = decode(payload)
  const bytes = (payload.length - 2) / 2

  return (
    <details className="subsection" open>
      <summary>What runs when the money lands ({bytes} bytes of payload)</summary>

      {!decoded ? (
        <p className="error">
          This payload could not be decoded, so there is no saying what it would do on arrival. Nothing
          should be sent against it.
        </p>
      ) : (
        <>
          <dl className="facts">
            <dt>Owner</dt>
            <dd>
              <code>{decoded.owner}</code>
            </dd>
            <dt>If the recipe declines</dt>
            <dd>
              {decoded.onFailure === 'refund-owner'
                ? 'sent back to the owner'
                : 'left at the drop, for a keeper to retry'}
            </dd>
            <dt>Recipe</dt>
            <dd>
              {(decoded.setupData.length - 2) / 2} bytes
              {decoded.setupData.toLowerCase() === compiled.setupData.toLowerCase() ? (
                <span className="hint"> — byte for byte the recipe this drop address commits to.</span>
              ) : (
                <span className="error">
                  {' '}
                  — NOT the recipe this drop address commits to. This would activate something else.
                </span>
              )}
            </dd>
          </dl>
          <StepTable setupData={decoded.setupData} deployment={compiled.deployment} />
        </>
      )}
    </details>
  )
}

function decode(payload: Hex) {
  try {
    return decodeDeliveryPayload(payload)
  } catch {
    return null
  }
}
