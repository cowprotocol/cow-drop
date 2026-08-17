import type { DropCall } from '@cowprotocol/cow-drop-sdk'
import type { Hex } from 'viem'

/**
 * Shows the compiled calls and the exact bytes they hash to.
 *
 * Worth surfacing rather than hiding: the address is a commitment to precisely these bytes, so this
 * table is the only way a user can see what they are being asked to fund.
 */
export function StepTable({ calls, setupData }: { calls: DropCall[]; setupData: Hex }) {
  return (
    <div className="steps">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Target</th>
            <th>Value</th>
            <th>Mode</th>
            <th>Calldata</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call, index) => (
            <tr key={index}>
              <td>{index + 1}</td>
              <td>
                <code>{call.target}</code>
              </td>
              <td>{call.value.toString()}</td>
              <td>
                {call.isDelegateCall ? 'delegatecall' : 'call'}
                {call.allowFailure ? ' · may fail' : ''}
              </td>
              <td>
                <code className="calldata">{call.callData}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <details>
        <summary>Committed bytes ({(setupData.length - 2) / 2} bytes)</summary>
        <code className="calldata block">{setupData}</code>
        <p className="hint">
          This is <code>setupData</code>. The drop address is a hash of these bytes together with the
          owner, so changing any of it produces a different address — which is exactly why nobody can
          substitute a different recipe at this one.
        </p>
      </details>
    </div>
  )
}
