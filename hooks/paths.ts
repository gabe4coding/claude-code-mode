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

// Read-only programs that may name the folder `code-mode` itself. They may not
// name `hints` or `functions`, and an argument is never the program.
const READ_ONLY = new Set(['ls', 'du', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'rg', 'grep'])
const WRAPPERS = new Set(['sudo', 'env', 'command'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

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

const low = (part: string): string => part.toLowerCase()

// True when a glob segment can be `name`. Null when the pattern cannot be read.
const globMatch = (segment: string, name: string): boolean | null => {
  try {
    const source = globSource(segment)
    if (source === null) return null
    return new RegExp(`^${source}$`, 'i').test(name)
  } catch {
    return null
  }
}

type Risk = { hints: boolean; app: boolean; unsafe: boolean; claude: boolean }

const riskOfSegment = (segment: string): Risk => {
  const none = { hints: false, app: false, unsafe: false, claude: false }
  if (segment === '' || segment === '.') return none
  if (segment === '..' || /[$`{]/.test(segment)) return { ...none, unsafe: true }
  if (!/[*?[]/.test(segment)) {
    const name = low(segment)
    return {
      hints: name === HINTS || name === FUNCTIONS,
      app: name === APP,
      unsafe: false,
      claude: name === '.claude',
    }
  }
  const hints = globMatch(segment, HINTS)
  const functions = globMatch(segment, FUNCTIONS)
  const app = globMatch(segment, APP)
  const claude = globMatch(segment, '.claude')
  if (hints === null || functions === null || app === null || claude === null)
    return { hints: false, app: false, unsafe: true, claude: false }
  return { hints: hints || functions, app, unsafe: false, claude }
}

const segmentsOf = (word: string): string[] => {
  const parts: string[] = []
  for (const part of word.split(/[/=]/)) if (part !== '' && part !== '.') parts.push(part)
  return parts
}

// `{a,b}` expands with its prefix and suffix. A brace that does not close is unsafe.
const expandBraces = (word: string): string[] | null => {
  let depth = 0
  let start = -1
  for (let i = 0; i < word.length; i++) {
    const ch = word.charAt(i)
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch !== '}') continue
    if (depth === 0) return null
    depth--
    if (depth !== 0 || start < 0) continue
    const body = word.slice(start + 1, i)
    const braceAt = start
    start = -1
    if (!body.includes(',')) continue
    const alts: string[] = []
    let alt = ''
    let nest = 0
    for (const c of body) {
      if (c === '{') nest++
      if (c === '}' && nest > 0) nest--
      if (c === ',' && nest === 0) {
        alts.push(alt)
        alt = ''
      } else alt += c
    }
    alts.push(alt)
    if (alts.length > 32) return null
    const head = word.slice(0, braceAt)
    const tail = word.slice(i + 1)
    const out: string[] = []
    for (const piece of alts) {
      const next = expandBraces(head + piece + tail)
      if (next === null) return null
      out.push(...next)
      if (out.length > 32) return null
    }
    return out
  }
  if (depth !== 0) return null
  return [word]
}

type Parsed = { commands: string[][]; redirect: boolean }

// Quotes and backslashes come off. `&&`, `|`, `;`, `(`, `)`, and newlines
// separate programs, and `<` ends a word. `>` marks an output redirection. A
// quote that never ends is unsafe.
const parseCommand = (command: string): Parsed | null => {
  const commands: string[][] = []
  let words: string[] = []
  let buf = ''
  let quote: "'" | '"' | null = null
  let redirect = false
  const flushWord = () => {
    if (buf.length > 0) {
      words.push(buf)
      buf = ''
    }
  }
  const flushCommand = () => {
    flushWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i)
    if (quote === "'") {
      if (ch === "'") quote = null
      else buf += ch
      continue
    }
    if (quote === '"') {
      if (ch === '\\') {
        const next = command.charAt(i + 1)
        if (next === '') return null
        buf += '"\\`$\n'.includes(next) ? next : ch
        if ('"\\`$\n'.includes(next)) i++
        continue
      }
      if (ch === '"') quote = null
      else buf += ch
      continue
    }
    if (ch === '\\') {
      const next = command.charAt(i + 1)
      if (next === '') return null
      buf += next
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '&' && command.charAt(i + 1) === '>') {
      redirect = true
      flushWord()
      i++
      continue
    }
    if (ch === '>') {
      redirect = true
      if (/^\d+$/.test(buf)) buf = ''
      flushWord()
      if (command.charAt(i + 1) === '>') i++
      else if (command.charAt(i + 1) === '&') i++
      continue
    }
    if ((ch === '&' && command.charAt(i + 1) === '&') || (ch === '|' && command.charAt(i + 1) === '|')) {
      flushCommand()
      i++
      continue
    }
    if ('|&;\n()'.includes(ch)) {
      flushCommand()
      continue
    }
    if (' \t\r<'.includes(ch)) {
      flushWord()
      continue
    }
    buf += ch
  }
  if (quote !== null) return null
  flushCommand()
  const expanded: string[][] = []
  for (const argv of commands) {
    const flat: string[] = []
    for (const word of argv) {
      const alts = expandBraces(word)
      if (alts === null) return null
      flat.push(...alts)
    }
    if (flat.length > 0) expanded.push(flat)
  }
  return { commands: expanded, redirect }
}

// The program name: after assignments and after sudo, env, or command.
const programAt = (argv: string[]): { name: string; index: number } | null => {
  let i = 0
  while (i < argv.length && ASSIGNMENT.test(argv[i] ?? '')) i++
  while (i < argv.length && WRAPPERS.has(low(argv[i] ?? ''))) {
    i++
    while (i < argv.length && (argv[i] ?? '').startsWith('-')) {
      const flag = argv[i] ?? ''
      i++
      if (flag === '-u' || flag === '--user' || flag === '-g' || flag === '--group') {
        if (i >= argv.length) return null
        i++
      }
    }
    while (i < argv.length && ASSIGNMENT.test(argv[i] ?? '')) i++
  }
  const name = argv[i]
  if (name === undefined || name === '') return null
  return { name: low(name), index: i }
}

const operandPaths = (argv: string[], from: number): string[] => {
  const paths: string[] = []
  let flags = true
  for (let i = from + 1; i < argv.length; i++) {
    const word = argv[i] ?? ''
    if (flags && word === '--') {
      flags = false
      continue
    }
    if (flags && word.startsWith('-')) continue
    flags = false
    paths.push(word)
  }
  return paths
}

const absolute = (word: string): boolean => word.startsWith('/') || word.startsWith('~')

// Programs that run a word as a script, as `bash -c` or `eval` do. A word with
// one of the SCRIPT characters can then hide a command.
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'eval', 'source', 'watch', 'su', 'script', 'flock']
const SCRIPT = /[\s;&|<>()'"\\]/

// The first token of the word, so `env -S "bash -c ..."` counts. A glob such
// as `/bin/b?sh` counts when it can be a shell or cannot be read.
const isShell = (word: string): boolean => {
  const head = word.trim().split(/\s+/)[0] ?? ''
  const name = low(head.slice(head.lastIndexOf('/') + 1))
  if (!/[*?[]/.test(name)) return SHELLS.includes(name)
  return SHELLS.some(shell => globMatch(name, shell) !== false)
}

const runsShell = (commands: string[][]): boolean =>
  commands.some(argv => programAt(argv)?.name === '.' || argv.some(isShell))

const writesOut = (argv: string[]): boolean =>
  argv.some(word => word === '-o' || word === '--output' || word.startsWith('--output=') || low(word) === 'tee')

/**
 * True when a shell command could name a guarded folder. Fail closed.
 * Quotes and backslashes come off, and braces expand. A word that is
 * `hints` or `functions`, a `..`, a pattern that cannot be read, or a
 * relative path after `cd` into `.claude` is denied. A word that is
 * `code-mode` is denied unless every program is read-only, with no `>`,
 * `>>`, `tee`, or `-o`, and no program outside that list in a pipeline.
 * When the command runs a shell, a word with spaces, quotes, backslashes, or
 * shell operators is also read as a command of its own.
 */
export const namesGuardedDir = (command: string): boolean => {
  const parsed = parseCommand(command)
  if (parsed === null) return true
  let hints = false
  let app = false
  let unsafe = false
  let underClaude = false
  let relative = false
  let pure = parsed.commands.length > 0 && !parsed.redirect
  const shell = runsShell(parsed.commands)
  for (const argv of parsed.commands) {
    const program = programAt(argv)
    if (program === null || !READ_ONLY.has(program.name) || writesOut(argv)) pure = false
    for (const word of argv) {
      if (shell && SCRIPT.test(word) && namesGuardedDir(word)) return true
      for (const segment of segmentsOf(word)) {
        const risk = riskOfSegment(segment)
        hints ||= risk.hints
        app ||= risk.app
        unsafe ||= risk.unsafe
      }
    }
    if (program !== null && underClaude && program.name !== 'cd') {
      const paths = operandPaths(argv, program.index)
      if (paths.length === 0 || paths.some(word => !absolute(word))) relative = true
    }
    if (program?.name === 'cd') {
      const dest = operandPaths(argv, program.index)[0]
      if (underClaude && dest !== undefined && !absolute(dest)) relative = true
      if (
        dest !== undefined &&
        segmentsOf(dest).some(segment => riskOfSegment(segment).claude || riskOfSegment(segment).unsafe)
      )
        underClaude = true
    }
  }
  if (unsafe || hints || relative) return true
  return app && !pure
}
