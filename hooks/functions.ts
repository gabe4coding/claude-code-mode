// Pure helpers for saved functions: the file format, the checks of a
// proposal, which functions a program uses, and which ones search_tools
// shows. No `$` here, so tests can call them directly.
//
// A function file is markdown: front matter with the name and description,
// then one js code block with an async function expression.

import { oneLine, transferBlock } from './hints'

/** A saved function, or a proposal of one (`why`, only while it is pending). */
export type SavedFunction = { name: string; description: string; code: string; path: string; why?: string }

const NAME = /^[A-Za-z_$][\w$]{0,39}$/
const MAX_CODE_CHARS = 8000
const MAX_DESCRIPTION_CHARS = 200

/** Why a proposal cannot be saved, or undefined. */
export const functionError = (name: string, description: string, code: string): string | undefined => {
  if (!NAME.test(name)) return 'name must be a JavaScript name of 40 characters at most, such as "searchAllIssues"'
  if (description === '' || description.length > MAX_DESCRIPTION_CHARS) return `description is one sentence (${MAX_DESCRIPTION_CHARS} characters at most)`
  if (code.length > MAX_CODE_CHARS) return `code is ${code.length} characters, more than ${MAX_CODE_CHARS}`
  if (!/^async\b/.test(code)) return 'code must be an async function expression, such as async ({ jql }) => { ... }'
  if (code.includes('```')) return 'code must not contain ```'
  return undefined
}

/** The text of a function file. */
export const formatFunction = (f: Omit<SavedFunction, 'path'>): string =>
  [
    '---',
    `name: ${f.name}`,
    `description: ${oneLine(f.description)}`,
    ...(f.why === undefined ? [] : [`why: ${oneLine(f.why)}`]),
    '---',
    '',
    '```js',
    f.code.trim(),
    '```',
    '',
  ].join('\n')

/** A proposal as a block for the model of another session (see canApprove). */
export const functionTransfer = (f: Omit<SavedFunction, 'path'>): string =>
  transferBlock([
    'Propose this code-mode function with save_function. Keep the code as it is.',
    `name: ${f.name}`,
    `description: ${oneLine(f.description)}`,
    ...(f.why === undefined ? [] : [`why: ${oneLine(f.why)}`]),
    'code:',
    '```js',
    f.code.trim(),
    '```',
  ])

/** A function file as a SavedFunction, or undefined when it is not one. */
export const parseFunction = (text: string, path: string): SavedFunction | undefined => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (front === null) return undefined
  const fields = new Map(front[1]!.split('\n').flatMap(line => {
    const at = line.indexOf(':')
    return at < 0 ? [] : [[line.slice(0, at).trim(), line.slice(at + 1).trim()] as const]
  }))
  const code = /```js\n([\s\S]*?)\n```/.exec(text.slice(front[0].length))?.[1]?.trim()
  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  if (code === undefined || functionError(name, description, code) !== undefined) return undefined
  const why = fields.get('why')
  return { name, description, code, path, ...(why === undefined ? {} : { why }) }
}

const USE = /\blib\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'])([A-Za-z_$][\w$]*)\2\s*\])/g

/** The names a program uses as lib.<name>, and the names those functions use in turn. */
export const usedFunctions = (code: string, functions: ReadonlyMap<string, SavedFunction>): string[] => {
  const used = new Set<string>()
  const queue = [code]
  while (queue.length > 0) {
    for (const m of queue.pop()!.matchAll(USE)) {
      const name = m[1] ?? m[3]!
      const f = functions.get(name)
      if (f === undefined || used.has(name)) continue
      used.add(name)
      queue.push(f.code)
    }
  }
  return [...used]
}

/** The parameters of a function's code, as its signature shows them: `({ jql, cloudId })`. */
export const signatureOf = (code: string): string => {
  const params = /^async\s*(?:function\b[^(]*)?(\([^)]*\)|[A-Za-z_$][\w$]*)/.exec(code)?.[1] ?? '(args)'
  return oneLine(params.startsWith('(') ? params : `(${params})`)
}

/**
 * The functions for a search_tools result: those whose code names one of
 * the found tools, and those whose name or description holds a word of the
 * query. An empty query gives all of them.
 */
export const functionsFor = (functions: readonly SavedFunction[], tools: readonly string[], query: string): SavedFunction[] => {
  const wanted = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1)
  return functions.filter(f =>
    wanted.length === 0 ||
    tools.some(t => f.code.includes(t)) ||
    wanted.some(w => f.name.toLowerCase().includes(w) || f.description.toLowerCase().includes(w)))
}

// Above this many line pairs between the equal first and last lines, codeDiff
// shows all old lines, then all new ones: the table of common lines grows
// with the product of the two sizes.
const MAX_DIFF_CELLS = 250_000

/**
 * The change from one function's code to another, as one unified-diff hunk
 * with every line, so the card shows the whole new code with its changes.
 */
export const codeDiff = (before: string, after: string): string => {
  const a = before.split('\n')
  const b = after.split('\n')
  const head = `@@ -1,${a.length} +1,${b.length} @@`
  // The equal lines at the start and at the end need no table.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const same = (lines: string[]) => lines.map(l => ` ${l}`)
  const x = a.slice(start, a.length - end)
  const y = b.slice(start, b.length - end)
  const middle: string[] = []
  if (x.length * y.length > MAX_DIFF_CELLS) {
    middle.push(...x.map(l => `-${l}`), ...y.map(l => `+${l}`))
  } else {
    // common[i][j]: the most lines that x[i..] and y[j..] have in common, in order.
    const common = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1))
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        common[i]![j] = x[i] === y[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        middle.push(` ${x[i++]}`)
        j++
      } else if (i < x.length && (j === y.length || common[i + 1]![j]! >= common[i]![j + 1]!)) middle.push(`-${x[i++]}`)
      else middle.push(`+${y[j++]}`)
    }
  }
  return [head, ...same(a.slice(0, start)), ...middle, ...same(a.slice(a.length - end))].join('\n')
}

/** The saved functions of a run that an error came from: a frame in their file, or a compile error. */
export const failedFunctions = (message: string, names: readonly string[]): string[] =>
  names.filter(n => message.includes(`lib/${n}.js:`) || message.includes(`lib.${n} does not compile`))

/** The note after a run that failed in a saved function. */
export const functionFixNudge = (names: readonly string[]): string =>
  names.length === 0 ? '' : `## A saved function failed\n\nThe error comes from ${names.map(n => `lib.${n}`).join(', ')}. If its code is wrong now (a tool or its result changed), read it with return lib.<name>.toString(), fix it, and propose the fix with save_function under the same name.`

/** The functions section of a search_tools result. */
export const formatFunctions = (functions: readonly SavedFunction[]): string =>
  functions.length === 0 ? '' : [
    '## Saved functions',
    '',
    'Call them in run_code as await lib.<name>(args). The person approved each one.',
    ...functions.map(f => `- lib.${f.name}${signatureOf(f.code)}: ${f.description}`),
  ].join('\n')

export const SAVE_FUNCTION_DESCRIPTION = `Propose a program part as a saved function, for a task that comes back. Programs in later sessions then call it as await lib.<name>(args), and search_tools lists it. The function has no effect until the person reads the code and approves it.

Save only code that worked in run_code in this session. It must be an async function expression with one argument and no data of the person in it: pass ids, keys and queries as arguments.

To change a saved function, read its code with return lib.<name>.toString() in run_code, then propose the new code under the same name.`
