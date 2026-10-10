import { describe, expect, test, type Engine } from 'claude-code/testing'
import type { On, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import {
  MARK,
  callKey,
  charCount,
  extractDeclaration,
  hintNudge,
  isCallable,
  isSessionResult,
  mcpReply,
  rankTools,
  savedResultOf,
  savedReply,
  shapeOf,
  splitToolName,
  takeMessages,
  toValue,
} from '../hooks/protocol'

const RUN = 'mcp__code-mode__run_code'

// No `ceiling` here: the engine sets it from the tool and drops a hook's own,
// so the organization-ceiling path cannot be faked in this kit.
type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string }

// A fake MCP server beneath the plugin: echo returns its args, fail errors.
// `verdicts` stands for the permission rules (allow when a tool is not listed).
// Each call is recorded with its path: `tool.call` or `mcp.call`.
const fakeServer = (on: On, verdicts: Record<string, Verdict> = {}) => {
  const paths: string[] = []
  on('tool.check', ($, e) => verdicts[e.tool] ?? { decision: 'allow' })
  on('tool.call', { tool: 'mcp__fake__echo' }, ($, e) => {
    paths.push('tool.call')
    const { tool, tool_use_id, ...args } = e
    return { result: JSON.stringify({ echoed: args }) }
  })
  on('tool.call', { tool: 'mcp__fake__fail' }, () => ({ deny: 'server said no' }))
  on('mcp.call', ($, e) => {
    paths.push('mcp.call')
    if (e.tool === 'fail') return { value: { content: [{ type: 'text', text: 'server error' }], isError: true } }
    return { value: { content: [{ type: 'text', text: JSON.stringify({ echoed: e.args, server: e.server }) }], isError: false } }
  })
  return { paths }
}

const textOf = (r: { result?: unknown; deny?: string; text?: string }): string =>
  r.deny !== undefined ? `DENY ${r.deny}` : typeof r.result === 'string' ? r.result : (r.text ?? JSON.stringify(r.result))

describe('protocol', () => {
  test('takeMessages keeps partial lines and skips foreign output', () => {
    const line = `${MARK}${JSON.stringify({ t: 'call', id: 1, tool: 'mcp__a__b', args: {} })}\n`
    const { messages, rest } = takeMessages(`noise\n${line}${MARK}{"t":"do`)
    expect(messages).toEqual([{ t: 'call', id: 1, tool: 'mcp__a__b', args: {} }])
    expect(rest).toBe(`${MARK}{"t":"do`)
  })

  test('isCallable allows MCP tools but not this plugin or built-ins', () => {
    expect(isCallable('mcp__linear__list', 'code-mode')).toBe(true)
    expect(isCallable('mcp__code-mode__run_code', 'code-mode')).toBe(false)
    expect(isCallable('Bash', 'code-mode')).toBe(false)
  })

  test('toValue prefers structured content, then JSON text', () => {
    expect(toValue({ structuredContent: { a: 1 } }, 'x')).toEqual({ a: 1 })
    expect(toValue(undefined, '[1,2]')).toEqual([1, 2])
    expect(toValue(undefined, 'plain')).toBe('plain')
  })

  test('splitToolName splits at the first double underscore', () => {
    expect(splitToolName('mcp__claude_ai_Jira__get_issue')).toEqual({ server: 'claude_ai_Jira', name: 'get_issue' })
    expect(splitToolName('mcp__fcef2cd1-7ad6__atlassianUserInfo')).toEqual({ server: 'fcef2cd1-7ad6', name: 'atlassianUserInfo' })
    expect(splitToolName('Bash')).toBe(undefined)
    expect(splitToolName('mcp__server__')).toBe(undefined)
  })

  test('mcpReply joins text blocks and parses JSON', () => {
    expect(mcpReply({ content: [{ type: 'text', text: '{"a":1}' }], isError: false })).toEqual({ ok: true, value: { a: 1 } })
    expect(mcpReply({ content: [{ type: 'text', text: 'x' }], isError: false, structuredContent: { b: 2 } })).toEqual({ ok: true, value: { b: 2 } })
    expect(mcpReply({ content: [{ type: 'text', text: 'bad' }], isError: true })).toEqual({ ok: false, error: 'bad' })
  })

  test('savedResultOf reads both notes of a saved result', () => {
    const S = 's-1'
    const mcp = (format: string, tail = '') =>
      `Error: result (60,000 characters) exceeds maximum allowed tokens. Output has been saved to /h/${S}/tool-results/mcp-fake-big-1.txt.\nFormat: ${format}\nUse jq …${tail}`
    expect(savedResultOf(mcp('Plain text'), S)).toEqual({ path: `/h/${S}/tool-results/mcp-fake-big-1.txt`, format: 'text', isCut: false })
    expect(savedResultOf(mcp('JSON with schema: {}'), S)?.format).toBe('json')
    expect(savedResultOf(mcp('JSON array'), S)?.format).toBe('blocks')
    expect(savedResultOf(mcp('JSON', '\nNote: the output exceeded the persist byte limit; …'), S)?.isCut).toBe(true)
    const output = `<persisted-output>\nOutput too large (61.2KB). Full output saved to: /h/${S}/tool-results/b.txt\n\nPreview`
    expect(savedResultOf(output, S)).toEqual({ path: `/h/${S}/tool-results/b.txt`, format: 'text', isCut: false })
    // A path with a space works in the known wordings.
    expect(savedResultOf(mcp('Plain text').replace('/h/', '/h a/'), S)?.path).toBe(`/h a/${S}/tool-results/mcp-fake-big-1.txt`)
  })

  test('savedResultOf finds a note in another wording by its path', () => {
    const S = 's-1'
    expect(savedResultOf(`Result too big; stored at /h/${S}/tool-results/r.json.`, S)).toEqual({
      path: `/h/${S}/tool-results/r.json`,
      format: 'unknown',
      isCut: false,
    })
    // The same path twice is one file; two files, another session or a long result are not a note.
    expect(savedResultOf(`See /h/${S}/tool-results/r.json, then jq '/h/${S}/tool-results/r.json'`, S)?.path).toBe(`/h/${S}/tool-results/r.json`)
    expect(savedResultOf(`/h/${S}/tool-results/a.txt and /h/${S}/tool-results/b.txt`, S)).toBe(undefined)
    expect(savedResultOf('stored at /h/s-2/tool-results/r.json', S)).toBe(undefined)
    expect(savedResultOf(`stored at /h/${S}/tool-results/r.json ${'x'.repeat(9000)}`, S)).toBe(undefined)
    expect(savedResultOf(`stored at /h/${S}/tool-results/r.json`, '')).toBe(undefined)
    expect(savedResultOf('{"a":1}', S)).toBe(undefined)
  })

  test('isSessionResult accepts only this session\'s tool-results files', () => {
    expect(isSessionResult('/h/.claude/projects/p/s-1/tool-results/a.txt', 's-1')).toBe(true)
    expect(isSessionResult('/h/.claude/projects/p/s-2/tool-results/a.txt', 's-1')).toBe(false)
    expect(isSessionResult('/h/.ssh/id_rsa', 's-1')).toBe(false)
    expect(isSessionResult('/h/s-1/tool-results/x/a.txt', 's-1')).toBe(false)
    expect(isSessionResult('/h/tool-results/a.txt', '')).toBe(false)
  })

  test('savedReply parses the file as its format says', () => {
    const value = (v: unknown) => ({ ok: true, value: v })
    expect(savedReply('text', '[1,2]')).toEqual(value([1, 2]))
    expect(savedReply('text', 'plain')).toEqual(value('plain'))
    expect(savedReply('json', '{"a":1}')).toEqual(value({ a: 1 }))
    expect(savedReply('blocks', JSON.stringify([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]))).toEqual(value('one\ntwo'))
    expect(savedReply('unknown', JSON.stringify([{ type: 'text', text: '[3]' }]))).toEqual(value([3]))
    expect(savedReply('unknown', '[INFO] plain text')).toEqual(value('[INFO] plain text'))
    // Data with a `type` field of its own is not content blocks.
    const messages = [{ type: 'message', text: 'hi' }]
    expect(savedReply('blocks', JSON.stringify(messages))).toEqual(value(messages))
    expect(savedReply('unknown', JSON.stringify(messages))).toEqual(value(messages))
    // JSON that does not parse was cut.
    expect(savedReply('json', '{"cut": ')).toEqual({ ok: false, error: 'the saved result is not whole' })
  })

  test('hintNudge names the servers that work now and the searches that missed', () => {
    expect(hintNudge([], [])).toBe('')
    const text = hintNudge(['fake'], ['jira ticket'])
    expect(text).toContain('Calls to fake failed earlier and work now.')
    expect(text).toContain('search_tools found nothing for "jira ticket".')
    expect(text).toContain('add_hint')
    expect(hintNudge([], ['x'])).not.toContain('Calls to')
  })

  test('shapeOf shows keys, array lengths and nesting, not values', () => {
    const value = { messages: [{ ts: '1', text: 'secret', user: 'u' }, { ts: '2', reactions: [{ name: 'x' }] }], next: 'c', total: 2 }
    expect(shapeOf(value)).toBe('{messages: [2 × {ts, text, user, reactions: [1]}], next, total}')
    expect(shapeOf(value)).not.toContain('secret')
    expect(shapeOf([])).toBe('[]')
    expect(shapeOf('a\nb')).toBe('text, 2 lines')
    expect(shapeOf(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i % 2 ? i : String(i)])))).toBe('{k0, k1, k2, k3, k4, k5, k6, k7, …+2}')
  })

  test('shapeOf hides keys that are data', () => {
    expect(shapeOf({ 'alice@example.com': { n: 1 } })).toBe('{1 key}')
    expect(shapeOf({ 'OPS-17': 1, 'OPS-42': 2 })).toBe('{2 keys}')
    expect(shapeOf({ U0001: { name: 'a' }, U0002: { name: 'b' } })).toBe('{2 keys}')
    expect(shapeOf({ checkout: 1140, search: 1500, payments: 1940 })).toBe('{3 keys}')
    expect(shapeOf({ bySvc: { checkout: 1, search: 2, payments: 3 }, total: 6 })).toBe('{bySvc: {3 keys}, total}')
    expect(shapeOf([{ id: '1', name: 'x', email: 'y' }, { id: '2', name: 'z', email: 'w' }])).toBe('[2 × {id, name, email}]')
    expect(shapeOf({ id: '1', name: 'x', email: 'y' })).toBe('{3 keys}')
    expect(shapeOf({ ok: true, total: 2, items: [] })).toBe('{ok, total, items: []}')
  })

  test('callKey ignores the order of keys', () => {
    expect(callKey('mcp__x__y', { a: 1, b: { c: 2, d: 3 } })).toBe(callKey('mcp__x__y', { b: { d: 3, c: 2 }, a: 1 }))
    expect(callKey('mcp__x__y', { a: 1 })).not.toBe(callKey('mcp__x__y', { a: 2 }))
  })

  test('charCount is short', () => {
    expect([charCount(812), charCount(18_400), charCount(1_230_000)]).toEqual(['812', '18k', '1.2M'])
  })

  test('rankTools scores name hits above description hits', () => {
    const tools = [
      { name: 'mcp__a__list_issues', description: 'Lists things' },
      { name: 'mcp__a__other', description: 'Works on issues' },
      { name: 'mcp__a__unrelated', description: 'Nothing' },
    ]
    expect(rankTools(tools, 'issues', 10).map(t => t.name)).toEqual(['mcp__a__list_issues', 'mcp__a__other'])
    expect(rankTools(tools, '', 2).length).toBe(2)
  })

  test('extractDeclaration finds one entry of McpToolInputs', () => {
    const dts = [
      "declare module 'claude-code' {",
      '  interface McpToolInputs {',
      '    "mcp__x__send": {',
      '      /** Who gets it */',
      '      to: string',
      '      opts?: { cc?: string[] }',
      '    }',
      '    "mcp__x__other": { a: number }',
      '  }',
      '}',
    ].join('\n')
    expect(extractDeclaration(dts, 'mcp__x__send')).toBe('{\n  /** Who gets it */\n  to: string\n  opts?: { cc?: string[] }\n}')
    expect(extractDeclaration(dts, 'mcp__x__other')).toBe('{ a: number }')
    expect(extractDeclaration(dts, 'mcp__x__missing')).toBe(undefined)
  })
})

// A fake host beneath the plugin. The test engine has no Node, so the fake
// sandbox does not run JavaScript: the "code" is a JSON scenario
// ({ calls: [{ tool, args }] }). The fake runner emits those calls, waits for
// the reply files the plugin writes, and returns the replies as its value.
// tests/runner.integration.mjs covers the real sandbox under Node.
const XDIR = '/tmp/code-mode-test'
const fakeHost = (on: On) => {
  const waiters = new Map<string, (text: string) => void>()
  const removed: string[] = []
  const spawned: string[][] = []
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'rm') removed.push(String(e.argv[2]))
    return { value: { exitCode: 0, stdout: e.argv[0] === 'mktemp' ? `${XDIR}\n` : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const written: Record<string, string> = {}
  on('fs.write', ($, e) => {
    written[e.path] = e.text
    waiters.get(e.path)?.(e.text)
    return { value: undefined }
  })
  on('process.spawn', async function* ($, e): AsyncGenerator<ProcessSpawnChunk, { value: ProcessSpawnResult }> {
    spawned.push([...e.argv])
    const { code } = JSON.parse(e.input ?? '{}') as { code: string }
    const { calls, returns } = JSON.parse(code) as { calls: Step[]; returns?: unknown }
    const replies = calls.map((_, i) => new Promise<string>(resolve => waiters.set(`${XDIR}/r${i + 1}.json`, resolve)))
    const lines = calls.map((c, i) =>
      `${MARK}${JSON.stringify('recall' in c ? { t: 'recall', id: i + 1, ref: c.recall } : { t: 'call', id: i + 1, tool: c.tool, args: c.args })}\n`)
    // Split the output mid-line to check the plugin's line buffering.
    const out = `log line from node\n${lines.join('')}`
    const cut = Math.floor(out.length / 2)
    yield { stream: 'stdout', text: out.slice(0, cut) }
    yield { stream: 'stdout', text: out.slice(cut) }
    const got = (await Promise.all(replies)).map(t => JSON.parse(t))
    const value = returns === undefined ? got : returns
    yield { stream: 'stdout', text: `${MARK}${JSON.stringify({ t: 'done', value: JSON.stringify(value), logs: ['hello'] })}\n` }
    return { value: { code: 0, signal: null } }
  })
  return { removed, spawned, ran, written }
}

type Step = { tool: string; args: Record<string, unknown> } | { recall: number }

const scenario = (...calls: ({ tool: string; args?: Record<string, unknown> } | { recall: number })[]) =>
  JSON.stringify({ calls: calls.map(c => ('recall' in c ? c : { args: {}, ...c })) })

// A scenario whose program returns `returns` instead of the replies.
const returning = (returns: unknown, ...calls: { tool: string; args?: Record<string, unknown> }[]) =>
  JSON.stringify({ calls: calls.map(c => ({ args: {}, ...c })), returns })

describe('run_code', () => {
  test('routes sandbox calls to MCP tools and returns the value', async ($, on) => {
    fakeServer(on)
    const host = fakeHost(on)
    const r = await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo', args: { n: 1 } }, { tool: 'mcp__fake__echo', args: { n: 2 } }) })
    const text = textOf(r)
    expect(text).toContain('"ok": true')
    expect(text).toContain('"n": 1')
    expect(text).toContain('"n": 2')
    expect(text).toContain('hello')
    expect(text).toContain('2 MCP calls')
    expect(host.removed).toEqual([XDIR])
  })

  test('the sandbox starts the runner by its real path', async ($, on) => {
    fakeServer(on)
    const host = fakeHost(on)
    on('fs.stat', ($, e) => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: true, realPath: `/real${e.path}` } }))
    await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo' }) })
    const runner = host.spawned[0]!.find(a => a.endsWith('/runtime/runner.mjs'))
    expect(runner?.startsWith('/real/')).toBe(true)
  })

  test('the temp dir template ends in XXXXXX, as GNU mktemp needs', async ($, on) => {
    fakeServer(on)
    const host = fakeHost(on)
    await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo' }) })
    const mktemp = host.ran.find(a => a[0] === 'mktemp')
    expect(mktemp?.at(-1)?.endsWith('XXXXXX')).toBe(true)
  })

  test('a denied tool call becomes an error reply', async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    const r = await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__fail' }) })
    expect(textOf(r)).toContain('denied: server said no')
  })

  test('only MCP tools can be called, and not run_code itself', async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    const r = await $.tool.call({ tool: RUN, code: scenario({ tool: 'Bash', args: { command: 'id' } }, { tool: RUN }) })
    const text = textOf(r)
    expect(text).toContain('not \\"Bash\\"')
    expect(text).toContain('not \\"mcp__code-mode__run_code\\"')
  })

  test('empty code is refused before any process starts', async $ => {
    const r = await $.tool.call({ tool: RUN, code: '   ' })
    expect(textOf(r)).toContain('code is empty')
  })
})

describe('search_tools', () => {
  test('ranks MCP tools and adds their argument types', async ($, on) => {
    on('tool.list', () => ({ value: [
      { name: 'mcp__mail__send', description: 'Send an email\nMore text', mcp: true },
      { name: 'mcp__mail__list', description: 'List emails', mcp: true },
      { name: RUN, description: 'own tool', mcp: true },
      { name: 'Bash', description: 'send commands', mcp: false },
    ] }))
    const dts = 'interface McpToolInputs {\n  "mcp__mail__send": { to: string }\n}'
    on('fs.stat', () => ({ value: { kind: 'file', size: dts.length, mtimeMs: 1, isLink: false } }))
    on('fs.read', () => ({ value: dts }))
    const r = await $.tool.call({ tool: 'mcp__code-mode__search_tools', query: 'send email' })
    const text = textOf(r)
    expect(text).toContain('### mcp__mail__send\nSend an email\nargs: { to: string }')
    expect(text).toContain('mcp__mail__list')
    expect(text).not.toContain('Bash')
    expect(text).not.toContain(RUN)
  })

  test('reads the argument types again only when their file changes', async ($, on) => {
    on('tool.list', () => ({ value: [{ name: 'mcp__mail__send', description: 'Send an email', mcp: true }] }))
    let mtimeMs = 1
    let reads = 0
    on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs, isLink: false } }))
    on('fs.read', () => (reads++, { value: `interface McpToolInputs {\n  "mcp__mail__send": { v: ${mtimeMs} }\n}` }))
    const search = async () => textOf(await $.tool.call({ tool: 'mcp__code-mode__search_tools', query: 'send' }))
    await search()
    expect(await search()).toContain('args: { v: 1 }')
    expect(reads).toBe(1)
    mtimeMs = 2
    expect(await search()).toContain('args: { v: 2 }')
    expect(reads).toBe(2)
  })
})

describe('the debug log', () => {
  test('a tool that fails says why in the debug log', async ($, on) => {
    const logs: string[] = []
    on('ui.log', ($, e) => (logs.push(`${e.to}: ${e.text}`), { value: undefined }))
    on('tool.list', () => ({ deny: 'no tool list' }))
    const r = await $.tool.call({ tool: 'mcp__code-mode__search_tools', query: 'send' })
    expect(textOf(r)).toContain('search_tools failed; see the debug log')
    expect(logs.some(l => l.startsWith('debug: code-mode: search_tools failed (throw): ') && l.includes('no tool list'))).toBe(true)
  })
})

describe('saved results', () => {
  const SESSION = 'sess-1'
  const DIR = `/home/u/.claude/projects/p/${SESSION}/tool-results`
  const note = (path: string, format = 'JSON with schema: {}') =>
    `Error: result (60,000 characters) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: ${format}\nUse jq …`

  // A server whose result Claude Code saved to a file, and the files there.
  // `links` maps a path to the file it leads to.
  const savedServer = (on: On, result: string, files: Record<string, string>, links: Record<string, string> = {}) => {
    on('tool.check', () => ({ decision: 'allow' }))
    on('tool.call', { tool: 'mcp__fake__big' }, () => ({ result }))
    on('session.id', () => ({ value: SESSION }))
    on('fs.stat', ($, e) => {
      const real = links[e.path] ?? e.path
      if (!(real in files)) throw new Error('ENOENT')
      return { value: { kind: 'file', size: files[real]!.length, mtimeMs: 0, isLink: real !== e.path, realPath: real } }
    })
    on('fs.read', ($, e) => ({ value: files[e.path]! }))
  }

  test('the program gets the saved file, not the note', async ($, on) => {
    const path = `${DIR}/mcp-fake-big-1.txt`
    savedServer(on, note(path), { [path]: JSON.stringify({ messages: [{ text: 'hi' }] }) })
    fakeHost(on)
    const text = textOf(await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__big' }) }))
    expect(text).toContain('"text": "hi"')
    expect(text).not.toContain('exceeds maximum allowed tokens')
  })

  test('a note in another wording still gives the saved file', async ($, on) => {
    const path = `${DIR}/mcp-fake-big-2.json`
    savedServer(on, `Too large. Stored at ${path} for later.`, { [path]: '[{"id":7}]' })
    fakeHost(on)
    const text = textOf(await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__big' }) }))
    expect(text).toContain('"id": 7')
  })

  test('a note that names a file outside this session is not read', async ($, on) => {
    savedServer(on, note('/home/u/.ssh/id_rsa'), { '/home/u/.ssh/id_rsa': 'secret' })
    fakeHost(on)
    const text = textOf(await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__big' }) }))
    expect(text).not.toContain('secret')
    expect(text).toContain('exceeds maximum allowed tokens')
  })

  test('a link in tool-results/ to a file outside is not read', async ($, on) => {
    const link = `${DIR}/mcp-fake-big-3.txt`
    savedServer(on, note(link), { '/home/u/.ssh/id_rsa': 'secret' }, { [link]: '/home/u/.ssh/id_rsa' })
    fakeHost(on)
    const text = textOf(await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__big' }) }))
    expect(text).not.toContain('secret')
    expect(text).toContain('code-mode does not read')
  })
})

describe('output projection', () => {
  // Results stay from one run to the next only in a session with an id; the
  // test kit has none unless a test gives one.
  const ON = { options: { projection: true } }

  test('with projection off, the footer only counts the calls', { options: { projection: false } }, async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    const text = textOf(await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo', args: { n: 1 } }) }))
    expect(text).toContain('--- 1 MCP call ---')
    expect(text).not.toContain('recall(')
  })

  test('the footer gives each result a number, its size and its shape', ON, async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    const text = textOf(await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo', args: { n: 1 } }, { tool: 'mcp__fake__fail' }) }))
    expect(text).toContain('--- 2 MCP calls: ')
    expect(text).toMatch(/#1 mcp__fake__echo \d+ \{echoed: \{n\}\}/)
    expect(text).toContain('- mcp__fake__fail failed')
    expect(text).toContain('await recall(n) returns result #n again')
  })

  test('recall(n) in a later run returns the kept result with no new call', ON, async ($, on) => {
    on('session.id', () => ({ value: 'sess-p' }))
    const server = fakeServer(on)
    fakeHost(on)
    await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo', args: { n: 7 } }) })
    const before = server.paths.length
    const text = textOf(await $.tool.call({ tool: RUN, code: scenario({ recall: 1 }, { recall: 9 }) }))
    expect(server.paths.length).toBe(before)
    expect(text).toContain('"n": 7')
    expect(text).toContain('no result #9 in this session')
    expect(text).toContain('--- 0 MCP calls, 2 recalls: ')
    expect(text).toContain('recalled: #1 (0 s old)')
  })

  test('is on by default', async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    const text = textOf(await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo' }) }))
    expect(text).toContain('await recall(n) returns result #n again')
  })

  test('without a session id, a result is kept only for its own run', ON, async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    on('session.id', () => ({ value: '' }))
    await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo', args: { n: 7 } }) })
    const text = textOf(await $.tool.call({ tool: RUN, code: scenario({ recall: 1 }) }))
    expect(text).not.toContain('"n": 7')
    expect(text).toContain('no result #1 in this session')
  })

  test('a result larger than the limit is not kept', ON, async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    const text = textOf(await $.tool.call({ tool: RUN, code: returning('x'.repeat(8_000_001)) }))
    expect(text).toContain('more characters cut; return less data')
    expect(text).not.toContain('recall(1)')
  })

  test('recall() is off when projection is off', { options: { projection: false } }, async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo' }) })
    const text = textOf(await $.tool.call({ tool: RUN, code: scenario({ recall: 1 }) }))
    expect(text).toContain('recall() is off')
  })

  test('a call equal to an earlier one names it', ON, async ($, on) => {
    on('session.id', () => ({ value: 'sess-p' }))
    fakeServer(on)
    fakeHost(on)
    await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo', args: { a: 1, b: 2 } }) })
    const text = textOf(await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo', args: { b: 2, a: 1 } }) }))
    expect(text).toContain('#2 mcp__fake__echo')
    expect(text).toContain('the same call as #1')
  })

  test('an empty result after calls that returned data says so', ON, async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    const text = textOf(await $.tool.call({ tool: RUN, code: returning([], { tool: 'mcp__fake__echo', args: { n: 1 } }) }))
    expect(text).toContain('The result is empty, but the calls returned data')
  })

  test('a cut result is kept whole and recall gives it back', ON, async ($, on) => {
    on('session.id', () => ({ value: 'sess-p' }))
    fakeServer(on)
    fakeHost(on)
    const big = Array.from({ length: 3000 }, (_, i) => ({ id: i, name: `item ${i}` }))
    const cut = textOf(await $.tool.call({ tool: RUN, code: returning(big, { tool: 'mcp__fake__echo' }) }))
    expect(cut).toContain('more characters cut; await recall(2) returns the whole result')
    const again = textOf(await $.tool.call({ tool: RUN, code: returning({ last: 'see replies' }, { tool: 'mcp__fake__echo', args: { x: 1 } }) }))
    expect(again).toContain('#3 mcp__fake__echo')
  })

  test('metrics: one line per run with counts and sizes, no data', { options: { projection: true, metrics: true } }, async ($, on) => {
    fakeServer(on)
    const files = fakeHost(on).written
    on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
    on('session.id', () => ({ value: 'sess-m' }))
    await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo', args: { secret: 's3' } }) })
    await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo', args: { secret: 's3' } }, { recall: 1 }) })
    const text = files['/home/u/.claude/code-mode/metrics/sess-m.jsonl']!
    const lines = text.trim().split('\n').map(l => JSON.parse(l))
    expect(lines.length).toBe(2)
    expect(lines[1]).toMatchObject({ projection: true, ok: true, calls: 1, repeats: 1, recalls: 1, recallMisses: 0, cut: false })
    expect(text).not.toContain('s3')
  })

  test('metrics count repeats with projection off too', { options: { metrics: true, projection: false } }, async ($, on) => {
    fakeServer(on)
    const files = fakeHost(on).written
    on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
    on('session.id', () => ({ value: 'sess-o' }))
    await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo', args: { n: 1 } }) })
    await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo', args: { n: 1 } }) })
    const lines = files['/home/u/.claude/code-mode/metrics/sess-o.jsonl']!.trim().split('\n').map(l => JSON.parse(l))
    expect(lines.map(l => l.repeats)).toEqual([0, 1])
    expect(lines[1].projection).toBe(false)
  })
})

describe('approval', () => {
  const ASK: Verdict = { decision: 'ask' }

  test('program: a call no rule decides runs through $.mcp.call', async ($, on) => {
    const server = fakeServer(on, { mcp__fake__echo: ASK })
    fakeHost(on)
    const r = await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo', args: { n: 3 } }) })
    const text = textOf(r)
    expect(text).toContain('"n": 3')
    expect(text).toContain('"server": "fake"')
    expect(server.paths).toEqual(['mcp.call'])
  })

  test('program: an allow rule keeps the normal tool call', async ($, on) => {
    const server = fakeServer(on)
    fakeHost(on)
    await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo' }) })
    expect(server.paths).toEqual(['tool.call'])
  })

  test('a deny rule refuses the call before anything runs', async ($, on) => {
    const server = fakeServer(on, { mcp__fake__echo: { decision: 'deny', reason: 'rule says no' } })
    fakeHost(on)
    const r = await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo' }) })
    expect(textOf(r)).toContain('denied: rule says no')
    expect(server.paths).toEqual([])
  })

  test('a server error from $.mcp.call throws in the script', async ($, on) => {
    fakeServer(on, { mcp__fake__fail: ASK })
    fakeHost(on)
    const r = await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__fail' }) })
    expect(textOf(r)).toContain('"error": "server error"')
  })

  test('per-call: a call no rule decides keeps the normal tool call', { options: { approval: 'per-call' } }, async ($, on) => {
    const server = fakeServer(on, { mcp__fake__echo: ASK })
    fakeHost(on)
    await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo' }) })
    expect(server.paths).toEqual(['tool.call'])
  })
})

describe('blockDirectMcp', () => {
  test('denies direct MCP calls but not calls from run_code', { options: { blockDirectMcp: true } }, async ($, on) => {
    fakeServer(on)
    fakeHost(on)
    const direct = await $.tool.call({ tool: 'mcp__fake__echo', n: 1 })
    expect(textOf(direct)).toContain('call this tool from run_code')
    const viaCode = await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__echo', args: { n: 7 } }) })
    expect(textOf(viaCode)).toContain('"n": 7')
  })

  test('is off by default', async ($, on) => {
    fakeServer(on)
    const direct = await $.tool.call({ tool: 'mcp__fake__echo', n: 1 })
    expect(textOf(direct)).toContain('echoed')
  })
})

describe('hint nudge', () => {
  // The plugin keeps tries per session: each test is its own session.
  let sessions = 0
  const session = (on: On) => {
    const id = `nudge-${++sessions}`
    on('session.id', () => ({ value: id }))
  }
  const run = async ($: Engine, ...calls: { tool: string; args?: Record<string, unknown> }[]) =>
    textOf(await $.tool.call({ tool: RUN, code: scenario(...calls) }))

  test('a run that works after a failed call asks for a hint, one time', async ($, on) => {
    session(on)
    fakeServer(on)
    fakeHost(on)
    expect(await run($, { tool: 'mcp__fake__fail' })).not.toContain('Worth a hint')
    const after = await run($, { tool: 'mcp__fake__echo' })
    expect(after).toContain('## Worth a hint')
    expect(after).toContain('Calls to fake failed earlier and work now.')
    expect(await run($, { tool: 'mcp__fake__echo' })).not.toContain('Worth a hint')
  })

  test('a failed call and a working call to one server in one run ask for a hint', async ($, on) => {
    session(on)
    fakeServer(on)
    fakeHost(on)
    expect(await run($, { tool: 'mcp__fake__fail' }, { tool: 'mcp__fake__echo' })).toContain('Calls to fake')
  })

  test('a run that works the first time asks for nothing', async ($, on) => {
    session(on)
    fakeServer(on)
    fakeHost(on)
    expect(await run($, { tool: 'mcp__fake__echo' })).not.toContain('Worth a hint')
  })

  test('searches that found nothing are named after the next run that works', async ($, on) => {
    session(on)
    fakeServer(on)
    fakeHost(on)
    on('tool.list', () => ({ value: [{ name: 'mcp__fake__echo', description: 'Echo the args', mcp: true }] }))
    const miss = textOf(await $.tool.call({ tool: 'mcp__code-mode__search_tools', query: 'ticket' }))
    expect(miss).toContain('No MCP tool matches')
    const after = await run($, { tool: 'mcp__fake__echo' })
    expect(after).toContain('search_tools found nothing for "ticket".')
    expect(after).not.toContain('Calls to')
  })
})
