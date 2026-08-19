import { describeRecipe, type DescribedArg, type DescribedStep, type DropDeployment } from '@cowprotocol/cow-drop-sdk'
import type { Hex } from 'viem'

/**
 * Shows what the committed bytes actually say, and the bytes themselves.
 *
 * Worth surfacing rather than hiding: the address is a commitment to precisely these bytes, so this
 * is the only place a user can see what they are being asked to fund. Activation is permissionless
 * and unsigned, so reading this *is* the safeguard — which is why the steps are decoded here rather
 * than shown as raw calldata. A step the SDK cannot name is not hidden either; it is called out.
 */
export function StepTable({ setupData, deployment }: { setupData: Hex; deployment: DropDeployment }) {
  const described = describeRecipe(setupData, deployment)

  return (
    <div className="steps">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Step</th>
            <th>Arguments</th>
            <th>Mode</th>
          </tr>
        </thead>
        <tbody>
          {described.steps.map((step) => (
            <StepRow key={step.index} step={step} />
          ))}
        </tbody>
      </table>

      <details>
        <summary>Committed bytes ({(setupData.length - 2) / 2} bytes)</summary>
        <code className="calldata block">{setupData}</code>
        <p className="hint">
          This is <code>setupData</code>. The drop address is a hash of these bytes and the owner, so
          changing any of it produces a different address — which is why nobody can substitute a
          different recipe at this one.
        </p>
      </details>
    </div>
  )
}

function StepRow({ step }: { step: DescribedStep }) {
  return (
    <tr>
      <td>{step.index}</td>
      <td>
        {step.known ? (
          <>
            <code>{step.known.functionName}</code>
            <div className="hint">{step.known.contract}</div>
          </>
        ) : (
          <>
            <span className="unknown-step">unrecognised call</span>
            <div className="hint">
              <code className="calldata">{step.target}</code>
            </div>
          </>
        )}
      </td>
      <td>
        {step.known ? (
          <dl className="args">
            {step.known.args.map((arg) => (
              <div key={arg.name}>
                <dt>{arg.name}</dt>
                <dd>
                  <code>{formatArg(arg)}</code>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <code className="calldata">{step.callData}</code>
        )}
        {step.warnings.length > 0 && (
          <ul className="step-warnings">
            {step.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </td>
      <td>
        {step.isDelegateCall ? 'delegatecall' : 'call'}
        {step.value > 0n ? ` · ${step.value.toString()} wei` : ''}
        {step.allowFailure ? ' · may fail' : ''}
      </td>
    </tr>
  )
}

/**
 * Render an argument as itself, not as a friendlier version of itself.
 *
 * Deliberately no unit conversion or symbol lookup: these are the exact values hashed into the
 * address, and a prettified `1000 WXDAI` that disagreed with the committed `1000000000000000000000`
 * by one atomic unit would be describing a different drop.
 */
function formatArg(arg: DescribedArg): string {
  if (typeof arg.value === 'bigint') return arg.value.toString()
  if (typeof arg.value === 'boolean') return arg.value ? 'true' : 'false'
  return String(arg.value)
}
