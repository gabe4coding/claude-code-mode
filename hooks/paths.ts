// Where code-mode keeps its files: the folder .claude/code-mode in HOME (the
// person's) and in the project root. Every path into it is made here, so the
// loaders and the hint-file guard always name the same folders.
// tests/code.check.mjs fails when another file in hooks/ types one out.

const APP = 'code-mode'
const HINTS = 'hints'
const FUNCTIONS = 'functions'

/** A path in code-mode's folder under `root`: HOME or the project root. */
export const codeModePath = (root: string, ...parts: string[]): string => [root, '.claude', APP, ...parts].join('/')

/** The hint folder under HOME or the project root. */
export const hintsFolder = (root: string): string => codeModePath(root, HINTS)

/** The saved-function folder under HOME. */
export const functionsFolder = (home: string): string => codeModePath(home, FUNCTIONS)

/**
 * The folders whose files steer the model, as written: the person's and the
 * project's hints (the project's even while projectHints is off, so none can
 * be planted to load later), and the person's saved functions. Only an
 * approval writes them; the model's own tools may not. An empty root has none.
 */
export const guardedDirs = (home: string, project: string): string[] => [
  ...(home ? [hintsFolder(home), functionsFolder(home)] : []),
  ...(project ? [hintsFolder(project)] : []),
]

// A part of a path that the shell expands: a glob, a brace, a variable or a command.
const EXPANDS = /[*?[{$`]/

// Inspection of `.claude/code-mode` itself. A copy, a link or a `cd` into that
// folder is still denied: those reach the guarded folders inside it.
const READS_APP = new Set(['ls', 'du'])

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Bash POSIX classes, as ASCII. The guarded names are ASCII.
const POSIX: Record<string, string> = {
  alnum: '0-9A-Za-z',
  alpha: 'A-Za-z',
  ascii: '\\x00-\\x7F',
  blank: '\\t ',
  cntrl: '\\x00-\\x1F\\x7F',
  digit: '0-9',
  graph: '\\x21-\\x7E',
  lower: 'a-z',
  print: '\\x20-\\x7E',
  punct: '!-/:-@\\[-`{-~',
  space: '\\t\\n\\v\\f\\r ',
  upper: 'A-Z',
  word: '0-9A-Za-z_',
  xdigit: '0-9A-Fa-f',
}

const classLiteral = (ch: string): string => (/[\\\]^/-]/.test(ch) ? `\\${ch}` : ch)

// One Bash bracket expression at `start`, or null when it cannot be translated.
const bracketAt = (part: string, start: number): { source: string; next: number } | null => {
  const at = (index: number): string => part.charAt(index)
  let i = start + 1
  let neg = false
  if (at(i) === '!' || at(i) === '^') {
    neg = true
    i++
  }
  let body = ''
  if (at(i) === ']') {
    body += '\\]'
    i++
  }
  while (i < part.length && at(i) !== ']') {
    if (at(i) === '[' && (at(i + 1) === ':' || at(i + 1) === '.' || at(i + 1) === '=')) {
      const kind = at(i + 1)
      const mark = `${kind}]`
      const end = part.indexOf(mark, i + 2)
      if (end < 0 || kind !== ':') return null
      const mapped = POSIX[part.slice(i + 2, end)]
      if (mapped === undefined) return null
      body += mapped
      i = end + mark.length
      continue
    }
    if (at(i + 1) === '-' && i + 2 < part.length && at(i + 2) !== ']') {
      if (at(i) > at(i + 2)) return null
      body += `${classLiteral(at(i))}-${classLiteral(at(i + 2))}`
      i += 3
      continue
    }
    body += classLiteral(at(i))
    i++
  }
  if (at(i) !== ']') return null
  return { source: neg ? `[^${body}]` : `[${body}]`, next: i + 1 }
}

// A glob part as a regular expression, or null when a bracket or brace cannot be translated.
const globSource = (part: string): string | null => {
  let out = ''
  for (let i = 0; i < part.length; ) {
    const ch = part.charAt(i)
    if (ch === '*') {
      out += '.*'
      i++
      continue
    }
    if (ch === '?') {
      out += '.'
      i++
      continue
    }
    if (ch === '[') {
      const bracket = bracketAt(part, i)
      if (bracket === null) return null
      out += bracket.source
      i = bracket.next
      continue
    }
    if (ch === '{') {
      const end = part.indexOf('}', i + 1)
      if (end < 0) return null
      const alts = part.slice(i + 1, end).split(',')
      const mapped: string[] = []
      for (const alt of alts) {
        const source = globSource(alt)
        if (source === null) return null
        mapped.push(source)
      }
      out += `(${mapped.join('|')})`
      i = end + 1
      continue
    }
    out += escape(ch)
    i++
  }
  return out
}

// A part of a path as the shell reads it: true when it can expand to `name`.
// A variable, a command, or a pattern that cannot be translated can be anything.
const canBe = (part: string | undefined, name: string): boolean => {
  if (part === undefined) return false
  if (!EXPANDS.test(part)) return part.toLowerCase() === name
  if (/[$`]/.test(part)) return true
  try {
    const source = globSource(part)
    if (source === null) return true
    return new RegExp(`^${source}$`, 'i').test(name)
  } catch {
    return true
  }
}
const canBeGuarded = (part: string | undefined): boolean => canBe(part, HINTS) || canBe(part, FUNCTIONS)

const low = (part: string): string => part.toLowerCase()

// Index of `hints` or `functions` in `.claude/code-mode/...`, or -1.
const guardedEnd = (parts: string[]): number => {
  for (let i = 0; i < parts.length - 2; i++) {
    if (low(parts[i] ?? '') !== '.claude' || low(parts[i + 1] ?? '') !== APP) continue
    const name = low(parts[i + 2] ?? '')
    if (name === HINTS || name === FUNCTIONS) return i + 2
  }
  return -1
}

// Quotes and backslashes are already gone. `//` and `/./` fold. `..` folds a
// real directory, but never the protected prefix: a `$var` or a glob may be
// several directories, so `..` after it must not climb past the guarded folder.
const fold = (word: string): string[] => {
  const parts: string[] = []
  let uncertain = false
  for (const part of word.split('/')) {
    if (part === '.' || (part === '' && parts.length > 0)) continue
    if (part !== '..') {
      parts.push(part)
      uncertain = false
      continue
    }
    const last = parts[parts.length - 1]
    if (last === undefined || last === '' || last === '..') {
      parts.push('..')
      continue
    }
    const end = guardedEnd(parts)
    if (end >= 0 && parts.length - 1 <= end) continue
    if (EXPANDS.test(last)) {
      if (end >= 0) continue
      uncertain = true
      parts.pop()
      continue
    }
    const appUnderClaude = low(last) === APP && low(parts[parts.length - 2] ?? '') === '.claude'
    if (uncertain && appUnderClaude) continue
    parts.pop()
    uncertain = false
  }
  return parts
}

// `{`, `}` and `,` split brace expansion (`{x,~/.claude/code-mode/hints}`).
const commandWords = (command: string): string[] =>
  command
    .replace(/['"\\]/g, '')
    .split(/[\s;&|<>()={},]+/)
    .filter(Boolean)

const verbBefore = (words: string[], index: number): string => {
  for (let i = index - 1; i >= 0; i--) {
    const word = words[i] ?? ''
    if (word.startsWith('-') || word.includes('/') || word.startsWith('~')) continue
    return word
  }
  return ''
}

const entersApp = (parts: string[]): boolean =>
  parts.some((part, i) => low(part) === '.claude' && canBe(parts[i + 1], APP))

// `hints` in another word counts only as a path after `cd` into the folder
// (`cd ~/.claude/code-mode && cp a hints/`). A grep word does not.
const reachesAfterCd = (words: string[], paths: string[][]): boolean => {
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] !== 'cd' || !entersApp(paths[i + 1] ?? [])) continue
    for (let j = i + 2; j < words.length; j++) {
      if ((words[j - 1] ?? '').startsWith('-') || !(words[j] ?? '').includes('/')) continue
      if ((paths[j] ?? []).some(part => low(part) === HINTS || low(part) === FUNCTIONS)) return true
    }
  }
  return false
}

/**
 * True when a shell command names a guarded folder. Best effort, as a shell
 * can spell a path many ways. It reads quotes, backslashes, braces, `//`,
 * `/./` and `x/../` as the shell does, and a glob, bracket, variable or
 * command as any name it can expand to. A `cd` into `.claude/code-mode` plus
 * a later path of `hints` or `functions` is denied. So is a copy or a link
 * of that folder. `ls` and `du` of the folder itself are not.
 */
export const namesGuardedDir = (command: string): boolean => {
  const words = commandWords(command)
  const paths = words.map(fold)
  if (reachesAfterCd(words, paths)) return true
  for (const [index, p] of paths.entries()) {
    for (const [i, part] of p.entries()) {
      const isUnderClaude = low(p[i - 1] ?? '') === '.claude'
      if (!(isUnderClaude ? canBe(part, APP) : low(part) === APP)) continue
      if (canBeGuarded(p[i + 1])) return true
      if (isUnderClaude && p[i + 1] === undefined && !READS_APP.has(verbBefore(words, index))) return true
    }
  }
  return false
}
