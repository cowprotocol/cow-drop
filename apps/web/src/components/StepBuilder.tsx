import type { DropStepJson } from '@cowprotocol/cow-drop-sdk'
import { useMemo, useState } from 'react'
import { encodeFunctionData, isAddress, parseAbi, type Abi, type AbiFunction } from 'viem'

/**
 * Build a step the registry does not cover, from an ABI.
 *
 * This emits a `raw` step, which is the escape hatch for calling anything from a drop. Two things are
 * worth knowing about what it can and cannot do:
 *
 * - Every argument here is a **literal**, committed into the drop address. So this cannot express
 *   anything that depends on the amount that arrives — that is what the typed steps are for, and it is
 *   the one thing `raw` structurally cannot do.
 * - A `delegatecall` runs the target's code *as the drop*, with full access to the shed's storage
 *   including the admin slot the owner's rescue depends on. It is a plain call by default and asks
 *   twice before it is not.
 */
export function StepBuilder({
  onAddStep,
  onError,
}: {
  onAddStep: (step: DropStepJson) => void
  onError: (message: string) => void
}) {
  const [signatures, setSignatures] = useState('function transfer(address to, uint256 amount)')
  const [selected, setSelected] = useState(0)
  const [args, setArgs] = useState<Record<string, string>>({})
  const [target, setTarget] = useState('')
  const [value, setValue] = useState('0')
  const [allowFailure, setAllowFailure] = useState(false)
  const [delegate, setDelegate] = useState(false)
  const [delegateConfirmed, setDelegateConfirmed] = useState(false)

  /**
   * Human-readable signatures first, a JSON ABI as the fallback — pasting the fragment straight out of
   * an explorer should work either way. Parse errors are shown rather than thrown: a half-typed
   * signature is the normal state of this box, not a failure.
   */
  const parsed = useMemo((): { functions: AbiFunction[]; error: string | null } => {
    const text = signatures.trim()
    if (!text) return { functions: [], error: null }

    let abi: Abi
    try {
      abi = text.startsWith('[') || text.startsWith('{')
        ? (JSON.parse(text) as Abi)
        : (parseAbi(text.split('\n').map((line) => line.trim()).filter(Boolean)) as Abi)
    } catch (cause) {
      return { functions: [], error: cause instanceof Error ? cause.message : String(cause) }
    }

    const functions = abi.filter((item): item is AbiFunction => item.type === 'function')
    return { functions, error: functions.length === 0 ? 'no functions in that ABI' : null }
  }, [signatures])

  const fn = parsed.functions[selected]

  const add = () => {
    if (!fn) return onError('Pick a function first.')
    if (!isAddress(target)) return onError(`Target is not an address: ${target || '(empty)'}`)
    if (delegate && !delegateConfirmed) return onError('Confirm the delegatecall warning first.')

    try {
      const callData = encodeFunctionData({
        abi: parsed.functions as Abi,
        functionName: fn.name,
        args: fn.inputs.map((input, index) => coerce(args[argKey(fn, index)] ?? '', input.type)),
      })

      onAddStep({
        type: 'raw',
        target,
        callData,
        // Omitted when they are the defaults, so the recipe file stays readable.
        ...(value !== '0' && value !== '' ? { value } : {}),
        ...(allowFailure ? { allowFailure: true } : {}),
        ...(delegate ? { isDelegateCall: true } : {}),
      })
    } catch (cause) {
      onError(`Could not encode the call: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  return (
    <div className="step-builder">
      <label>
        ABI
        <textarea
          value={signatures}
          spellCheck={false}
          rows={4}
          onChange={(event) => {
            setSignatures(event.target.value)
            setSelected(0)
            setArgs({})
          }}
        />
      </label>
      <p className="hint">
        One human-readable signature per line, or a JSON ABI pasted from an explorer.
      </p>
      {parsed.error && <p className="error">{parsed.error}</p>}

      {parsed.functions.length > 0 && (
        <>
          <label>
            Function
            <select value={selected} onChange={(event) => { setSelected(Number(event.target.value)); setArgs({}) }}>
              {parsed.functions.map((item, index) => (
                <option key={`${item.name}-${index}`} value={index}>
                  {item.name}({item.inputs.map((input) => input.type).join(', ')})
                </option>
              ))}
            </select>
          </label>

          {fn?.inputs.map((input, index) => (
            <label key={argKey(fn, index)}>
              <span className="arg-label">
                {input.name || `arg${index}`} <span className="hint">&middot; {input.type}</span>
              </span>
              <input
                value={args[argKey(fn, index)] ?? ''}
                spellCheck={false}
                placeholder={placeholderFor(input.type)}
                onChange={(event) => setArgs((prev) => ({ ...prev, [argKey(fn, index)]: event.target.value }))}
              />
            </label>
          ))}

          <label>
            Target
            <input
              value={target}
              spellCheck={false}
              placeholder="0x… the contract to call"
              onChange={(event) => setTarget(event.target.value)}
            />
          </label>

          <label>
            Native value (wei)
            <input value={value} spellCheck={false} onChange={(event) => setValue(event.target.value)} />
          </label>
          <p className="hint">
            A literal, like every argument here. For “whatever arrived”, use the <code>wrapNative</code>{' '}
            step.
          </p>

          <label className="inline">
            <input type="checkbox" checked={allowFailure} onChange={(event) => setAllowFailure(event.target.checked)} />
            Let the recipe continue if this call reverts
          </label>

          <label className="inline">
            <input
              type="checkbox"
              checked={delegate}
              onChange={(event) => {
                setDelegate(event.target.checked)
                setDelegateConfirmed(false)
              }}
            />
            Run as a delegatecall
          </label>

          {delegate && (
            <div className="warn-box">
              <p>
                A delegatecall runs the target’s code <strong>as the drop</strong>. It can move any
                balance the drop holds and rewrite the shed’s own storage — including the admin that
                your rescue path depends on. Only do this for a contract you have read.
              </p>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={delegateConfirmed}
                  onChange={(event) => setDelegateConfirmed(event.target.checked)}
                />
                I have read the target’s code and want it to run as the drop
              </label>
            </div>
          )}

          <div className="actions">
            <button onClick={add} disabled={!fn || (delegate && !delegateConfirmed)}>
              Add step
            </button>
          </div>
          <p className="hint">
            The step is appended to the recipe below, so the drop address changes. It will show up as an
            unrecognised call above — only the registry’s steps can be named.
          </p>
        </>
      )}
    </div>
  )
}

/** Stable per-function key, so switching functions cannot carry a value onto a different argument. */
const argKey = (fn: AbiFunction, index: number) => `${fn.name}:${index}`

/**
 * Turn a text field into the type the ABI wants.
 *
 * Only the shapes a single input box can express. Anything structured — tuples, nested arrays — is
 * passed to viem as JSON and allowed to fail there, with the message shown, rather than being
 * half-guessed here.
 */
function coerce(raw: string, type: string): unknown {
  const text = raw.trim()
  if (type.endsWith(']') || type.startsWith('tuple')) return JSON.parse(text || '[]')
  if (type === 'bool') return text === 'true'
  if (type.startsWith('uint') || type.startsWith('int')) return BigInt(text || '0')
  return text
}

function placeholderFor(type: string): string {
  if (type === 'address') return '0x…'
  if (type.startsWith('bytes')) return '0x…'
  if (type === 'bool') return 'true or false'
  if (type.endsWith(']')) return '["…", "…"]'
  if (type.startsWith('uint') || type.startsWith('int')) return '0'
  return ''
}
