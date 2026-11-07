/**
 * A very small syntax highlighter, for the code this page shows.
 *
 * Deliberately hand-rolled. The app carries no dependency it does not need — the SDK panel says so in
 * its own header — and a highlighter that covers every language is several hundred kilobytes to colour
 * seven fixed snippets. What is here covers exactly the two languages on the page: the TypeScript of
 * the SDK examples, and the shell of the terminal panel.
 *
 * It is a tokeniser, not a parser, and it is allowed to be wrong. The worst outcome is a word in the
 * wrong colour — nothing here decides anything, and the text returned is always the input text,
 * unchanged and in order, so what you copy is what was written. Output is rendered as React children,
 * so there is no markup to escape and no way for a snippet to inject any.
 */

export type TokenKind =
  | 'comment'
  | 'string'
  | 'keyword'
  | 'number'
  | 'function'
  | 'flag'
  | 'variable'
  | 'punctuation'
  | 'plain'

export interface Token {
  text: string
  kind: TokenKind
}

export type Language = 'ts' | 'shell'

/**
 * Comments and strings come first in every pattern below, so their contents are never re-tokenised —
 * a `//` inside a URL, or a keyword inside a comment, stays the colour of what encloses it.
 */
const TS_PATTERN = new RegExp(
  [
    String.raw`(?<comment>\/\/[^\n]*|\/\*[\s\S]*?\*\/)`,
    String.raw`(?<string>'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\`(?:[^\`\\]|\\.)*\`)`,
    String.raw`(?<number>\b0[xX][0-9a-fA-F_]+n?\b|\b\d[\d_]*n?\b)`,
    String.raw`(?<keyword>\b(?:await|async|const|let|var|function|return|import|export|from|for|of|in|new|true|false|null|undefined|if|else|type|interface|as)\b)`,
    // An identifier immediately before `(` is being called. Good enough, and the only cue available
    // without a parser.
    String.raw`(?<fn>\b[A-Za-z_$][\w$]*(?=\())`,
    String.raw`(?<punct>=>|\*\*|[{}()[\];,.:=+\-*/<>!?|&])`,
  ].join('|'),
  'g',
)

const SHELL_PATTERN = new RegExp(
  [
    String.raw`(?<comment>#[^\n]*)`,
    String.raw`(?<string>'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`,
    String.raw`(?<variable>\$\{?[A-Za-z_]\w*\}?)`,
    String.raw`(?<number>\b0[xX][0-9a-fA-F]+\b)`,
    // `-X`, `--rpc-url`. Not anchored to a word boundary on the left, because the alternative is a
    // lookbehind, and the snippets here never contain a mid-word dash run.
    String.raw`(?<flag>--?[A-Za-z][\w-]*)`,
    String.raw`(?<punct>[|\\])`,
  ].join('|'),
  'g',
)

/** The first word of a shell line is the program it runs — `curl`, `cast`, `jq`. */
const SHELL_COMMAND = /^(\s*)([a-z][\w.-]*)/

const KIND_BY_GROUP: Record<string, TokenKind> = {
  comment: 'comment',
  string: 'string',
  number: 'number',
  keyword: 'keyword',
  fn: 'function',
  flag: 'flag',
  variable: 'variable',
  punct: 'punctuation',
}

/** Split `source` on `pattern`, tagging each match by which named group caught it. */
function scan(source: string, pattern: RegExp): Token[] {
  const tokens: Token[] = []
  let last = 0

  // `lastIndex` is shared state on a module-level regex, so it is reset rather than assumed.
  pattern.lastIndex = 0
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const groups = match.groups ?? {}
    const name = Object.keys(groups).find((key) => groups[key] !== undefined)
    if (!name) continue

    if (match.index > last) tokens.push({ text: source.slice(last, match.index), kind: 'plain' })
    tokens.push({ text: match[0], kind: KIND_BY_GROUP[name] ?? 'plain' })
    last = match.index + match[0].length
  }

  if (last < source.length) tokens.push({ text: source.slice(last), kind: 'plain' })
  return tokens
}

/** Shell, tokenised a line at a time so the leading command can be told from its arguments. */
function tokenizeShell(source: string): Token[] {
  const tokens: Token[] = []

  source.split('\n').forEach((line, index) => {
    if (index > 0) tokens.push({ text: '\n', kind: 'plain' })

    // A continuation line starts with a flag, a quote or an argument, so this matches only real
    // command lines — which is the distinction worth drawing.
    const lead = SHELL_COMMAND.exec(line)
    if (!lead) {
      tokens.push(...scan(line, SHELL_PATTERN))
      return
    }

    const [, indent = '', command = ''] = lead
    if (indent) tokens.push({ text: indent, kind: 'plain' })
    tokens.push({ text: command, kind: 'function' })
    tokens.push(...scan(line.slice(indent.length + command.length), SHELL_PATTERN))
  })

  return tokens
}

/** `source` as coloured tokens. Concatenating their text always reproduces `source` exactly. */
export function highlight(source: string, language: Language): Token[] {
  const tokens = language === 'shell' ? tokenizeShell(source) : scan(source, TS_PATTERN)
  // Adjacent plain runs merge, so the rendered output is a handful of spans rather than hundreds.
  return tokens.reduce<Token[]>((merged, token) => {
    const previous = merged[merged.length - 1]
    if (previous && previous.kind === 'plain' && token.kind === 'plain') {
      previous.text += token.text
      return merged
    }
    merged.push({ ...token })
    return merged
  }, [])
}
