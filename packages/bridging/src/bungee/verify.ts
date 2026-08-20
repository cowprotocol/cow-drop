import { checkDeliveryTarget, isSameAddress } from '@cowprotocol/cow-drop-sdk'
import { keccak256, type Address, type Hex } from 'viem'

import {
  byteLength,
  findAddress,
  findAmount,
  findBytes,
  isSameToken,
  type CheckOutcome,
  type CheckSeverity,
} from '../checks.js'
import type { BridgeQuoteRequest } from '../types.js'
import { destinationExecutionOf, type DestinationExecution } from './capability.js'
import type { BungeeBuildTxResponseWire, BungeeQuoteResponseWire, BungeeRouteWire } from './wire.js'

/**
 * Bungee's answers, checked against what we asked for.
 *
 * Two tiers, because the UI needs two different things at two different moments:
 *
 * - **Eligibility** — from the quote response alone, no transaction built. Cheap enough to run on
 *   every route so a list can show each one as allowed or disabled *with a reason*.
 * - **The transaction** — for the one route the user selected, on the bytes they are about to sign.
 *
 * The split is not only about cost. An ineligible route never reaches the second tier, so calldata for
 * a route we refused never exists in the process at all.
 *
 * For how a check earns `blocking` versus `advisory`, see the rule in `../checks.ts`. Each blocking
 * check below carries its own argument for why absence is unambiguous.
 */

function pass(check: CheckOutcome['check'], severity: CheckSeverity, detail: string, where?: number): CheckOutcome {
  return where === undefined
    ? { check, severity, state: 'pass', detail }
    : { check, severity, state: 'pass', detail, where }
}

function skip(check: CheckOutcome['check'], severity: CheckSeverity, detail: string): CheckOutcome {
  return { check, severity, state: 'not-applicable', detail }
}

function fail(
  severity: CheckSeverity,
  detail: string,
  problem: Extract<CheckOutcome, { state: 'fail' }>['problem'],
): CheckOutcome {
  return { check: problem.check, severity, state: 'fail', detail, problem }
}

/** Atomic delivery is signalled by a non-empty payload, and nothing else. */
function isAtomic(request: BridgeQuoteRequest): boolean {
  return request.destination.payload !== '0x'
}

// ---------------------------------------------------------------------------------------------
// Tier 1a — the response as a whole
// ---------------------------------------------------------------------------------------------

/**
 * The quote response against the request, ignoring individual routes.
 *
 * Every check here is an echo of a value we chose, so every one is blocking: a response that
 * disagrees with the request is not a response to our request, and nothing else in it — including the
 * calldata we would go on to sign — can be trusted afterwards.
 */
export function responseChecks(
  request: BridgeQuoteRequest,
  response: BungeeQuoteResponseWire['result'],
): CheckOutcome[] {
  const checks: CheckOutcome[] = []
  const wanted = request.destination.receiver

  // `result.receiverAddress` was modelled in the wire types and read by nothing. If Bungee ever
  // substituted middleware of its own, the tokens would go somewhere we did not choose, and the
  // payload's `predictedAddress` would be describing an address no longer in the path.
  checks.push(
    isSameAddress(response.receiverAddress, wanted)
      ? pass('receiver-echo', 'blocking', `the bridge will pay ${wanted}, which is the address we asked for`)
      : fail(
          'blocking',
          `we asked the bridge to pay ${wanted} and it answered with ${response.receiverAddress}`,
          {
            check: 'receiver-echo',
            requested: wanted,
            echoed: response.receiverAddress as Address,
          },
        ),
  )

  checks.push(
    isSameAddress(response.userAddress, request.sender)
      ? pass('user-echo', 'blocking', `quoted for ${request.sender}, the account that will send it`)
      : fail('blocking', `this quote is for ${response.userAddress}, not for ${request.sender}`, {
          check: 'user-echo',
          requested: request.sender,
          echoed: response.userAddress as Address,
        }),
  )

  checks.push(
    isSameToken(response.input.token.address as Address, request.sellToken)
      ? pass('input-token', 'blocking', `sending ${request.sellToken}, the token we asked to send`)
      : fail(
          'blocking',
          `we asked to send ${request.sellToken} and the quote is for ${response.input.token.address}`,
          {
            check: 'input-token',
            requested: request.sellToken,
            quoted: response.input.token.address as Address,
          },
        ),
  )

  // A verbatim echo of the decimal string we sent, not a figure Bungee derives — so there is no
  // legitimate encoding in which it differs. Deliberately asymmetric with the calldata amount check,
  // which is advisory precisely because that one *is* an encoding.
  const quotedIn = BigInt(response.input.amount)
  checks.push(
    quotedIn === request.sellAmount
      ? pass('input-amount', 'blocking', `for ${request.sellAmount} atoms, the amount we asked for`)
      : fail('blocking', `we asked to bridge ${request.sellAmount} atoms and the quote is for ${quotedIn}`, {
          check: 'input-amount',
          requested: request.sellAmount,
          quoted: quotedIn,
        }),
  )

  checks.push(
    response.destinationChainId === request.buyChainId
      ? pass('output-chain', 'blocking', `delivering on chain ${request.buyChainId}, where the drop lives`)
      : fail(
          'blocking',
          `the drop is on chain ${request.buyChainId} and this quote delivers on chain ${response.destinationChainId}`,
          { check: 'output-chain', requested: request.buyChainId, quoted: response.destinationChainId },
        ),
  )

  return checks
}

// ---------------------------------------------------------------------------------------------
// Tier 1b — one route
// ---------------------------------------------------------------------------------------------

export interface RouteCheckOptions {
  /** Unix seconds. Injected so expiry is deterministic in tests. */
  now: number
  /** Registry overrides. Tests only — see `capability.ts`. */
  capabilityOverrides?: Readonly<Record<string, DestinationExecution>>
}

/** Human wording for a capability verdict, used both to disable a row and to explain the mode. */
export function describeExecution(bridge: string, execution: DestinationExecution): string {
  if (execution.status === 'observed') {
    return `${bridge} has been watched running a destination payload (${execution.evidence.txHash})`
  }
  if (execution.status === 'broken') {
    return `${bridge} cannot run our destination payload: ${execution.reason}`
  }
  return `${bridge} has not been watched running a destination payload: ${execution.reason}`
}

export function routeChecks(
  request: BridgeQuoteRequest,
  route: BungeeRouteWire,
  options: RouteCheckOptions,
): CheckOutcome[] {
  const checks: CheckOutcome[] = []
  const bridge = route.routeDetails.name

  // The incident, encoded. Fails on `unobserved` as readily as on `broken`, because the check
  // requires a *positive* record: absence is unambiguous by construction, so this can only ever
  // refuse a route we cannot vouch for. False negatives — a bridge that works and has not been
  // watched — are certain and accepted. The remedy is an on-chain observation, never a softer check.
  if (isAtomic(request)) {
    const execution = destinationExecutionOf(bridge, options.capabilityOverrides)
    checks.push(
      execution.status === 'observed'
        ? pass('destination-execution', 'blocking', describeExecution(bridge, execution))
        : fail('blocking', describeExecution(bridge, execution), {
            check: 'destination-execution',
            bridge,
            execution,
          }),
    )
  } else {
    // Direct delivery asks the bridge for a plain transfer, so there is nothing to execute and the
    // capability question does not arise. Applying it here would refuse routes that work perfectly.
    checks.push(
      skip(
        'destination-execution',
        'blocking',
        'nothing runs on arrival in this mode, so it does not matter whether this bridge could run it',
      ),
    )
  }

  // The drop address commits to selling exactly this token. A different one delivered means the
  // recipe has nothing to sell and the funds wait at the drop for the owner's rescue.
  const quotedOut = route.output.token.address as Address
  checks.push(
    isSameToken(quotedOut, request.buyToken)
      ? pass('output-token', 'blocking', `delivers ${request.buyToken}, the token this recipe sells`)
      : fail(
          'blocking',
          `this recipe sells ${request.buyToken} and this route delivers ${quotedOut}, which it cannot spend`,
          { check: 'output-token', requested: request.buyToken, quoted: quotedOut },
        ),
  )

  checks.push(
    route.output.token.chainId === request.buyChainId
      ? pass('output-chain', 'blocking', `delivers on chain ${request.buyChainId}`)
      : fail(
          'blocking',
          `delivers on chain ${route.output.token.chainId}, and the drop is on chain ${request.buyChainId}`,
          { check: 'output-chain', requested: request.buyChainId, quoted: route.output.token.chainId },
        ),
  )

  // Advisory, and this is the one classification worth arguing about. The comparison is against a
  // *local* clock: a user whose machine is five minutes fast would see every route refused, an outage
  // of our own making. The authoritative enforcement already exists upstream — `/build-tx` on an
  // expired quoteId answers `success: false` — so this check's job is to turn an opaque build failure
  // into "three minutes stale, re-quote", not to gate. Send-time expiry is enforced separately, at
  // the wallet boundary, where the remedy is a rebuild rather than a refusal.
  const secondsLeft = route.quoteExpiry - options.now
  checks.push(
    secondsLeft > 0
      ? pass('route-expiry', 'advisory', `quoted price holds for another ${Math.round(secondsLeft)}s`)
      : fail(
          'advisory',
          `this route's quote expired ${Math.abs(Math.round(secondsLeft))}s ago and needs re-quoting`,
          { check: 'route-expiry', expiresAt: route.quoteExpiry, now: options.now },
        ),
  )

  return checks
}

// ---------------------------------------------------------------------------------------------
// Tier 2 — the built transaction
// ---------------------------------------------------------------------------------------------

/**
 * The transaction Bungee built, against the request it was built for.
 *
 * The two structural checks here — is the recipient in these bytes, is the payload in these bytes —
 * are not assumptions about Bungee's encoding. They are observations of it: a real source transaction
 * carries the recipient's 20 bytes verbatim, in packed (non-ABI) calldata where a value may straddle a
 * 32-byte boundary. So a recipient is embedded literally, and a payload that was included would be
 * too — which is exactly how we know when one was not.
 */
export function transactionChecks(
  request: BridgeQuoteRequest,
  route: BungeeRouteWire,
  built: BungeeBuildTxResponseWire['result'],
  options: { now: number },
): CheckOutcome[] {
  const checks: CheckOutcome[] = []
  const data = built.txData.data as Hex
  const dataBytes = byteLength(data)
  const { receiver, payload, predictedAddress } = request.destination

  checks.push(
    built.txData.chainId === request.sellChainId
      ? pass('tx-chain', 'blocking', `sent on chain ${request.sellChainId}, the chain you chose`)
      : fail(
          'blocking',
          `this transaction is for chain ${built.txData.chainId} and you are bridging from chain ${request.sellChainId}`,
          { check: 'tx-chain', requested: request.sellChainId, built: built.txData.chainId },
        ),
  )

  // Is the address that receives the money actually in the bytes being signed?
  const receiverAt = findAddress(data, receiver)
  const toIsReceiver = isSameAddress(built.txData.to, receiver)
  checks.push(
    receiverAt
      ? pass(
          'receiver-in-calldata',
          'blocking',
          `${receiver} appears in the calldata at byte ${receiverAt.offset} — the bridge is aimed at it`,
          receiverAt.offset,
        )
      : toIsReceiver
        ? pass('receiver-in-calldata', 'blocking', `the transaction is sent directly to ${receiver}`)
        : fail(
            'blocking',
            `${receiver} does not appear anywhere in these ${dataBytes} bytes, so nothing here says the ` +
              `money is aimed at it`,
            { check: 'receiver-in-calldata', receiver, calldataBytes: dataBytes },
          ),
  )

  if (payload === '0x') {
    checks.push(
      skip('payload-in-calldata', 'blocking', 'no payload in this mode — the bridge is asked for a plain transfer'),
    )
    checks.push(skip('calldata-length', 'advisory', 'no payload to account for'))
  } else {
    // The check that catches the second half of the incident: Bungee accepted `destinationPayload` at
    // quote time and built a transaction with no field for one. Passing on either the payload verbatim
    // or its hash closes the one legitimate encoding anybody could name (commit-by-hash), which
    // removes the only false-negative story available for a blocking check.
    const verbatim = findBytes(data, payload)
    const hashed = findBytes(data, keccak256(payload))
    const payloadBytes = byteLength(payload)

    checks.push(
      verbatim
        ? pass(
            'payload-in-calldata',
            'blocking',
            `the ${payloadBytes}-byte recipe payload appears in the calldata at byte ${verbatim.offset}. ` +
              `That proves it was included — not that the bridge will run it.`,
            verbatim.offset,
          )
        : hashed
          ? pass(
              'payload-in-calldata',
              'blocking',
              `the payload appears as its hash at byte ${hashed.offset}. That proves it was committed to — ` +
                `not that the bridge will run it.`,
              hashed.offset,
            )
          : fail(
              'blocking',
              `the ${payloadBytes}-byte recipe payload is nowhere in these ${dataBytes} bytes. The bridge ` +
                `accepted it in the quote and did not carry it, so nothing would activate the drop on arrival.`,
              { check: 'payload-in-calldata', payloadBytes, calldataBytes: dataBytes },
            ),
    )

    // A second, differently-shaped witness, and the one that reads best to a human: "the transaction
    // is 168 bytes; the payload alone is 292". Advisory because the arithmetic assumes a word-packed
    // layout, and the incident's own calldata shows the encoding is packed with addresses crossing
    // word boundaries — so this is the assumption most likely to age badly.
    const leastPossible = 4 + 32 * 5 + payloadBytes
    checks.push(
      dataBytes >= leastPossible
        ? pass('calldata-length', 'advisory', `${dataBytes} bytes, enough to hold a ${payloadBytes}-byte payload`)
        : fail(
            'advisory',
            `${dataBytes} bytes is too small to carry a ${payloadBytes}-byte payload plus a route's own arguments`,
            { check: 'calldata-length', calldataBytes: dataBytes, leastPossible },
          ),
    )
  }

  // Advisory. Amounts are legitimately encoded many ways — packed as a narrower uint to save
  // calldata, expressed net of a relayer fee, split across parts, or not present at all because the
  // router reads `msg.value` or the allowance. The consequence of being wrong is also bounded in a way
  // the others are not: a different quantity to the *right* place, with the wallet showing the user
  // the value and the allowance being spent.
  const amountAt = findAmount(data, request.sellAmount)
  const valueMatches = BigInt(built.txData.value) === request.sellAmount
  checks.push(
    amountAt
      ? pass(
          'sell-amount-in-calldata',
          'advisory',
          `${request.sellAmount} atoms appears in the calldata at byte ${amountAt.offset} (${amountAt.form} form)`,
          amountAt.offset,
        )
      : valueMatches
        ? pass('sell-amount-in-calldata', 'advisory', `${request.sellAmount} is sent as the transaction's value`)
        : fail(
            'advisory',
            `${request.sellAmount} atoms does not appear in the calldata in any form we recognise. Routers ` +
              `encode amounts in several ways, so this is not necessarily wrong — check the amount in your wallet.`,
            { check: 'sell-amount-in-calldata', amount: request.sellAmount },
          ),
  )

  checks.push(...approvalChecks(request, route, built))

  // Direct mode's whole claim is that the money goes to an address belonging to one recipe. These two
  // come from the same caller-supplied object, so a disagreement can only mean a hand-built target or
  // crossed modes — and in direct mode a receiver that is not the drop is exactly the shared-receiver
  // exposure the mode exists to avoid.
  if (payload === '0x') {
    checks.push(
      isSameAddress(receiver, predictedAddress)
        ? pass('direct-receiver', 'blocking', `the bridge pays the drop itself, with no contract in between`)
        : fail(
            'blocking',
            `this is supposed to pay the drop directly, but it pays ${receiver} while naming ${predictedAddress} ` +
              `as the destination`,
            { check: 'direct-receiver', receiver, predicted: predictedAddress },
          ),
    )
  } else {
    checks.push(
      skip('direct-receiver', 'blocking', 'the receiver is a contract by design in this mode, not the drop'),
    )
  }

  checks.push(deliveryTargetCheck(request))
  void options
  return checks
}

/**
 * Does the destination really belong to the recipe being funded?
 *
 * Delegated to the SDK, which is the only layer that can re-derive a drop address — and the only check
 * that catches a payload naming somebody else's drop while every field a user can see still agrees.
 */
function deliveryTargetCheck(request: BridgeQuoteRequest): CheckOutcome {
  const expected = request.expectedRecipe
  if (!expected) {
    return skip(
      'delivery-target',
      'blocking',
      'no compiled recipe was supplied, so the destination could not be re-derived — the strongest ' +
        'available check did not run',
    )
  }

  const problem = checkDeliveryTarget(request.destination, expected)

  if (!problem) {
    return pass(
      'delivery-target',
      'blocking',
      `the destination re-derives to ${expected.address}, the drop this recipe compiles to`,
    )
  }

  const reason =
    problem.error === 'payload-names-another-drop'
      ? `the payload names drop ${problem.inPayload}, not ${problem.drop} — the money would activate ` +
        `somebody else's recipe`
      : problem.error === 'receiver-not-the-drop'
        ? `the bridge would pay ${problem.receiver}, which is not the drop ${problem.drop}`
        : problem.error === 'receiver-not-this-generation'
          ? `the receiver ${problem.receiver} does not belong to generation ${problem.generation}`
          : problem.error === 'predicted-not-the-drop'
            ? `the destination names ${problem.predicted}, and this recipe compiles to ${problem.drop}`
            : `the payload could not be decoded: ${problem.message}`

  return fail('blocking', reason, { check: 'delivery-target', reason })
}

/**
 * The approval half.
 *
 * Framing matters here. An `approve` cannot move funds by itself, so the blocking checks are not
 * "this loses money" — they are "the response does not correspond to our request", which invalidates
 * the calldata beside it. The amount, by contrast, is advisory in both directions: over-approval to
 * `MaxUint256` is a legitimate-if-undesirable habit of aggregators, and refusing it would make those
 * routes unusable while the user still confirms the approval in their own wallet with its own display.
 */
function approvalChecks(
  request: BridgeQuoteRequest,
  route: BungeeRouteWire,
  built: BungeeBuildTxResponseWire['result'],
): CheckOutcome[] {
  const approval = built.approvalData
  if (!approval) {
    const detail = 'no approval needed — this route moves the chain’s native token'
    return [
      skip('approval-token', 'blocking', detail),
      skip('approval-user', 'blocking', detail),
      skip('approval-amount', 'advisory', detail),
      skip('route-identity', 'blocking', 'a native route has no spender to identify the bridge by'),
    ]
  }

  const checks: CheckOutcome[] = []
  const token = approval.tokenAddress as Address
  const user = approval.userAddress as Address
  const amount = BigInt(approval.amount)

  checks.push(
    isSameToken(token, request.sellToken)
      ? pass('approval-token', 'blocking', `approves ${request.sellToken}, the token being bridged`)
      : fail('blocking', `asks to approve ${token}, and you are bridging ${request.sellToken}`, {
          check: 'approval-token',
          expected: request.sellToken,
          actual: token,
        }),
  )

  checks.push(
    isSameAddress(user, request.sender)
      ? pass('approval-user', 'blocking', `the approval is yours to give (${request.sender})`)
      : fail('blocking', `this approval is for ${user}, not for ${request.sender}`, {
          check: 'approval-user',
          expected: request.sender,
          actual: user,
        }),
  )

  checks.push(
    amount === request.sellAmount
      ? pass('approval-amount', 'advisory', `approves exactly the ${request.sellAmount} atoms being bridged`)
      : fail(
          'advisory',
          amount > request.sellAmount
            ? `asks to approve ${amount} atoms to ${approval.spenderAddress}, more than the ` +
              `${request.sellAmount} being bridged`
            : `asks to approve only ${amount} atoms, less than the ${request.sellAmount} being bridged — the ` +
              `transaction may fail unless a fee is taken first`,
          { check: 'approval-amount', expected: request.sellAmount, actual: amount },
        ),
  )

  // "Is the transaction we got built for the route we chose?" `/build-tx` returns no route name, so
  // the spender is the only identity available on both sides. A different router means a different
  // bridge, which means the capability verdict we granted was about something else.
  const quotedSpender = route.approvalData?.spenderAddress as Address | undefined
  const builtSpender = approval.spenderAddress as Address
  checks.push(
    !quotedSpender
      ? skip(
          'route-identity',
          'blocking',
          'the quoted route named no spender, so the built transaction could not be tied back to it',
        )
      : isSameAddress(quotedSpender, builtSpender)
        ? pass('route-identity', 'blocking', `built for ${route.routeDetails.name}, the route you selected`)
        : fail(
            'blocking',
            `the route you selected uses ${quotedSpender} and this transaction was built for ${builtSpender} — ` +
              `it is not the same bridge`,
            { check: 'route-identity', quotedSpender, builtSpender },
          ),
  )

  return checks
}
