import { useState } from 'react'

/** A copyable command block. Wrapped rather than scrolled, so nothing is hidden off-screen. */
export function CopyBlock({ label, hint, command }: { label: string; hint?: string; command: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="copy-block">
      <div className="copy-block-head">
        <span className="copy-block-label">{label}</span>
        <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {hint && <p className="hint">{hint}</p>}
      <pre>{command}</pre>
    </div>
  )
}
