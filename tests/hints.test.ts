import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import { activePathOf, appendHint, hintApplies, hintFileName, isUnder, parseHint, pendingFileName, pendingPathOf, resolvePath, serverMatches } from '../hooks/hints'

const HOME = '/home/test'
const USER_DIR = `${HOME}/.claude/code-mode/hints`

// A fake file system and session beneath the plugin. `files` maps absolute
// paths to text; `written` records each write the plugin makes.
const fakeHome = (on: On, files: Record<string, string>, serverOf: Record<string, string> = {}, onWrite?: (path: string, text: string) => void, withRm = true) => {
  const written: Record<string, string> = {}
  const all = () => ({ ...files, ...written })
  on('env.get', () => ({ value: HOME }))
  on('fs.exists', ($, e) => ({ value: Object.keys(all()).some(p => p === e.path || p.startsWith(`${e.path}/`)) }))
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const names = new Set<string>()
    const dirs = new Set<string>()
    for (const p of Object.keys(all())) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      if (rest.includes('/')) dirs.add(rest.split('/')[0]!)
      else names.add(rest)
    }
    const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
    return { value: [...[...names].map(n => entry(n, 'file')), ...[...dirs].map(n => entry(n, 'dir'))] }
  })
  on('fs.read', ($, e) => {
    const text = all()[e.path]
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    written[e.path] = e.text
    onWrite?.(e.path, e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: { context: { breakdown: { mcpTools: Object.entries(serverOf).map(([name, serverName]) => ({ name, serverName, tokens: 0, isLoaded: true })) } } } as never,
  }))
  on('tool.list', () => ({
    value: Object.keys(serverOf).map(name => ({ name, description: `Tool ${name}`, mcp: true })),
  }))
  const removed: string[] = []
  if (withRm) on('process.run', ($, e) => {
    if (e.argv[0] === 'rm') {
      const path = String(e.argv.at(-1))
      removed.push(path)
      delete files[path]
      delete written[path]
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { written, removed }
}

const textOf = (r: { result?: unknown; deny?: string; text?: string }): string =>
  r.deny !== undefined ? `DENY ${r.deny}` : typeof r.result === 'string' ? r.result : (r.text ?? JSON.stringify(r.result))

describe('hint files', () => {
  test('parseHint reads inline and dash lists', () => {
    const inline = parseHint('---\nservers: [Datadog, "claude.ai Jira"]\ntools: [analyze_*]\n---\n- a hint', '/x.md', 'user')
    expect(inline.servers).toEqual(['Datadog', 'claude.ai Jira'])
    expect(inline.tools).toEqual(['analyze_*'])
    expect(inline.body).toBe('- a hint')
    const dashes = parseHint('---\nservers:\n  - Gmail\n  - Slack\n---\nbody', '/y.md', 'user')
    expect(dashes.servers).toEqual(['Gmail', 'Slack'])
  })

  test('a file without frontmatter applies to nothing', () => {
    const hint = parseHint('just text', '/z.md', 'user')
    expect(hintApplies(hint, { serverKey: 'claude_ai_Datadog', toolName: 'x' })).toBe(false)
  })

  test('serverMatches joins /mcp names, tool-name keys and plugin servers', () => {
    const uuid = { serverKey: '12631ce4-a0aa', serverName: 'claude.ai Datadog', toolName: 'analyze_datadog_logs' }
    expect(serverMatches('Datadog', uuid)).toBe(true)
    expect(serverMatches('claude.ai Datadog', uuid)).toBe(true)
    expect(serverMatches('Datadog', { serverKey: 'claude_ai_Datadog', toolName: 'x' })).toBe(true)
    expect(serverMatches('Datadog', { serverKey: 'plugin_engineering_datadog', toolName: 'x' })).toBe(true)
    expect(serverMatches('Datadog', { serverKey: 'claude_ai_Datadogx', toolName: 'x' })).toBe(false)
    expect(serverMatches('*dog', uuid)).toBe(true)
  })

  test('identify finds a server by a tool it offers, whatever its name', () => {
    const hint = parseHint('---\nservers: [Jira]\nidentify: [getJiraIssue]\n---\nx', '/h.md', 'user')
    // desktop app: the claude.ai connector is named by its UUID, so no name matches
    const desktop = { serverKey: 'fcef2cd1-7ad6', serverName: 'fcef2cd1-7ad6', serverTools: ['getJiraIssue', 'atlassianUserInfo'], toolName: 'atlassianUserInfo' }
    expect(hintApplies(hint, desktop)).toBe(true)
    const other = { serverKey: 'aaaa-1111', serverTools: ['send_message'], toolName: 'send_message' }
    expect(hintApplies(hint, other)).toBe(false)
  })

  test('a tools filter narrows a hint to some tools', () => {
    const hint = parseHint('---\nservers: [Datadog]\ntools: [analyze_*]\n---\nx', '/h.md', 'user')
    expect(hintApplies(hint, { serverKey: 'claude_ai_Datadog', toolName: 'analyze_datadog_logs' })).toBe(true)
    expect(hintApplies(hint, { serverKey: 'claude_ai_Datadog', toolName: 'search_datadog_logs' })).toBe(false)
  })

  test('each proposal has its own pending file, merged into one active file', () => {
    const pending = `${USER_DIR}/pending/${pendingFileName('gmail.md', 'toolu_01ABCdef234567')}`
    expect(pending).toBe(`${USER_DIR}/pending/gmail--abcdef234567.md`)
    expect(activePathOf(pending)).toBe(`${USER_DIR}/gmail.md`)
    expect(pendingPathOf(`Proposed a hint.\npending: ${pending}`)).toBe(pending)
  })

  test('appendHint creates frontmatter once, then adds bullets', () => {
    const first = appendHint(undefined, ['claude.ai Gmail'], ['search_threads'], [], 'Use search_threads first.')
    expect(first).toBe('---\nservers: ["claude.ai Gmail"]\nidentify: ["search_threads"]\n---\n- Use search_threads first.\n')
    expect(appendHint(first, ['claude.ai Gmail'], [], [], 'Second.')).toBe(`${first}- Second.\n`)
    expect(hintFileName('claude.ai Gmail', [])).toBe('gmail.md')
    expect(hintFileName('Datadog', ['analyze_*'])).toBe('datadog.analyze.md')
    expect(hintFileName('analyze_datadog_logs', ['analyze_datadog_logs'])).toBe('analyze_datadog_logs.md')
  })
})

describe('hints in the tools', () => {
  const MAIL = 'mcp__aaaa-1111__send_message'
  const hintFile = { [`${USER_DIR}/mail.md`]: '---\nservers: [Mail]\n---\n- Mail hint body.' }

  test('search_tools shows the hints of the servers it returns, by /mcp name', async ($, on) => {
    fakeHome(on, hintFile, { [MAIL]: 'claude.ai Mail' })
    const r = await $.tool.call({ tool: 'mcp__code-mode__search_tools', query: 'send' })
    const text = textOf(r)
    expect(text).toContain('## Usage hints')
    expect(text).toContain(`[user hint: ${USER_DIR}/mail.md]`)
    expect(text).toContain('Mail hint body.')
  })

  test('search_tools finds hints by identify when the server is named by UUID', async ($, on) => {
    fakeHome(on, { [`${USER_DIR}/mail.md`]: '---\nservers: [Mail]\nidentify: [send_message]\n---\n- Identified.' }, { [MAIL]: 'aaaa-1111' })
    const r = await $.tool.call({ tool: 'mcp__code-mode__search_tools', query: 'send' })
    expect(textOf(r)).toContain('Identified.')
  })

  test('search_tools shows no hints for other servers', async ($, on) => {
    fakeHome(on, hintFile, { [MAIL]: 'claude.ai Calendar' })
    const r = await $.tool.call({ tool: 'mcp__code-mode__search_tools', query: 'send' })
    expect(textOf(r)).not.toContain('Usage hints')
  })

  test('project hints do not load unless the option is on', async ($, on) => {
    on('session.root', () => ({ value: '/repo' }))
    fakeHome(on, { '/repo/.claude/code-mode/hints/mail.md': '---\nservers: [Mail]\n---\n- Project hint.' }, { [MAIL]: 'claude.ai Mail' })
    const r = await $.tool.call({ tool: 'mcp__code-mode__search_tools', query: 'send' })
    expect(textOf(r)).not.toContain('Project hint.')
  })

  test('project hints load when the option is on', { options: { projectHints: true } }, async ($, on) => {
    on('session.root', () => ({ value: '/repo' }))
    fakeHome(on, { '/repo/.claude/code-mode/hints/mail.md': '---\nservers: [Mail]\n---\n- Project hint.' }, { [MAIL]: 'claude.ai Mail' })
    const r = await $.tool.call({ tool: 'mcp__code-mode__search_tools', query: 'send' })
    expect(textOf(r)).toContain('[project hint: /repo/.claude/code-mode/hints/mail.md]')
  })

  test('pending proposals are not loaded as hints', async ($, on) => {
    fakeHome(on, { [`${USER_DIR}/pending/mail.md`]: '---\nservers: [Mail]\n---\n- Proposed only.' }, { [MAIL]: 'claude.ai Mail' })
    const r = await $.tool.call({ tool: 'mcp__code-mode__search_tools', query: 'send' })
    expect(textOf(r)).not.toContain('Proposed only.')
  })
})

describe('hints after a failed run_code call', () => {
  const FAIL = 'mcp__cccc-3333__broken'
  const XDIR = '/tmp/code-mode-test'

  test('run_code adds the hints of the server whose call failed', async ($, on) => {
    on('tool.check', () => ({ decision: 'allow' as const }))
    on('tool.call', { tool: FAIL }, () => ({ deny: 'nope' }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: `${XDIR}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    // A fake runner: one call to the failing tool, then done once its reply is written.
    let replied: (t: string) => void = () => {}
    const reply = new Promise<string>(r => { replied = r })
    fakeHome(on, { [`${USER_DIR}/broken.md`]: '---\nservers: [Broken]\n---\n- Broken hint.' }, { [FAIL]: 'claude.ai Broken' },
      (path, text) => { if (path === `${XDIR}/r1.json`) replied(text) }, false)
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: `\u0001cm ${JSON.stringify({ t: 'call', id: 1, tool: FAIL, args: {} })}\n` }
      const text = await reply
      yield { stream: 'stdout' as const, text: `\u0001cm ${JSON.stringify({ t: 'done', value: text, logs: [] })}\n` }
      return { value: { code: 0, signal: null } }
    })
    const r = await $.tool.call({ tool: 'mcp__code-mode__run_code', code: 'x' })
    const text = textOf(r)
    expect(text).toContain('denied: nope')
    expect(text).toContain('Broken hint.')
  })
})

describe('add_hint and its approval row', () => {
  const TOOL = 'mcp__bbbb-2222__get_thing'
  const ID = 'toolu_01ABCdef234567'
  const PENDING = `${USER_DIR}/pending/things--abcdef234567.md`
  const PROPOSAL = '---\nservers: ["claude.ai Things"]\nidentify: ["get_thing"]\n---\n- Pass ids as strings.\n'
  const OUTPUT = `Proposed a user hint for claude.ai Things.\npending: ${PENDING}`
  const SURFACES = ['terminal', 'desktop'] as const
  const row = (surface: (typeof SURFACES)[number]) => ({
    plugin: 'code-mode', surface, component: 'ToolResult' as const, requestId: ID,
    props: { tool_use_id: ID, tool: 'mcp__code-mode__add_hint', output: OUTPUT, isErrored: false },
  })

  test('add_hint writes one proposal file under pending/, by the /mcp server name', async ($, on) => {
    const fs = fakeHome(on, {}, { [TOOL]: 'claude.ai Things' })
    const r = await $.tool.call({ tool: 'mcp__code-mode__add_hint', server: 'bbbb-2222', text: 'Pass ids as strings.' })
    expect(textOf(r)).toContain('approves it in the band above the prompt')
    const paths = Object.keys(fs.written)
    expect(paths.length).toBe(1)
    expect(paths[0]!.startsWith(`${USER_DIR}/pending/things--`)).toBe(true)
    expect(fs.written[paths[0]!]).toBe(PROPOSAL)
    expect(textOf(r)).toContain(`pending: ${paths[0]}`)
  })

  test('add_hint keeps the key when the session has no real server name', async ($, on) => {
    const fs = fakeHome(on, {}, { [TOOL]: 'bbbb-2222' })
    await $.tool.call({ tool: 'mcp__code-mode__add_hint', server: 'bbbb-2222', text: 'x' })
    const [path] = Object.keys(fs.written)
    expect(path!.startsWith(`${USER_DIR}/pending/bbbb_2222--`)).toBe(true)
    expect(fs.written[path!]).toBe('---\nservers: ["bbbb-2222"]\nidentify: ["get_thing"]\n---\n- x\n')
  })

  test('add_hint refuses project scope while project hints are off', async ($, on) => {
    const fs = fakeHome(on, {})
    const r = await $.tool.call({ tool: 'mcp__code-mode__add_hint', server: 'X', text: 'y', scope: 'project' })
    expect(textOf(r)).toContain('project hints are off')
    expect(Object.keys(fs.written)).toEqual([])
  })

  for (const surface of SURFACES) {
    test(`the row shows the proposal with buttons (${surface})`, async ($, on) => {
      mock.store(on)
      fakeHome(on, { [PENDING]: PROPOSAL })
      const ui = await $.ui.mount(row(surface))
      expect((await ui.find({ key: 'approve' }))).not.toBe(undefined)
      expect((await ui.find({ key: 'discard' }))).not.toBe(undefined)
      expect(JSON.stringify(await ui.drawn())).toContain('Pass ids as strings.')
    })

    test(`Approve activates the hint and the row says so (${surface})`, async ($, on) => {
      mock.store(on)
      const fs = fakeHome(on, { [PENDING]: PROPOSAL })
      const ui = await $.ui.mount(row(surface))
      await ui.press({ key: 'approve' })
      expect(fs.written[`${USER_DIR}/things.md`]).toBe(PROPOSAL)
      expect(fs.removed).toEqual([PENDING])
      expect(JSON.stringify(await ui.drawn())).toContain('Hint approved')
      expect(await ui.find({ key: 'approve' })).toBe(undefined)
    })

    test(`Discard deletes the proposal (${surface})`, async ($, on) => {
      mock.store(on)
      const fs = fakeHome(on, { [PENDING]: PROPOSAL })
      const ui = await $.ui.mount(row(surface))
      await ui.press({ key: 'discard' })
      expect(fs.removed).toEqual([PENDING])
      expect(fs.written[`${USER_DIR}/things.md`]).toBe(undefined)
      expect(JSON.stringify(await ui.drawn())).toContain('Hint discarded')
    })
  }

  test('Approve appends to an active file that exists', async ($, on) => {
    mock.store(on)
    const fs = fakeHome(on, { [PENDING]: PROPOSAL, [`${USER_DIR}/things.md`]: '---\nservers: [Things]\n---\n- Older hint.\n' })
    const ui = await $.ui.mount(row('terminal'))
    await ui.press({ key: 'approve' })
    expect(fs.written[`${USER_DIR}/things.md`]).toBe('---\nservers: [Things]\n---\n- Older hint.\n- Pass ids as strings.\n')
  })
})

describe('the band above the prompt', () => {
  const PENDING_A = `${USER_DIR}/pending/things--aaaaaaaaaaaa.md`
  const PENDING_B = `${USER_DIR}/pending/analyze_datadog_logs--bbbbbbbbbbbb.md`
  const A = '---\nservers: ["claude.ai Things"]\nidentify: ["get_thing"]\n---\n- Pass ids as strings.\n'
  const B = '---\nservers: ["12631ce4-a0aa-49ba-9211-da04c18f4890"]\nidentify: ["analyze_datadog_logs"]\n---\n- DDSQL has no substr.\n'
  const band = (surface: 'terminal' | 'desktop') => ({
    plugin: 'code-mode', surface, component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 90 } as never,
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`shows nothing while no proposal waits (${surface})`, async ($, on) => {
      mock.store(on)
      fakeHome(on, {})
      // stands for the engine's own band, which the plugin passes the drawing on to
      on('ui.render', { component: 'AbovePrompt' }, () => h('Text', {}, 'engine band') as RenderElement)
      const ui = await $.ui.mount(band(surface))
      expect(await ui.find({ key: 'review' })).toBe(undefined)
      expect(JSON.stringify(await ui.drawn())).toContain('engine band')
    })

    test(`one line with Review, then each proposal with its buttons (${surface})`, async ($, on) => {
      mock.store(on)
      fakeHome(on, { [PENDING_A]: A, [PENDING_B]: B })
      const ui = await $.ui.mount(band(surface))
      expect(JSON.stringify(await ui.drawn())).toContain('2 proposed hints for code mode')
      await ui.press({ key: 'review' })
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain('Things')
      expect(drawn).toContain('server with analyze_datadog_logs')
      expect(drawn).not.toContain('12631ce4')
      expect(drawn).toContain('• Pass ids as strings.')
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(5)
    })

    test(`Approve in the band activates that proposal only (${surface})`, async ($, on) => {
      mock.store(on)
      const fs = fakeHome(on, { [PENDING_A]: A, [PENDING_B]: B })
      const ui = await $.ui.mount(band(surface))
      await ui.press({ key: 'review' })
      // proposals are listed in folder order: things (A) first
      await ui.press({ key: 'approve-0' })
      expect(fs.written[`${USER_DIR}/things.md`]).toBe(A)
      expect(fs.removed).toEqual([PENDING_A])
      expect(JSON.stringify(await ui.drawn())).toContain('1 proposed hint for code mode')
    })
  }
})

describe('the hint-file guard', () => {
  test('resolvePath and isUnder', () => {
    expect(resolvePath('~/.claude/x', '/home/u', '/repo')).toBe('/home/u/.claude/x')
    expect(resolvePath('a/../b/./c', '/home/u', '/repo')).toBe('/repo/b/c')
    expect(isUnder('/a/b/c', '/a/b')).toBe(true)
    expect(isUnder('/a/bc', '/a/b')).toBe(false)
  })

  const session = (on: On) => {
    fakeHome(on, {})
    on('session.root', () => ({ value: '/repo' }))
    on('session.cwd', () => ({ value: '/repo' }))
    // stands for the file tools: a call that gets past the guard is written
    on('tool.call', { tool: 'Write' }, () => ({ result: 'written' }))
    on('tool.call', { tool: 'Edit' }, () => ({ result: 'edited' }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }))
  }

  const denied = [
    ['Write', { file_path: `${USER_DIR}/gmail.md`, content: 'x' }],
    ['Write', { file_path: '~/.claude/code-mode/hints/gmail.md', content: 'x' }],
    ['Write', { file_path: `${USER_DIR}/pending/../gmail.md`, content: 'x' }],
    ['Edit', { file_path: '.claude/code-mode/hints/a.md', old_string: 'a', new_string: 'b' }],
    ['Edit', { file_path: '/repo/src/../.claude/code-mode/hints/a.md', old_string: 'a', new_string: 'b' }],
    ['Bash', { command: 'echo "- x" >> ~/.claude/code-mode/hints/gmail.md' }],
  ] as const
  for (const [tool, input] of denied) {
    test(`denies ${tool} ${JSON.stringify(input).slice(0, 60)}`, async ($, on) => {
      session(on)
      const r = await $.tool.call({ tool, ...input } as never)
      expect(textOf(r)).toContain('hint files steer the model')
    })
  }

  test('lets other files through', async ($, on) => {
    session(on)
    expect(textOf(await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: 'x' }))).toBe('written')
    expect(textOf(await $.tool.call({ tool: 'Edit', file_path: 'README.md', old_string: 'a', new_string: 'b' }))).toBe('edited')
    expect(textOf(await $.tool.call({ tool: 'Bash', command: 'ls ~/.claude' }))).toBe('ran')
  })
})

