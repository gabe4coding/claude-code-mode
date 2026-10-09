import { describe, expect, test } from 'claude-code/testing'
import type { On, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import {
  MARK,
  extractDeclaration,
  isCallable,
  isSessionResult,
  mcpReply,
  rankTools,
  savedResultOf,
  savedValue,
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
    const mcp = (format: string, tail = '') =>
      `Error: result (60,000 characters) exceeds maximum allowed tokens. Output has been saved to /h/s.1/tool-results/mcp-fake-big-1.txt.\nFormat: ${format}\nUse jq …${tail}`
    expect(savedResultOf(mcp('Plain text'))).toEqual({ path: '/h/s.1/tool-results/mcp-fake-big-1.txt', format: 'text', isCut: false })
    expect(savedResultOf(mcp('JSON with schema: {}'))?.format).toBe('json')
    expect(savedResultOf(mcp('JSON array'))?.format).toBe('blocks')
    expect(savedResultOf(mcp('JSON', '\nNote: the output exceeded the persist byte limit; …'))?.isCut).toBe(true)
    expect(savedResultOf('<persisted-output>\nOutput too large (61.2KB). Full output saved to: /h/s/tool-results/b.txt\n\nPreview')).toEqual({
      path: '/h/s/tool-results/b.txt',
      format: 'text',
      isCut: false,
    })
    expect(savedResultOf('Error: result exceeds maximum allowed tokens')).toBe(undefined)
    expect(savedResultOf('{"a":1}')).toBe(undefined)
  })

  test('isSessionResult accepts only this session\'s tool-results files', () => {
    expect(isSessionResult('/h/.claude/projects/p/s-1/tool-results/a.txt', 's-1')).toBe(true)
    expect(isSessionResult('/h/.claude/projects/p/s-2/tool-results/a.txt', 's-1')).toBe(false)
    expect(isSessionResult('/h/.ssh/id_rsa', 's-1')).toBe(false)
    expect(isSessionResult('/h/s-1/tool-results/x/a.txt', 's-1')).toBe(false)
    expect(isSessionResult('/h/tool-results/a.txt', '')).toBe(false)
  })

  test('savedValue parses the file as its format says', () => {
    expect(savedValue('text', '[1,2]')).toEqual([1, 2])
    expect(savedValue('text', 'plain')).toBe('plain')
    expect(savedValue('json', '{"a":1}')).toEqual({ a: 1 })
    expect(savedValue('blocks', JSON.stringify([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]))).toBe('one\ntwo')
    expect(savedValue('blocks', JSON.stringify([{ type: 'text', text: '[3]' }]))).toEqual([3])
    expect(savedValue('blocks', '[1,2]')).toEqual([1, 2])
    expect(savedValue('json', 'cut {')).toBe('cut {')
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
  on('process.run', ($, e) => {
    if (e.argv[0] === 'rm') removed.push(String(e.argv[2]))
    return { value: { exitCode: 0, stdout: e.argv[0] === 'mktemp' ? `${XDIR}\n` : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', ($, e) => {
    waiters.get(e.path)?.(e.text)
    return { value: undefined }
  })
  on('process.spawn', async function* ($, e): AsyncGenerator<ProcessSpawnChunk, { value: ProcessSpawnResult }> {
    const { code } = JSON.parse(e.input ?? '{}') as { code: string }
    const { calls } = JSON.parse(code) as { calls: { tool: string; args: Record<string, unknown> }[] }
    const replies = calls.map((_, i) => new Promise<string>(resolve => waiters.set(`${XDIR}/r${i + 1}.json`, resolve)))
    const lines = calls.map((c, i) => `${MARK}${JSON.stringify({ t: 'call', id: i + 1, tool: c.tool, args: c.args })}\n`)
    // Split the output mid-line to check the plugin's line buffering.
    const out = `log line from node\n${lines.join('')}`
    const cut = Math.floor(out.length / 2)
    yield { stream: 'stdout', text: out.slice(0, cut) }
    yield { stream: 'stdout', text: out.slice(cut) }
    const value = (await Promise.all(replies)).map(t => JSON.parse(t))
    yield { stream: 'stdout', text: `${MARK}${JSON.stringify({ t: 'done', value: JSON.stringify(value), logs: ['hello'] })}\n` }
    return { value: { code: 0, signal: null } }
  })
  return { removed }
}

const scenario = (...calls: { tool: string; args?: Record<string, unknown> }[]) =>
  JSON.stringify({ calls: calls.map(c => ({ args: {}, ...c })) })

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
    on('fs.exists', () => ({ value: true }))
    on('fs.read', () => ({ value: 'interface McpToolInputs {\n  "mcp__mail__send": { to: string }\n}' }))
    const r = await $.tool.call({ tool: 'mcp__code-mode__search_tools', query: 'send email' })
    const text = textOf(r)
    expect(text).toContain('### mcp__mail__send\nSend an email\nargs: { to: string }')
    expect(text).toContain('mcp__mail__list')
    expect(text).not.toContain('Bash')
    expect(text).not.toContain(RUN)
  })
})

describe('saved results', () => {
  const SESSION = 'sess-1'
  const DIR = `/home/u/.claude/projects/p/${SESSION}/tool-results`
  const note = (path: string, format = 'JSON with schema: {}') =>
    `Error: result (60,000 characters) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: ${format}\nUse jq …`

  // A server whose result Claude Code saved to a file, and the files there.
  const savedServer = (on: On, path: string, files: Record<string, string>) => {
    on('tool.check', () => ({ decision: 'allow' }))
    on('tool.call', { tool: 'mcp__fake__big' }, () => ({ result: note(path) }))
    on('session.id', () => ({ value: SESSION }))
    on('fs.stat', ($, e) => {
      if (!(e.path in files)) throw new Error('ENOENT')
      return { value: { kind: 'file', size: files[e.path]!.length, mtimeMs: 0, isLink: false, realPath: e.path } }
    })
    on('fs.read', ($, e) => ({ value: files[e.path]! }))
  }

  test('the program gets the saved file, not the note', async ($, on) => {
    const path = `${DIR}/mcp-fake-big-1.txt`
    savedServer(on, path, { [path]: JSON.stringify({ messages: [{ text: 'hi' }] }) })
    fakeHost(on)
    const text = textOf(await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__big' }) }))
    expect(text).toContain('"text": "hi"')
    expect(text).not.toContain('exceeds maximum allowed tokens')
  })

  test('a note that names a file outside this session is not read', async ($, on) => {
    savedServer(on, '/home/u/.ssh/id_rsa', { '/home/u/.ssh/id_rsa': 'secret' })
    fakeHost(on)
    const text = textOf(await $.tool.call({ tool: RUN, code: scenario({ tool: 'mcp__fake__big' }) }))
    expect(text).not.toContain('secret')
    expect(text).toContain('code-mode does not read')
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
