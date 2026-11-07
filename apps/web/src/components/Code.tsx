import { useMemo } from 'react'

import { highlight, type Language } from '../lib/highlight.js'

/**
 * A highlighted code block.
 *
 * Tokens render as spans, so the text is React children and never markup — a snippet cannot inject
 * anything, and selecting the block copies exactly the source it was given.
 */
export function Code({ source, language }: { source: string; language: Language }) {
  const tokens = useMemo(() => highlight(source, language), [source, language])

  return (
    <pre className="code">
      <code>
        {tokens.map((token, index) =>
          token.kind === 'plain' ? (
            token.text
          ) : (
            <span key={index} className={`tok-${token.kind}`}>
              {token.text}
            </span>
          ),
        )}
      </code>
    </pre>
  )
}
