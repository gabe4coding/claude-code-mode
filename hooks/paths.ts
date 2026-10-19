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

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A glob part as a regular expression: `*`, `?`, `[...]` and `{a,b}`.
const globRegex = (part: string): RegExp => {
  const token = (t: string): string => {
    if (t === '*') return '.*'
    if (t === '?') return '.'
    if (/^\[.+\]$/.test(t)) return `[${t.slice(1, -1).replace(/^!/, '^')}]`
    if (/^\{.*\}$/.test(t)) return `(${t.slice(1, -1).split(',').map(escape).join('|')})`
    return escape(t)
  }
  return new RegExp(`^${part.replace(/\[!?[^\]]+\]|\{[^}]*\}|[*?]|[^*?[{]+|./g, token)}$`, 'i')
}

// A part of a path as the shell reads it: true when it can expand to `name`.
// A variable or a command can be anything.
const canBe = (part: string | undefined, name: string): boolean => {
  if (part === undefined) return false
  if (!EXPANDS.test(part)) return part.toLowerCase() === name
  return /[$`]/.test(part) || globRegex(part).test(name)
}
const canBeGuarded = (part: string | undefined): boolean => canBe(part, HINTS) || canBe(part, FUNCTIONS)

// The parts of each path in a command, as the shell reads them: quotes and
// backslashes go (`hi""nts`, `hin\ts`), and `//`, `/./` and `x/../` fold.
const pathsIn = (command: string): string[][] =>
  command
    .replace(/['"\\]/g, '')
    .split(/[\s;&|<>()=]+/)
    .filter(Boolean)
    .map(word => {
      const parts: string[] = []
      for (const part of word.split('/')) {
        const last = parts[parts.length - 1]
        if (part === '.' || (part === '' && parts.length > 0)) continue
        if (part === '..' && last !== undefined && last !== '' && last !== '..') parts.pop()
        else parts.push(part)
      }
      return parts
    })

/**
 * True when a shell command names a guarded folder. Best effort, as a shell
 * can spell a path many ways. It reads quotes, backslashes, `//`, `/./` and
 * `x/../` as the shell does, and a glob, brace, variable or command as any
 * name it can expand to. It also denies a command that names the folder
 * `.claude/code-mode` itself, or names it and a guarded folder in another word
 * (`cd ~/.claude/code-mode && cp a hints/`), so a split path cannot reach them.
 */
export const namesGuardedDir = (command: string): boolean => {
  const paths = pathsIn(command)
  let namesApp = false
  for (const p of paths) {
    for (const [i, part] of p.entries()) {
      const isUnderClaude = p[i - 1]?.toLowerCase() === '.claude'
      if (!(isUnderClaude ? canBe(part, APP) : part.toLowerCase() === APP)) continue
      if (canBeGuarded(p[i + 1]) || (isUnderClaude && p[i + 1] === undefined)) return true
      namesApp ||= isUnderClaude
    }
  }
  return namesApp && paths.some(p => p.some(part => [HINTS, FUNCTIONS].includes(part.toLowerCase())))
}
