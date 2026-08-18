import { encodeFunctionData, type Address, type Hex } from 'viem'

import { saltOf } from './encoding.js'
import { COW_SHED_EXECUTOR_FACTORY_ABI } from './generated/artifacts.js'
import { steps } from './steps.js'

/**
 * Hand-written rather than generated: composable-cow is not a submodule of this repo, so there is no
 * artifact to generate from. One function, and its signature is asserted against the deployed contract
 * by the fork tests that register orders through it.
 */
const COMPOSABLE_COW_REVOKE_ABI = [
  { type: 'function', name: 'remove', stateMutability: 'nonpayable', inputs: [{ name: 'singleOrderHash', type: 'bytes32' }], outputs: [] },
] as const

const SETTLEMENT_PRESIGN_ABI = [
  {
    type: 'function',
    name: 'setPreSignature',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'orderUid', type: 'bytes' }, { name: 'signed', type: 'bool' }],
    outputs: [],
  },
] as const
import type { DropCall, DropDeployment } from './types.js'
import type { EvmCall } from './tx.js'

/**
 * Rescue: getting funds back out of a drop whose recipe cannot or should not run.
 *
 * A drop is funded before it exists, so there is a real failure mode: money arrives late, or a
 * condition the recipe depends on stops holding, and the committed recipe can never succeed. Since
 * `initializeProxyWithSetup` is the only entrypoint that can deploy at a setup-committed address and
 * it always runs the setup, that would otherwise strand the funds at an address that can never
 * exist.
 *
 * The first defence is recipe design — a `requireTimeWindow` with a `notAfter`, or a deadline branch
 * that lets the setup succeed trivially once the opportunity has passed. The rescue paths here are
 * for when that was not modelled, or was modelled wrongly.
 *
 * Which path applies depends only on whether the drop is deployed yet:
 *
 * | drop | path | mechanism |
 * |---|---|---|
 * | not deployed | {@link buildRescueTx} | `initializeProxyWithoutSetup` (cow-shed#78), owner-only |
 * | deployed | {@link buildOwnerSweepTx} | `trustedExecuteHooks`, owner is the shed's admin |
 *
 * Both are owner-only, and neither needs a signature — the owner is the caller in both cases.
 */

/** Sweep the drop's whole balance of each token to `to`. The zero address means native. */
export function buildSweepCalls(params: {
  deployment: Pick<DropDeployment, 'tokenSteps'>
  to: Address
  /** Tokens to sweep. Include the zero address to also sweep the native balance. */
  tokens: Address[]
}): DropCall[] {
  if (params.tokens.length === 0) {
    throw new Error('nothing to sweep: pass at least one token (zero address for native)')
  }
  return params.tokens.map((token) => steps.sweep(params.deployment, { token, to: params.to }))
}

/**
 * Retire orders the drop has already placed.
 *
 * **A sweep on its own does not end a drop's trading.** Both order paths outlive it: a registered
 * conditional order stays authorised in ComposableCoW until removed, and a pre-signature stays valid
 * until its `validTo`. So an owner who sweeps a drop mid-TWAP, or with days left on a stop-loss, still
 * has an address that will trade whatever arrives there next — and the relayer's allowance is still
 * standing. That is not what "rescued" should mean.
 *
 * Neither call needs a step contract: both take literals, and by rescue time those literals are known
 * — the params hash and the order UID are both in the activation receipt. See
 * `parseConditionalOrdersCreated` and `parseDropOrderPlaced`.
 *
 * These are plain calls, not delegatecalls: `msg.sender` has to be the drop, and the shed calling out
 * directly is already that.
 */
export function buildRevokeCalls(params: {
  deployment: Pick<DropDeployment, 'composableCow' | 'settlement'>
  /** ComposableCoW params hashes to de-authorise, from `parseConditionalOrdersCreated`. */
  conditionalOrderHashes?: Hex[]
  /** Pre-signed order UIDs to un-sign, from `parseDropOrderPlaced`. */
  orderUids?: Hex[]
}): DropCall[] {
  const calls: DropCall[] = []

  for (const hash of params.conditionalOrderHashes ?? []) {
    calls.push({
      target: params.deployment.composableCow,
      value: 0n,
      callData: encodeFunctionData({ abi: COMPOSABLE_COW_REVOKE_ABI, functionName: 'remove', args: [hash] }),
      allowFailure: false,
      isDelegateCall: false,
    })
  }

  for (const uid of params.orderUids ?? []) {
    calls.push({
      target: params.deployment.settlement,
      value: 0n,
      callData: encodeFunctionData({
        abi: SETTLEMENT_PRESIGN_ABI,
        functionName: 'setPreSignature',
        args: [uid, false],
      }),
      allowFailure: false,
      isDelegateCall: false,
    })
  }

  return calls
}

/**
 * Deploy a drop at its committed address *without* running its recipe, and run `calls` as the shed
 * in the same transaction.
 *
 * Owner-only, which is what keeps ordinary drops safe to fund: if anyone could deploy at a
 * setup-committed address without running the setup, the address would stop being a promise about
 * what happens to the money. It grants the owner nothing new either — they are the shed's admin
 * already.
 *
 * The calls run in the same transaction on purpose. The committed trusted executor cannot be swapped
 * out for the rescue and is trusted the moment the shed exists, so sweeping in a second transaction
 * would leave it a window to act first.
 *
 * Pass an empty `calls` array to simply deploy the shed and then operate it normally — see
 * {@link buildDeployOnlyTx}.
 */
export function buildRescueTx(params: {
  deployment: Pick<DropDeployment, 'factory' | 'executor'>
  owner: Address
  setupData: Hex
  calls: DropCall[]
}): EvmCall {
  return {
    to: params.deployment.factory,
    data: encodeFunctionData({
      abi: COW_SHED_EXECUTOR_FACTORY_ABI,
      functionName: 'initializeProxyWithoutSetup',
      args: [
        params.owner,
        params.deployment.executor,
        saltOf(params.setupData),
        params.deployment.executor,
        params.setupData,
        params.calls.map((call) => ({
          target: call.target,
          value: call.value,
          callData: call.callData,
          allowFailure: call.allowFailure,
          isDelegateCall: call.isDelegateCall,
        })),
      ],
    }),
    value: 0n,
  }
}

/**
 * Deploy the drop, skip its recipe, and do nothing else — leaving an ordinary cow-shed the owner can
 * drive however they like afterwards.
 *
 * The same call as {@link buildRescueTx} with no rescue calls, and worth naming separately because
 * the intent is different: this is "give me the account, I'll take it from here" rather than "get my
 * money out now". With an empty call list the factory never takes the trusted role at all.
 */
export function buildDeployOnlyTx(params: {
  deployment: Pick<DropDeployment, 'factory' | 'executor'>
  owner: Address
  setupData: Hex
}): EvmCall {
  return buildRescueTx({ ...params, calls: [] })
}

/**
 * Run `calls` as an already-deployed drop, sent by the owner.
 *
 * No hatch and no signature needed here: `COWShed.trustedExecuteHooks` is `onlyTrustedRole`, which
 * means the admin *or* the trusted executor — and the owner is the admin. This is the path for funds
 * that arrive after the recipe has already run, or for a drop whose recipe is simply no longer what
 * you want.
 */
export function buildOwnerExecuteTx(params: { drop: Address; calls: DropCall[] }): EvmCall {
  return {
    to: params.drop,
    data: encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'trustedExecuteHooks',
          stateMutability: 'nonpayable',
          inputs: [
            {
              name: 'calls',
              type: 'tuple[]',
              components: [
                { name: 'target', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'callData', type: 'bytes' },
                { name: 'allowFailure', type: 'bool' },
                { name: 'isDelegateCall', type: 'bool' },
              ],
            },
          ],
          outputs: [],
        },
      ] as const,
      functionName: 'trustedExecuteHooks',
      args: [
        params.calls.map((call) => ({
          target: call.target,
          value: call.value,
          callData: call.callData,
          allowFailure: call.allowFailure,
          isDelegateCall: call.isDelegateCall,
        })),
      ],
    }),
    value: 0n,
  }
}

/** Sweep an already-deployed drop's balances to `to`, as the owner, retiring any live orders first. */
export function buildOwnerSweepTx(params: {
  deployment: Pick<DropDeployment, 'tokenSteps' | 'composableCow' | 'settlement'>
  drop: Address
  to: Address
  tokens: Address[]
  revoke?: RevokeTargets
}): EvmCall {
  return buildOwnerExecuteTx({
    drop: params.drop,
    calls: buildRescueCalls(params),
  })
}

/** What a rescue should retire, alongside the balances it moves. */
export interface RevokeTargets {
  conditionalOrderHashes?: Hex[]
  orderUids?: Hex[]
}

/**
 * Revocations first, then the sweep.
 *
 * Ordering is cosmetic — the whole thing is one transaction — but retiring the order before taking the
 * money is the order a person would describe, and it reads that way in a simulation trace.
 */
function buildRescueCalls(params: {
  deployment: Pick<DropDeployment, 'tokenSteps' | 'composableCow' | 'settlement'>
  to: Address
  tokens: Address[]
  revoke?: RevokeTargets
}): DropCall[] {
  return [
    ...buildRevokeCalls({ deployment: params.deployment, ...(params.revoke ?? {}) }),
    ...buildSweepCalls({ deployment: params.deployment, to: params.to, tokens: params.tokens }),
  ]
}

/**
 * The single entry point a UI wants: pick the right rescue path for a drop's current state.
 *
 * @param deployed Whether the drop already has code.
 */
export function buildRescueForState(params: {
  deployment: Pick<DropDeployment, 'factory' | 'executor' | 'tokenSteps' | 'composableCow' | 'settlement'>
  owner: Address
  setupData: Hex
  drop: Address
  to: Address
  tokens: Address[]
  deployed: boolean
  /**
   * Orders to retire as part of the rescue. Omitting this sweeps without ending the drop's trading,
   * which is only right when you know there is nothing outstanding.
   */
  revoke?: RevokeTargets
}): { tx: EvmCall; path: 'without-setup' | 'owner-execute' } {
  const calls = buildRescueCalls(params)

  return params.deployed
    ? { tx: buildOwnerExecuteTx({ drop: params.drop, calls }), path: 'owner-execute' }
    : {
        tx: buildRescueTx({
          deployment: params.deployment,
          owner: params.owner,
          setupData: params.setupData,
          calls,
        }),
        path: 'without-setup',
      }
}
