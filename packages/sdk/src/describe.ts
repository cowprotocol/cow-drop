import { decodeFunctionData, type Abi, type Address, type Hex } from 'viem'

import { decodeRecipe } from './encoding.js'
import {
  STOP_LOSS_STEPS_ABI,
  TWAP_STEPS_ABI,
  GUARD_STEPS_ABI,
  PRESIGN_STEPS_ABI,
  TOKEN_STEPS_ABI,
} from './generated/artifacts.js'
import type { DropDeployment } from './types.js'

/**
 * Which step contract hosts a step, by its Solidity name.
 *
 * The contract name rather than the `DropDeployment` field key, because this is what gets shown to a
 * person reading a recipe — "PresignSteps" is something they can go and look up on a block explorer,
 * where "presignSteps" is an internal detail of this package.
 */
export type StepContractName = 'GuardSteps' | 'TokenSteps' | 'PresignSteps' | 'TwapSteps' | 'StopLossSteps'

/** One decoded argument, with the name the contract gives it. */
export interface DescribedArg {
  name: string
  type: string
  value: unknown
}

export interface DescribedStep {
  /** 1-based, to match how steps are talked about ("put the guard first"). */
  index: number
  target: Address
  /** Null when the target is not one of this generation's step contracts. */
  known: {
    contract: StepContractName
    functionName: string
    args: readonly DescribedArg[]
  } | null
  value: bigint
  allowFailure: boolean
  isDelegateCall: boolean
  /** Kept so a UI can still show the bytes, decoded or not. */
  callData: Hex
  /** Things a person funding this address should be told. Empty is the ordinary case. */
  warnings: string[]
}

export interface DescribedRecipe {
  label: string
  salt: Hex
  once: boolean
  steps: DescribedStep[]
}

const STEP_ABIS: Readonly<Record<StepContractName, Abi>> = {
  GuardSteps: GUARD_STEPS_ABI as unknown as Abi,
  TokenSteps: TOKEN_STEPS_ABI as unknown as Abi,
  PresignSteps: PRESIGN_STEPS_ABI as unknown as Abi,
  TwapSteps: TWAP_STEPS_ABI as unknown as Abi,
  StopLossSteps: STOP_LOSS_STEPS_ABI as unknown as Abi,
}

/**
 * Name the decoded arguments.
 *
 * `decodeFunctionData` returns them positionally, so the names come from the ABI entry. Looked up by
 * function name rather than by selector because none of the step contracts overloads anything — if one
 * ever does, this picks the first match and the types would stop lining up, so don't.
 */
function nameArgs(abi: Abi, functionName: string, args: readonly unknown[]): DescribedArg[] {
  const entry = abi.find((item) => item.type === 'function' && item.name === functionName)
  const inputs = entry && 'inputs' in entry ? entry.inputs : []
  return args.map((value, index) => ({
    name: inputs[index]?.name || `arg${index}`,
    type: inputs[index]?.type ?? 'unknown',
    value,
  }))
}

/**
 * Turn committed bytes back into something a person can read.
 *
 * This is the counterpart to compiling a recipe, and it matters more than a convenience: activation is
 * permissionless and unsigned, so the *only* safeguard for someone about to send money to a drop is
 * re-deriving the address from a recipe they understand. Undecoded calldata reduces that to trusting a
 * hex blob, which is the same as no safeguard.
 *
 * So the interesting output here is `warnings`. A step this function cannot name is not an error — the
 * `raw` step type exists on purpose — but it is something the person funding the address has to be told,
 * rather than something to render as though it were understood.
 *
 * @param deployment The generation to resolve targets against. A step pointing at a *different*
 *                   generation's contracts decodes as unknown, which is correct: it is not a step of
 *                   this generation, and pretending otherwise would name it wrongly.
 */
export function describeRecipe(setupData: Hex, deployment: DropDeployment): DescribedRecipe {
  const recipe = decodeRecipe(setupData)

  const byAddress = new Map<string, StepContractName>([
    [deployment.guardSteps.toLowerCase(), 'GuardSteps'],
    [deployment.tokenSteps.toLowerCase(), 'TokenSteps'],
    [deployment.presignSteps.toLowerCase(), 'PresignSteps'],
    [deployment.twapSteps.toLowerCase(), 'TwapSteps'],
    [deployment.stopLossSteps.toLowerCase(), 'StopLossSteps'],
  ])

  /** Each call named where the SDK recognises it, and flagged where it does not. */
  const steps = recipe.calls.map((call, index): DescribedStep => {
    const contract = byAddress.get(call.target.toLowerCase())
    const warnings: string[] = []

    let known: DescribedStep['known'] = null
    if (contract) {
      const abi = STEP_ABIS[contract]
      try {
        const decoded = decodeFunctionData({ abi, data: call.callData })
        known = {
          contract,
          functionName: decoded.functionName,
          args: nameArgs(abi, decoded.functionName, (decoded.args ?? []) as readonly unknown[]),
        }
      } catch {
        // A known contract but an unrecognised selector — a recipe built against a newer SDK, most
        // likely. Naming the contract is still worth something, so say that much and no more.
        warnings.push(
          `calls ${contract} with a function this SDK does not recognise; it may have been built against a newer version`,
        )
      }
    } else {
      warnings.push('does not target a cow-drop step contract, so what it does cannot be shown here')
    }

    if (call.isDelegateCall && !contract) {
      // The sharp edge. A delegatecall runs the target's code as the drop, with full access to the
      // shed's storage — including the admin slot that the owner's rescue path depends on.
      warnings.push(
        'runs foreign code in the drop’s own context: it can move any balance and rewrite the ' +
          'shed’s storage, including the admin that the owner’s rescue depends on',
      )
    }

    if (!call.isDelegateCall && contract) {
      // Easy to get wrong by hand, and it fails quietly: the step reads the step contract's own
      // balance, which is always zero, so an amount-dependent step either reverts or does nothing.
      warnings.push(
        'targets a step contract as a plain call rather than a delegatecall, so it would read that ' +
          'contract’s balance instead of the drop’s',
      )
    }

    if (call.allowFailure) {
      warnings.push('may fail without stopping the activation, so the recipe can complete without it')
    }

    return {
      index: index + 1,
      target: call.target,
      known,
      value: call.value,
      allowFailure: call.allowFailure,
      isDelegateCall: call.isDelegateCall,
      callData: call.callData,
      warnings,
    }
  })

  return { label: recipe.label, salt: recipe.salt, once: recipe.once, steps }
}

/** Whether anything in a described recipe needs flagging to whoever is about to fund it. */
export function hasWarnings(described: DescribedRecipe): boolean {
  return described.steps.some((step) => step.warnings.length > 0)
}
