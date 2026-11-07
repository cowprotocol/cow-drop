import { useState, type ReactNode } from 'react'

import type { Language } from '../lib/highlight.js'
import { Code } from './Code.js'

/** A copyable code block. Wrapped rather than scrolled, so nothing is hidden off-screen. */
export function CopyBlock({
  label,
  hint,
  command,
  language = 'shell',
}: {
  label: string
  hint?: ReactNode
  command: string
  language?: Language
}) {
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
      <Code source={command} language={language} />
    </div>
  )
}
