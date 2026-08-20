import type { Hex } from 'viem'

import type { BridgeName } from './wire.js'

/**
 * Which bridges have been watched running our destination payload, and which have been watched
 * failing to.
 *
 * This file replaces a `const` array of three bridge names that was never checked against anything.
 * Two of the three had never been observed at all, and the third — `gnosis-native-bridge` — cannot
 * execute our payload by ABI and was simultaneously the *only* route that array left for
 * Ethereum→Gnosis. So the one pair the allowlist claimed to protect was the one it broke, silently,
 * for as long as it existed, and a delivery was stranded in the shared receiver as a result.
 *
 * The lesson is not "that list had a bug". It is that a bridge's behaviour is an *observation*, and a
 * bare list of names cannot hold an observation — there is nowhere to put the transaction that proves
 * it. So the data structure now demands the proof.
 */

/**
 * A destination call, watched happening (or watched not happening) on a real chain.
 *
 * The point of this type is which fields are required. An `observed` verdict cannot be constructed
 * without a transaction hash, so nobody can promote a bridge on a hunch — the old allowlist was
 * exactly that hunch, written as a `const`.
 */
export interface DestinationExecutionEvidence {
  /** The chain the destination call ran on. */
  chainId: number
  /** The destination transaction. This field *is* the evidence; the rest is annotation. */
  txHash: Hex
  /** A link a human can open. Stored rather than derived, because explorers differ per chain. */
  url: string
  /** ISO date, required so that a five-year-old observation is visibly five years old. */
  observedOn: string
  note?: string
}

/**
 * Whether a bridge runs the destination payload we hand it.
 *
 * The discriminant is `observed`, not `verified`, and the word is chosen deliberately. "Verified"
 * gets read as "safe" in a code review six months later, and it never means that: evidence proves a
 * bridge *can* execute a payload, never that this particular fill *will*. A revert or an
 * out-of-gas still strands the tokens at the shared receiver, and no quote-time check can see either
 * coming. Only a per-drop receiver removes that loss — see `docs/BRIDGING.md`.
 *
 * So: `observed` means "watched working at least once". Nothing stronger is claimable.
 */
export type DestinationExecution =
  | { status: 'observed'; evidence: DestinationExecutionEvidence }
  /**
   * The default for every name not in the registry, and for every name the registry cannot resolve.
   * Blocks atomic delivery, deliberately — absence of evidence is the whole reason this type exists,
   * and guessing here is the failure mode that strands a delivery in a contract anyone may sweep.
   */
  | { status: 'unobserved'; reason: string }
  | { status: 'broken'; reason: string; evidence?: DestinationExecutionEvidence }

/** What a provider can be trusted to run at the destination, for a "why is this off?" panel. */
export interface DeliveryCapability {
  /** Names watched working. Empty is the current, correct truth. */
  observed: readonly BridgeName[]
  /** Every entry, verdict included, in registry order. */
  known: readonly { name: BridgeName; execution: DestinationExecution }[]
  /** True iff `observed` is non-empty. While false, atomic delivery must not be offered at all. */
  atomicAvailable: boolean
}

function observed(evidence: DestinationExecutionEvidence): DestinationExecution {
  return { status: 'observed', evidence }
}

function unobserved(reason: string): DestinationExecution {
  return { status: 'unobserved', reason }
}

function broken(reason: string, evidence?: DestinationExecutionEvidence): DestinationExecution {
  return { status: 'broken', reason, evidence }
}

/**
 * What is known, bridge by bridge.
 *
 * Keyed on Bungee's `includeBridges` slug. A name absent from here resolves to `unobserved`, so
 * adding an entry is only ever about recording something learned — never about permitting something.
 *
 * Promoting a bridge is one line: `across: observed({ chainId, txHash, url, observedOn })`. There is
 * no other way to make atomic delivery available, and that is the point.
 */
const REGISTRY: Readonly<Record<BridgeName, DestinationExecution>> = {
  /**
   * Not a bridge that failed to run our payload — a bridge that *cannot*, by ABI.
   *
   * `gnosis-native-bridge` is the Gnosis AMB omnibridge. Its destination-call path is
   * `relayTokensAndCall` on the foreign side, which calls `onTokenBridged(address,uint256,bytes)` on
   * the recipient. `DropBungeeReceiver` exposes `executeData(bytes32,uint256[],address[],bytes)`.
   * Those two selectors can never meet, so no amount of prepaid destination gas would have helped.
   *
   * There was no quote-time signal for this and there never will be: Bungee echoes
   * `destinationPayload` back verbatim whatever the destination ABI is. Worse, the fill we observed
   * carried no payload at all — the source transaction Bungee built for this route has no field for
   * one.
   */
  'gnosis-native-bridge': broken(
    'the Gnosis AMB omnibridge calls onTokenBridged(address,uint256,bytes) on the recipient, which ' +
      'can never reach the receiver’s executeData(bytes32,uint256[],address[],bytes) — the tokens ' +
      'arrive and nothing of ours runs',
  ),

  /**
   * Quotes a destination payload happily and then delivers a plain transfer. This is the failure the
   * old allowlist was built to stop, and the only one it actually stopped.
   */
  symbiosis: broken(
    'quotes a destination payload and then delivers a plain transfer — the tokens land at the ' +
      'shared receiver, executeData is never called, and anyone may sweep them',
  ),

  /**
   * In the pre-2026-08 allowlist on faith, never once observed. Listed rather than omitted because an
   * absent name and a name we know nothing about are different states of knowledge, and the second
   * one is worth recording: somebody already considered these and did not check.
   */
  across: unobserved('was in the old allowlist on faith; its destination execution has never been watched'),
  cctp: unobserved('was in the old allowlist on faith; its destination execution has never been watched'),
}

/**
 * Bungee's display spelling versus its `includeBridges` slug.
 *
 * `routeDetails.name` comes back title-cased ("Across", "CCTP") while the filter takes slugs
 * ("across", "cctp"). The old code never compared a response name to the allowlist at all, so this
 * mismatch was invisible; the moment a verdict depends on the name it becomes a correctness gap. An
 * unresolvable name falls through to `unobserved`, which blocks atomic — fail-closed — and the reason
 * string names the spelling so an operator can add the alias.
 */
const ALIASES: Readonly<Record<string, BridgeName>> = {
  'gnosis native bridge': 'gnosis-native-bridge',
  'gnosis bridge': 'gnosis-native-bridge',
  'circle cctp': 'cctp',
  'across v3': 'across',
}

/** Fold a provider's spelling towards a registry key: trim, lowercase, and treat `-`/`_` as spaces. */
function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
}

/** Key a registry the way names are compared, so a lookup compares like with like. */
function byNormalisedName(
  overrides?: Readonly<Record<string, DestinationExecution>>,
): Record<string, DestinationExecution> {
  return Object.fromEntries(
    Object.entries({ ...REGISTRY, ...overrides }).map(([name, execution]) => [normalise(name), execution]),
  )
}

/**
 * What is known about this bridge, by whatever name the provider called it.
 *
 * Never throws and never returns `observed` for a name it does not recognise. That asymmetry is the
 * whole safety property: an unknown bridge is refused, not permitted.
 *
 * `overrides` has to be threaded all the way to here rather than only into `deliveryCapability()`.
 * They are the same table read two ways — "what may atomic use" and "what is this route" — and if
 * only the first honoured an override, a bridge could be advertised as available and then refused at
 * the point of use.
 */
export function destinationExecutionOf(
  name: string,
  overrides?: Readonly<Record<string, DestinationExecution>>,
): DestinationExecution {
  const registry = byNormalisedName(overrides)
  const key = normalise(name)

  const direct = registry[key]
  if (direct) return direct

  const aliased = ALIASES[key]
  if (aliased) {
    const execution = registry[normalise(aliased)]
    if (execution) return execution
  }

  // Phrased to read as the tail of `describeExecution`'s sentence, which supplies the subject. A reason
  // that repeats it comes out as two overlapping sentences in the one place a person is reading closely.
  return unobserved(`“${name}” is not in the destination-execution registry at all, and unknown is refused`)
}

/** Every bridge watched running a payload. Empty today, and that is the honest state. */
export function observedBridges(
  overrides?: Readonly<Record<string, DestinationExecution>>,
): readonly BridgeName[] {
  const merged: Record<string, DestinationExecution> = { ...REGISTRY, ...overrides }

  return Object.entries(merged)
    .filter(([, execution]) => execution.status === 'observed')
    .map(([name]) => name)
}

/**
 * The whole picture, for a UI that has to explain a list where every row is disabled.
 *
 * `overrides` exists so a test can exercise the observed path at all — with an empty `observed` set
 * there is otherwise no way to reach the code that runs when atomic is available. Application code
 * must never pass it: an `observed` entry with no evidence is precisely the belief this module
 * exists to delete.
 */
export function deliveryCapability(
  overrides?: Readonly<Record<string, DestinationExecution>>,
): DeliveryCapability {
  const merged: Record<string, DestinationExecution> = { ...REGISTRY, ...overrides }
  const known = Object.entries(merged).map(([name, execution]) => ({ name, execution }))
  const observedNames = observedBridges(overrides)

  return { observed: observedNames, known, atomicAvailable: observedNames.length > 0 }
}
