import {
  decodeHookPaymentData,
  decodeSellBalanceData,
  describeRecipe,
  type DescribedStep,
  type DropDeployment,
} from '@cowprotocol/cow-drop-sdk'
import type { ReactNode } from 'react'
import type { Hex } from 'viem'

import { explorerAddressUrl } from '../lib/chain.js'

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
            <StepRow key={step.index} step={step} deployment={deployment} />
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

function StepRow({ step, deployment }: { step: DescribedStep; deployment: DropDeployment }) {
  const chainId = deployment.chainId
  const terms = step.known ? handlerTerms(step, deployment) : null
  /*
   * The contract the step calls, linked to its explorer page.
   *
   * It was already named here, which is most of the job — but "which contract is this" is a question
   * answered by going and looking at it, and an unrecognised call is exactly the case where you most
   * want to. The target address is the link either way; only the text differs.
   */
  const target = explorerAddressUrl(chainId, step.target)
  const contract = step.known ? (
    <div className="hint">
      {target ? (
        <a href={target} target="_blank" rel="noreferrer" title={step.target}>
          {step.known.contract} ↗
        </a>
      ) : (
        step.known.contract
      )}
    </div>
  ) : (
    <div className="hint">
      {target ? (
        <a href={target} target="_blank" rel="noreferrer">
          <code className="calldata">{step.target}</code>
        </a>
      ) : (
        <code className="calldata">{step.target}</code>
      )}
    </div>
  )

  return (
    <tr>
      <td>{step.index}</td>
      <td>
        {step.known ? <code>{step.known.functionName}</code> : <span className="unknown-step">unrecognised call</span>}
        {contract}
      </td>
      <td>
        {step.known ? (
          <dl className="args">
            {step.known.args.map((arg) => (
              <div key={arg.name}>
                <dt>{arg.name}</dt>
                <dd>
                  <ArgValue value={arg.value} />
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {terms && (
          <details>
            <summary>{terms.title}</summary>
            <ArgValue value={terms.value} />
          </details>
        )}
        {/*
          * The call exactly as the drop makes it. The decoded arguments above are a reading of
          * these bytes; this is what is hashed into the address, so it is what to compare against
          * an explorer or another tool.
          */}
        <details open={!step.known}>
          <summary>Call</summary>
          <dl className="args">
            <div>
              <dt>to</dt>
              <dd>
                <code>{step.target}</code>
              </dd>
            </div>
            <div>
              <dt>type</dt>
              <dd>
                <code>{step.isDelegateCall ? 'delegatecall' : 'call'}</code>
              </dd>
            </div>
            <div>
              <dt>value</dt>
              <dd>
                <code>{step.value.toString()}</code>
              </dd>
            </div>
            <div>
              <dt>calldata</dt>
              <dd>
                <code className="calldata block">{step.callData}</code>
              </dd>
            </div>
          </dl>
        </details>
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
 *
 * A struct or an array is laid out field by field rather than stringified: `String()` of one is
 * `[object Object]`, which says nothing about a value somebody is about to fund.
 */
function ArgValue({ value }: { value: unknown }): ReactNode {
  if (typeof value === 'bigint') return <code>{value.toString()}</code>
  if (typeof value === 'boolean') return <code>{value ? 'true' : 'false'}</code>

  if (Array.isArray(value)) {
    if (value.length === 0) return <code>[]</code>
    return (
      <dl className="args">
        {value.map((item, index) => (
          <div key={index}>
            <dt>[{index}]</dt>
            <dd>
              <ArgValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    )
  }

  if (typeof value === 'object' && value !== null) {
    return (
      <dl className="args">
        {Object.entries(value).map(([name, field]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              <ArgValue value={field} />
            </dd>
          </div>
        ))}
      </dl>
    )
  }

  // Long hex (calldata, a handler's static input) wraps instead of pushing the table sideways.
  const text = String(value)
  return <code className={text.length > 66 ? 'calldata block' : undefined}>{text}</code>
}

/**
 * What a `ComposableCoW.create` registers, when the handler is one of this generation's.
 *
 * The call's own argument is `staticInput`, an opaque blob to anyone reading the table. It is where
 * the terms of every order the drop will sign are committed, so it is decoded here beside it.
 */
function handlerTerms(step: DescribedStep, deployment: DropDeployment): { title: string; value: unknown } | null {
  if (step.known?.contract !== 'ComposableCoW') return null
  const params = step.known.args[0]?.value as { handler?: string; staticInput?: Hex } | undefined
  const handler = params?.handler?.toLowerCase()
  if (!handler || !params?.staticInput) return null

  try {
    if (handler === deployment.sellBalanceHandler?.toLowerCase()) {
      return { title: 'SellBalanceHandler terms', value: decodeSellBalanceData(params.staticInput) }
    }
    if (handler === deployment.paymentHandler?.toLowerCase()) {
      return { title: 'PaymentHandler terms', value: decodeHookPaymentData(params.staticInput) }
    }
  } catch {
    // Not the layout this SDK knows; the raw static input above still stands.
  }
  return null
}
