import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import { MARK } from '../hooks/protocol'
import { TRANSFER_TEXT, pendingPathOf } from '../hooks/hints'
import {
  codeDiff,
  failedFunctions,
  formatFunction,
  formatFunctions,
  functionError,
  functionFixNudge,
  functionTransfer,
  functionsFor,
  parseFunction,
  signatureOf,
  usedFunctions,
  type SavedFunction,
} from '../hooks/functions'

const HOME = '/home/test'
const DIR = `${HOME}/.claude/code-mode/functions`
const CODE = 'async ({ cloudId, jql }) => {\n  const r = await call("mcp__jira__search", { cloudId, jql })\n  return r.issues\n}'
const SAVE = 'mcp__code-mode__save_function'

const fn = (name: string, code: string, description = `Does ${name}.`): SavedFunction => ({ name, description, code, path: `${DIR}/${name}.md` })

// A fake file system and session beneath the plugin, as in hints.test.ts.
const fakeHome = (on: On, files: Record<string, string>) => {
  const written: Record<string, string> = {}
  const removed: string[] = []
  const env: Record<string, string> = {}
  const all = () => ({ ...files, ...written })
  on('env.get', ($, e) => ({ value: env[e.name] ?? HOME }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.exists', ($, e) => ({ value: Object.keys(all()).some(p => p === e.path || p.startsWith(`${e.path}/`)) }))
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const names = new Set(Object.keys(all()).filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(p => p.slice(prefix.length)))
    return { value: [...names].map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($, e) => (all()[e.path] === undefined ? { deny: `ENOENT ${e.path}` } : { value: all()[e.path]! }))
  on('fs.write', ($, e) => ((written[e.path] = e.text), { value: undefined }))
  on('process.run', ($, e) => {
    if (e.argv[0] === 'rm') {
      const path = String(e.argv.at(-1))
      removed.push(path)
      delete files[path]
      delete written[path]
    }
    return { value: { exitCode: 0, stdout: e.argv[0] === 'mktemp' ? '/tmp/cm-test\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.list', () => ({ value: [{ name: 'mcp__jira__search', description: 'Search issues', mcp: true }, { name: 'mcp__mail__send', description: 'Send mail', mcp: true }] }))
  return { written, removed, env }
}

const textOf = (r: { result?: unknown; deny?: string; text?: string }): string =>
  r.deny !== undefined ? `DENY ${r.deny}` : typeof r.result === 'string' ? r.result : (r.text ?? JSON.stringify(r.result))

describe('function files', () => {
  test('functionError accepts an async function expression with a name and a description', () => {
    expect(functionError('searchAll', 'Every issue.', CODE)).toBe(undefined)
    expect(functionError('search-all', 'Every issue.', CODE)).toContain('JavaScript name')
    expect(functionError('searchAll', '', CODE)).toContain('description')
    expect(functionError('searchAll', 'Every issue.', '({ jql }) => 1')).toContain('async function expression')
    expect(functionError('searchAll', 'Every issue.', 'async () => "```"')).toContain('```')
    expect(functionError('searchAll', 'Every issue.', `async () => ${'1'.repeat(8001)}`)).toContain('more than 8000')
  })

  test('formatFunction and parseFunction give the same function back', () => {
    const text = formatFunction({ name: 'searchAll', description: 'Every\nissue.', code: CODE, why: 'Weekly report.' })
    expect(text).toBe(`---\nname: searchAll\ndescription: Every issue.\nwhy: Weekly report.\n---\n\n\`\`\`js\n${CODE}\n\`\`\`\n`)
    expect(parseFunction(text, '/f.md')).toEqual({ name: 'searchAll', description: 'Every issue.', code: CODE, path: '/f.md', why: 'Weekly report.' })
    expect(parseFunction('---\nname: x\n---\nno code', '/f.md')).toBe(undefined)
    expect(parseFunction(text.replace('searchAll', 'bad name'), '/f.md')).toBe(undefined)
  })

  test('usedFunctions follows lib.<name> into the functions it names', () => {
    const all = new Map([
      ['a', fn('a', 'async () => lib.b()')],
      ['b', fn('b', 'async () => lib["c"]()')],
      ['c', fn('c', 'async () => 1')],
      ['d', fn('d', 'async () => lib.a()')],
    ])
    expect(usedFunctions('return await lib.a({}) + calllib.d()', all).sort()).toEqual(['a', 'b', 'c'])
    expect(usedFunctions('return lib.missing()', all)).toEqual([])
  })

  test('signatureOf shows the parameters', () => {
    expect(signatureOf(CODE)).toBe('({ cloudId, jql })')
    expect(signatureOf('async args => args')).toBe('(args)')
    expect(signatureOf('async function all(a,\n b) {}')).toBe('(a, b)')
  })

  test('functionsFor finds a function by a tool it calls or by a query word', () => {
    const all = [fn('searchAll', CODE, 'Every issue for a query.'), fn('mailDigest', 'async () => 1', 'A digest of mail.')]
    expect(functionsFor(all, ['mcp__jira__search'], 'jira').map(f => f.name)).toEqual(['searchAll'])
    expect(functionsFor(all, [], 'digest').map(f => f.name)).toEqual(['mailDigest'])
    expect(functionsFor(all, [], '').map(f => f.name)).toEqual(['searchAll', 'mailDigest'])
    expect(formatFunctions(all.slice(0, 1))).toBe(
      '## Saved functions\n\nCall them in run_code as await lib.<name>(args). The person approved each one.\n- lib.searchAll({ cloudId, jql }): Every issue for a query.',
    )
    expect(formatFunctions([])).toBe('')
  })

  test('codeDiff shows every line, with the removed lines before the added ones', () => {
    expect(codeDiff('a\nb\nc', 'a\nB\nc\nd')).toBe('@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d')
    expect(codeDiff('a', 'a')).toBe('@@ -1,1 +1,1 @@\n a')
    // Too large for the table of common lines: all old lines, then all new ones,
    // between the equal first and last lines.
    const lines = (p: string) => Array.from({ length: 600 }, (_, i) => `${p}${i}`)
    const diff = codeDiff(['top', ...lines('a'), 'end'].join('\n'), ['top', ...lines('b'), 'end'].join('\n')).split('\n')
    expect(diff.slice(0, 3)).toEqual(['@@ -1,602 +1,602 @@', ' top', '-a0'])
    expect(diff.slice(601, 604)).toEqual(['-a599', '+b0', '+b1'])
    expect(diff.at(-1)).toBe(' end')
  })

  test('failedFunctions finds the saved functions an error came from', () => {
    const stack = 'Error: boom\n    at eval (lib/page.js:3:11)\n    at async code.js:1:14'
    expect(failedFunctions(stack, ['page', 'searchAll'])).toEqual(['page'])
    expect(failedFunctions('SyntaxError: lib.searchAll does not compile: x', ['page', 'searchAll'])).toEqual(['searchAll'])
    expect(functionFixNudge([])).toBe('')
    expect(functionFixNudge(['page'])).toContain('The error comes from lib.page.')
  })
})

describe('save_function', () => {
  const PENDING = `${DIR}/pending/searchAll--toolu_1.md`
  const OUTPUT = `Proposed the function lib.searchAll. It has no effect until the person reads it and approves it in the band above the prompt. Tell the person.\npending: ${PENDING}`
  const PROPOSAL = formatFunction({ name: 'searchAll', description: 'Every issue.', code: CODE, why: 'Weekly report.' })
  const row = {
    plugin: 'code-mode', surface: 'terminal' as const, component: 'ToolResult' as const, requestId: 'toolu_1',
    props: { tool_use_id: 'toolu_1', tool: SAVE, output: OUTPUT, isErrored: false },
  }
  const band = {
    plugin: 'code-mode', surface: 'terminal' as const, component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 90 } as never,
  }

  test('writes a proposal, and nothing that loads', async ($, on) => {
    const fs = fakeHome(on, {})
    const r = await $.tool.call({ tool: SAVE, tool_use_id: 'toolu_1', name: 'searchAll', description: 'Every issue.', code: CODE, why: 'Weekly report.' } as never)
    expect(textOf(r)).toBe(OUTPUT)
    expect(fs.written[PENDING]).toBe(PROPOSAL)
    expect(Object.keys(fs.written)).toEqual([PENDING])
    const bad = await $.tool.call({ tool: SAVE, tool_use_id: 'toolu_2', name: 'x', description: 'X.', code: 'return 1', why: 'W.' } as never)
    expect(textOf(bad)).toContain('Error: code must be an async function expression')
  })

  test('in Cowork, writes the proposal and gives the code in a block to paste elsewhere', async ($, on) => {
    const fs = fakeHome(on, {})
    fs.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
    const r = textOf(await $.tool.call({ tool: SAVE, tool_use_id: 'toolu_1', name: 'searchAll', description: 'Every issue.', code: CODE, why: 'Weekly report.' } as never))
    const block = functionTransfer({ name: 'searchAll', description: 'Every issue.', code: CODE, why: 'Weekly report.' })
    expect(block).toBe(`\`\`\`\`text\nPropose this code-mode function with save_function. Keep the code as it is.\nname: searchAll\ndescription: Every issue.\nwhy: Weekly report.\ncode:\n\`\`\`js\n${CODE}\n\`\`\`\n\`\`\`\``)
    expect(r).toBe(`Proposed the function lib.searchAll. ${TRANSFER_TEXT}\n\n${block}\npending: ${PENDING}`)
    expect(pendingPathOf(r)).toBe(PENDING)
    expect(fs.written[PENDING]).toBe(PROPOSAL)
  })

  test('the row shows the code, and Approve saves the function without its reason', async ($, on) => {
    mock.store(on)
    const fs = fakeHome(on, { [PENDING]: PROPOSAL })
    const ui = await $.ui.mount(row)
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('`lib.searchAll({ cloudId, jql })`')
    expect(drawn).toContain('return r.issues')
    await ui.press({ key: 'approve' })
    expect(fs.written[`${DIR}/searchAll.md`]).toBe(formatFunction({ name: 'searchAll', description: 'Every issue.', code: CODE }))
    expect(fs.removed).toEqual([PENDING])
    expect(JSON.stringify(await ui.drawn())).toContain('Function saved')
  })

  test('an Approve that cannot save the function fails and keeps the proposal', async ($, on) => {
    mock.store(on)
    const files: Record<string, string> = { [PENDING]: PROPOSAL }
    const fs = fakeHome(on, files)
    const ui = await $.ui.mount(row)
    // the file changed after the drawing, and is no function now
    files[PENDING] = 'not a function'
    await ui.press({ key: 'approve' }).catch(() => undefined)
    expect(fs.removed).toEqual([])
    expect(fs.written).toEqual({})
  })

  test('a proposal with the name of a saved function shows the change from its code', async ($, on) => {
    mock.store(on)
    const old = CODE.replace('return r.issues', 'return r')
    const fs = fakeHome(on, { [PENDING]: PROPOSAL, [`${DIR}/searchAll.md`]: formatFunction({ name: 'searchAll', description: 'Old.', code: old }) })
    const ui = await $.ui.mount(row)
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('**Change of a saved function**')
    expect(drawn).toContain('Now: Old.')
    expect(drawn).toContain(JSON.stringify(codeDiff(old, CODE)).slice(1, -1))
    await ui.press({ key: 'approve' })
    expect(fs.written[`${DIR}/searchAll.md`]).toBe(formatFunction({ name: 'searchAll', description: 'Every issue.', code: CODE }))
  })

  test('the band lists function proposals with the hint proposals', async ($, on) => {
    mock.store(on)
    const fs = fakeHome(on, { [PENDING]: PROPOSAL })
    const ui = await $.ui.mount(band)
    expect(JSON.stringify(await ui.drawn())).toContain('1 proposal for code mode: 1 function')
    await ui.press({ key: 'review' })
    await ui.press({ key: 'discard-0' })
    expect(fs.removed).toEqual([PENDING])
    expect(fs.written[`${DIR}/searchAll.md`]).toBe(undefined)
  })
})

describe('saved functions in programs', () => {
  const files = {
    [`${DIR}/searchAll.md`]: formatFunction({ name: 'searchAll', description: 'Every issue.', code: 'async a => lib.page(a)' }),
    [`${DIR}/page.md`]: formatFunction({ name: 'page', description: 'One page.', code: CODE }),
    [`${DIR}/other.md`]: formatFunction({ name: 'other', description: 'Something else.', code: 'async () => 1' }),
  }

  test('run_code gives the sandbox only the functions the program uses', async ($, on) => {
    fakeHome(on, { ...files })
    let input: { lib?: Record<string, string> } = {}
    on('process.spawn', async function* ($, e): AsyncGenerator<ProcessSpawnChunk, { value: ProcessSpawnResult }> {
      input = JSON.parse(e.input ?? '{}')
      yield { stream: 'stdout', text: `${MARK}${JSON.stringify({ t: 'done', value: '1', logs: [] })}\n` }
      return { value: { code: 0, signal: null } }
    })
    await $.tool.call({ tool: 'mcp__code-mode__run_code', code: 'return await lib.searchAll({ jql: "x" })' })
    expect(Object.keys(input.lib ?? {}).sort()).toEqual(['page', 'searchAll'])
    expect(input.lib?.page).toBe(CODE)
  })

  test('a run that fails in a saved function asks for a fix, once per function in a session', async ($, on) => {
    fakeHome(on, { ...files })
    on('process.spawn', async function* (): AsyncGenerator<ProcessSpawnChunk, { value: ProcessSpawnResult }> {
      yield { stream: 'stdout', text: `${MARK}${JSON.stringify({ t: 'error', message: 'TypeError: x is undefined\n    at eval (lib/page.js:2:9)', logs: [] })}\n` }
      return { value: { code: 0, signal: null } }
    })
    const run = async () => textOf(await $.tool.call({ tool: 'mcp__code-mode__run_code', code: 'return await lib.searchAll({ jql: "x" })' }))
    expect(await run()).toContain('## A saved function failed\n\nThe error comes from lib.page.')
    expect(await run()).not.toContain('A saved function failed')
  })

  test('search_tools lists the functions that call a found tool', async ($, on) => {
    fakeHome(on, { ...files })
    const text = textOf(await $.tool.call({ tool: 'mcp__code-mode__search_tools', query: 'search' }))
    expect(text).toContain('## Saved functions')
    expect(text).toContain('- lib.page({ cloudId, jql }): One page.')
    expect(text).toContain('- lib.searchAll(a): Every issue.')
    expect(text).not.toContain('lib.other')
  })
})
