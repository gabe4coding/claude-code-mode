import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import {
  ADD_HINT_DESCRIPTION,
  activePathOf,
  appendHint,
  formatHints,
  hintLines,
  hintFileName,
  hintsFor,
  isUnder,
  parseHint,
  pendingFileName,
  pendingPathOf,
  resolvePath,
  serverLabel,
  type Hint,
  type HintScope,
  type HintTarget,
} from './hints'
import {
  RUN_DESCRIPTION,
  SEARCH_DESCRIPTION,
  extractDeclaration,
  formatOutcome,
  isCallable,
  mcpReply,
  rankTools,
  splitToolName,
  takeMessages,
  toValue,
  type Reply,
  type RunnerDone,
  type RunnerError,
} from './protocol'

const MAX_RESULT_CHARS = 20_000
const SEARCH_LIMIT = 15

// macOS only: the sandbox process gets no network. Elsewhere it relies on the
// vm context (no fetch, no require) and Node's --permission.
const NO_NETWORK = '(version 1)(allow default)(deny network*)'
const LAUNCH = [
  'ulimit -t "$1"',
  'if [ -x /usr/bin/sandbox-exec ]; then',
  '  exec /usr/bin/sandbox-exec -p "$2" "$3" --permission --allow-fs-read="$4" --allow-fs-read="$5" "$4" "$5"',
  'fi',
  'exec "$3" --permission --allow-fs-read="$4" --allow-fs-read="$5" "$4" "$5"',
].join('\n')

type Options = { node?: string; timeoutSeconds?: number; blockDirectMcp?: boolean; approval?: string; projectHints?: boolean }

const ADD_HINT = 'mcp__code-mode__add_hint'
const BAND_LIMIT = 5

// Whether the band above the prompt lists the proposals (else one line).
const reviewOpen = atom({ plugin: 'code-mode', key: 'isReviewOpen' } as const, false)

// Hint folders. Bundled and user hints always load; project hints come from
// the repository, so anyone who can commit there could steer the model: they
// load only when the person turns `projectHints` on.
async function hintDirs($: EngineInterface, projectHints: boolean): Promise<{ scope: HintScope; dir: string }[]> {
  const home = await $.env.get('HOME').catch(() => undefined)
  const dirs: { scope: HintScope; dir: string }[] = [{ scope: 'bundled', dir: `${$.plugin.root}/hints` }]
  if (home) dirs.push({ scope: 'user', dir: `${home}/.claude/code-mode/hints` })
  if (projectHints) dirs.push({ scope: 'project', dir: `${await $.session.root()}/.claude/code-mode/hints` })
  return dirs
}

async function readHintFiles($: EngineInterface, dir: string, scope: HintScope): Promise<Hint[]> {
  if (!(await $.fs.exists(dir).catch(() => false))) return []
  const entries = await $.fs.list(dir).catch(() => [])
  const files = entries.filter(f => f.kind !== 'dir' && f.name.endsWith('.md'))
  const texts = await Promise.all(files.map(f => $.fs.read(`${dir}/${f.name}`).catch(() => '')))
  return files.map((f, i) => parseHint(String(texts[i]), `${dir}/${f.name}`, scope))
}

async function loadHints($: EngineInterface, projectHints: boolean): Promise<Hint[]> {
  const dirs = await hintDirs($, projectHints)
  return (await Promise.all(dirs.map(d => readHintFiles($, d.dir, d.scope)))).flat()
}

// Tool name -> server name as /mcp lists it ("claude.ai Datadog"), so a hint
// can match a server whatever its tool-name key is in this session.
async function serverNames($: EngineInterface): Promise<Map<string, string>> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    return new Map((usage.context.breakdown?.mcpTools ?? []).map(t => [t.name, t.serverName]))
  } catch {
    return new Map()
  }
}

// Approve: merge the proposal's bullets into the active file beside pending/
// (or move the whole file when there is none yet), then remove the proposal.
async function approvePending($: EngineInterface, path: string): Promise<string> {
  const dest = activePathOf(path)
  const proposal = String(await $.fs.read(path))
  const current = (await $.fs.exists(dest)) ? String(await $.fs.read(dest)) : undefined
  const bullets = parseHint(proposal, path, 'user').body.split('\n').filter(l => l.trim() !== '').join('\n')
  await $.fs.write(dest, current === undefined ? proposal : `${current.replace(/\s*$/, '')}\n${bullets}\n`)
  await $.process.run(['rm', '-f', path])
  return dest
}

async function discardPending($: EngineInterface, path: string): Promise<void> {
  await $.process.run(['rm', '-f', path])
}

// One decision, from the add_hint row or from the band: act on the file,
// remember the decision by path (the row reads it), and redraw both.
async function decidePending($: EngineInterface, path: string, action: 'approved' | 'discarded'): Promise<void> {
  const dest = action === 'approved' ? await approvePending($, path) : (await discardPending($, path), undefined)
  await $.store.set(`decision:${path}`, { action, dest })
  $.ui.invalidate('ui.render')
}

// The folders whose files steer the model: the person's and the project's
// hints (the project's even while projectHints is off, so none can be
// planted to load later), each as written and as its real path.
async function guardedHintDirs($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const root = await $.session.root()
  const dirs = [`${home}/.claude/code-mode/hints`, `${root}/.claude/code-mode/hints`].filter(d => !d.startsWith('/.claude'))
  const real = await Promise.all(dirs.map(d => $.fs.stat(d, { resolve: true }).then(s => s.realPath, () => undefined)))
  return [...dirs, ...real.filter((r): r is string => typeof r === 'string')]
}

// True when a file tool's path lands in a hint folder: the path as written,
// its real path, or its parent's real path (a new file is not there yet).
async function touchesHints($: EngineInterface, filePath: string): Promise<boolean> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const full = resolvePath(filePath, home, await $.session.cwd())
  const parent = full.slice(0, full.lastIndexOf('/')) || '/'
  const [self, dir] = await Promise.all([
    $.fs.stat(full, { resolve: true }).then(s => s.realPath, () => undefined),
    $.fs.stat(parent, { resolve: true }).then(s => s.realPath, () => undefined),
  ])
  const candidates = [full, self, dir === undefined ? undefined : `${dir}/${full.slice(parent.length + 1)}`]
  const dirs = await guardedHintDirs($)
  return candidates.some(c => typeof c === 'string' && dirs.some(d => isUnder(c, d)))
}

const HINT_GUARD_DENY =
  'code-mode: hint files steer the model, so they cannot be written with file tools. Propose a hint with add_hint; the person approves it in the band above the prompt.'

// Proposals waiting in the user's (and, when on, the project's) pending/.
async function loadPending($: EngineInterface, projectHints: boolean): Promise<Hint[]> {
  const dirs = (await hintDirs($, projectHints)).filter(d => d.scope !== 'bundled')
  return (await Promise.all(dirs.map(d => readHintFiles($, `${d.dir}/pending`, d.scope)))).flat()
}

// Server key -> the names of the tools it offers, for `identify` matching.
const toolsByServer = (toolNames: readonly string[]): Map<string, string[]> => {
  const map = new Map<string, string[]>()
  for (const tool of toolNames) {
    const split = splitToolName(tool)
    if (split) map.set(split.server, [...(map.get(split.server) ?? []), split.name])
  }
  return map
}

const targetsOf = (tools: readonly string[], names: Map<string, string>, offered: Map<string, string[]>): HintTarget[] =>
  tools.flatMap(tool => {
    const split = splitToolName(tool)
    return split
      ? [{ serverKey: split.server, serverName: names.get(tool), serverTools: offered.get(split.server), toolName: split.name }]
      : []
  })

// A server's /mcp name, when the session knows a real one: in the desktop
// app the name of a claude.ai connector is its UUID, the same as its key.
const displayName = (names: Map<string, string>, server: string): string | undefined => {
  const name = [...names.entries()].find(([tool]) => splitToolName(tool)?.server === server)?.[1]
  return name !== undefined && name !== server ? name : undefined
}

export const register: Register = (on, options) => {
  const opts = options as Options
  const node = opts.node || 'node'
  const timeoutSeconds = Math.max(5, Number(opts.timeoutSeconds) || 120)
  const programApproval = opts.approval !== 'per-call'
  const projectHints = opts.projectHints === true

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'run_code',
      description: RUN_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Body of an async JavaScript function. Use call() or tools.<server>.<tool>() and return the result.' },
        },
        required: ['code'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'search_tools',
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords; empty lists every MCP tool.' },
          limit: { type: 'number', description: `Most tools to return (default ${SEARCH_LIMIT}).` },
        },
        required: ['query'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'add_hint',
      description: ADD_HINT_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'The MCP server: its name as /mcp lists it ("claude.ai Datadog") or the <server> part of mcp__<server>__<tool>.' },
          text: { type: 'string', description: 'The hint: one short, factual sentence.' },
          tools: { type: 'array', items: { type: 'string' }, description: 'Optional: tool names on that server (globs allowed) when the hint is for some tools only.' },
          scope: { type: 'string', enum: ['user', 'project'], description: 'Default "user".' },
        },
        required: ['server', 'text'],
      },
    })
    return next(e)
  })

  // add_hint never activates a hint: it writes a proposal under pending/,
  // which loads only after the person presses Approve on the call's row in
  // the chat. Text in a tool result therefore cannot plant a standing
  // instruction by itself: the model cannot press a button.
  on('tool.call', { tool: ADD_HINT }, async ($, e) => {
    const input = e as unknown as { server?: unknown; text?: unknown; tools?: unknown; scope?: unknown }
    const server = typeof input.server === 'string' ? input.server.trim() : ''
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    const tools = Array.isArray(input.tools) ? input.tools.filter((t): t is string => typeof t === 'string') : []
    const scope = input.scope === 'project' ? 'project' : 'user'
    if (server === '' || text === '') return { result: 'Error: server and text are required.' }
    if (text.length > 500) return { result: 'Error: a hint is one short sentence (500 characters at most).' }

    const dirs = await hintDirs($, projectHints)
    const target = dirs.find(d => d.scope === scope)
    if (!target) return { result: `Error: ${scope} hints are off. The person can turn on the code-mode option "projectHints".` }

    // Store the server by its /mcp name when the session knows one, and also
    // by one of its tools (`identify`): a tool name stays the same in every
    // session and host, a server key does not.
    const [names, list] = await Promise.all([serverNames($), $.tool.list()])
    const offered = toolsByServer(list.filter(t => t.mcp).map(t => t.name)).get(server) ?? []
    const servers = [displayName(names, server) ?? server]
    const named = tools.find(t => !t.includes('*') && offered.includes(t))
    const longest = [...offered].sort((a, b) => b.length - a.length)[0]
    const identify = named ?? longest
    // A UUID key makes an unreadable file name: name the file by the tool instead.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(servers[0]!)
    const fileName = hintFileName(isUuid && identify ? identify : servers[0]!, tools)
    const path = `${target.dir}/pending/${pendingFileName(fileName, e.tool_use_id)}`
    await $.fs.write(path, appendHint(undefined, servers, identify ? [identify] : [], tools, text))
    $.ui.invalidate('ui.render') // the band above the prompt counts the proposal
    return {
      result: `Proposed a ${scope} hint for ${servers[0]}. It has no effect until the person approves it in the band above the prompt (Review, then Approve or Discard). Tell the person.\npending: ${path}`,
    }
  }).catch(() => ({ deny: 'code-mode: add_hint failed; see the debug log.' }))

  // The add_hint row shows the proposal with Approve and Discard, where the
  // surface asks plugins to draw tool results (the desktop app does not; the
  // band above the prompt covers it). A press is the person's own act;
  // $.store keeps the decision so the row still shows it after a reload.
  on('ui.render', { component: 'ToolResult', props: { tool: ADD_HINT } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const path = pendingPathOf(String(e.props.output ?? ''))
    if (path === undefined) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const decision = (await $.store.get(`decision:${path}`)) as { action: string; dest?: string } | undefined

    if (decision?.action === 'approved') return <Text color="green">✓ Hint approved: {decision.dest}</Text>
    if (decision?.action === 'discarded') return <Text dimColor>Hint discarded.</Text>
    if (!(await $.fs.exists(path))) return <Text dimColor>Hint proposal is no longer pending.</Text>

    const hint = parseHint(String(await $.fs.read(path)), path, 'user')
    const decide = (action: 'approved' | 'discarded') => decidePending($, path, action)
    const scope = path.includes('/.claude/code-mode/hints/') && !path.startsWith(String(await $.env.get('HOME').catch(() => ''))) ? 'project' : 'user'

    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>Proposed usage hint ({scope})</Text>
        <Text dimColor>
          server: {hint.servers.join(', ')}
          {hint.identify.length > 0 ? ` · identify: ${hint.identify.join(', ')}` : ''}
          {hint.tools.length > 0 ? ` · tools: ${hint.tools.join(', ')}` : ''}
        </Text>
        <Text>{hint.body}</Text>
        <Text dimColor>The model sees approved hints in later sessions. Approve only what you would write yourself.</Text>
        <Box>
          <Button key="approve" label="Approve" variant="primary" onPress={() => decide('approved')} />
          <Text> </Text>
          <Button key="discard" label="Discard" onPress={() => decide('discarded')} />
        </Box>
      </Box>
    )
  })

  // The band above the prompt: while proposals wait in pending/ (from any
  // session, a headless one included), one line with Review; opened, each
  // proposal with its own Approve and Discard. Nothing shows otherwise.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const pending = await loadPending($, projectHints)
    if (pending.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const count = `${pending.length} proposed hint${pending.length === 1 ? '' : 's'} for code mode`

    if (!(await read($, reviewOpen))) {
      return (
        <Box gap={1} alignItems="center">
          <Text color="yellow">●</Text>
          <Text>{count}</Text>
          <Button key="review" label="Review" onPress={() => update($, reviewOpen, () => true)} />
        </Box>
      )
    }

    const shown = pending.slice(0, BAND_LIMIT)
    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          <Text bold>{count}</Text>
          <Button key="close" label="Close" role="dismiss" onPress={() => update($, reviewOpen, () => false)} />
        </Box>
        {shown.map((p, i) => (
          <Box key={`proposal-${i}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text dimColor>
              {serverLabel(p)}
              {p.tools.length > 0 ? ` · ${p.tools.join(', ')}` : ''}
              {` · ${p.scope}`}
            </Text>
            {hintLines(p.body).map(line => <Text>{line}</Text>)}
            <Box gap={1} marginTop={1}>
              <Button key={`approve-${i}`} label="Approve" variant="primary" onPress={() => decidePending($, p.path, 'approved')} />
              <Button key={`discard-${i}`} label="Discard" onPress={() => decidePending($, p.path, 'discarded')} />
            </Box>
          </Box>
        ))}
        {pending.length > shown.length ? <Text dimColor>{pending.length - shown.length} more after these.</Text> : null}
        <Text dimColor>Approved hints guide the model in later sessions. Approve only what you would write yourself.</Text>
      </Box>
    )
  })

  on('tool.call', { tool: 'mcp__code-mode__search_tools' }, async ($, e) => {
    const input = e as unknown as { query?: unknown; limit?: unknown }
    const query = typeof input.query === 'string' ? input.query : ''
    const limit = Math.min(100, Math.max(1, Number(input.limit) || SEARCH_LIMIT))
    const all = (await $.tool.list()).filter(t => t.mcp && isCallable(t.name, $.plugin.name))
    const found = rankTools(all, query, limit)
    if (found.length === 0) return { result: `No MCP tool matches "${query}". ${all.length} MCP tools are connected.` }

    const typesFile = `${$.plugin.root}/.claude-plugin/types/claude-code-mcp/index.d.ts`
    const dts = (await $.fs.exists(typesFile)) ? await $.fs.read(typesFile).catch(() => '') : ''
    const blocks = found.map(t => {
      const declaration = dts === '' ? undefined : extractDeclaration(dts, t.name)
      const args = declaration ?? `(argument types unknown here: ToolSearch "select:${t.name}" shows the schema)`
      const summary = t.description.split('\n')[0]!.slice(0, 300)
      return `### ${t.name}\n${summary}\nargs: ${args}`
    })
    const [hints, names] = await Promise.all([loadHints($, projectHints), serverNames($)])
    const offered = toolsByServer(all.map(t => t.name))
    const hintText = formatHints(hintsFor(hints, targetsOf(found.map(t => t.name), names, offered)))
    const tail = hintText === '' ? '' : `\n\n${hintText}`
    return { result: `${found.length} of ${all.length} MCP tools. Call them in run_code with call("<name>", args).\n\n${blocks.join('\n\n')}${tail}` }
  }).catch(() => ({ deny: 'code-mode: search_tools failed; see the debug log.' }))

  on('tool.call', { tool: 'mcp__code-mode__run_code' }, async ($, e) => {
    const code = String((e as unknown as { code?: unknown }).code ?? '')
    if (code.trim() === '') return { result: 'Error: code is empty.' }

    const runner = `${$.plugin.root}/runtime/runner.mjs`
    const made = await $.process.run(['mktemp', '-d', '-t', 'code-mode'])
    const xdir = made.stdout.trim()
    if (made.exitCode !== 0 || xdir === '') return { result: `Error: could not make a temp dir: ${made.stderr}` }

    let calls = 0
    let outcome: RunnerDone | RunnerError | undefined
    let stderr = ''
    const answers: Promise<void>[] = []
    const failed = new Set<string>()

    const answer = async (id: number, tool: string, args: Record<string, unknown>): Promise<void> => {
      calls++
      let reply: Reply
      if (!isCallable(tool, $.plugin.name)) {
        reply = { ok: false, error: `only MCP tools (mcp__<server>__<tool>) can be called, not "${tool}"` }
      } else {
        try {
          // Program approval: the person or the auto-mode classifier approved
          // run_code with this program in view, so a call no rule decides
          // (verdict `ask`) runs as part of it. A deny rule still refuses, and
          // an allow rule or an organization ceiling takes the normal path.
          const check = await $.tool.check({ tool, input: args })
          const target = splitToolName(tool)
          if (check.decision === 'deny') {
            reply = { ok: false, error: `denied: ${check.reason ?? 'a permission rule refuses this tool'}` }
          } else if (programApproval && check.decision === 'ask' && check.ceiling === undefined && target !== undefined) {
            reply = mcpReply(await $.mcp.call(target.server, target.name, args))
          } else {
            const r = await $.tool.call({ ...args, tool })
            if (r.deny !== undefined) reply = { ok: false, error: `denied: ${r.deny}` }
            else if (r.isError === true) reply = { ok: false, error: r.text ?? String(r.result) }
            else reply = { ok: true, value: toValue(r.result, r.text) }
          }
        } catch (err) {
          reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      if (!reply.ok && isCallable(tool, $.plugin.name)) failed.add(tool)
      await $.fs.write(`${xdir}/r${id}.json`, JSON.stringify(reply))
    }

    try {
      const stream = $.process.spawn({
        argv: ['/bin/sh', '-c', LAUNCH, 'code-mode', String(timeoutSeconds), NO_NETWORK, node, runner, xdir],
        input: JSON.stringify({ code, timeoutMs: timeoutSeconds * 1000 }),
      })
      let buffer = ''
      for await (const piece of stream) {
        if (piece.stream === 'stderr') {
          stderr += piece.text
          continue
        }
        const taken = takeMessages(buffer + piece.text)
        buffer = taken.rest
        for (const m of taken.messages) {
          if (m.t === 'call') answers.push(answer(m.id, m.tool, m.args))
          else outcome = m
        }
      }
      await Promise.allSettled(answers)
    } catch (err) {
      stderr += `\n${err instanceof Error ? err.message : String(err)}`
    } finally {
      await $.process.run(['rm', '-rf', xdir]).catch(() => undefined)
    }

    // Hints for the servers whose calls failed: the likely fix is often there.
    // A hint that cannot be read never costs the run its result.
    let hintText = ''
    if (failed.size > 0) {
      try {
        const [hints, names, list] = await Promise.all([loadHints($, projectHints), serverNames($), $.tool.list()])
        const offered = toolsByServer(list.filter(t => t.mcp).map(t => t.name))
        hintText = formatHints(hintsFor(hints, targetsOf([...failed], names, offered)))
      } catch {
        hintText = ''
      }
    }
    const tail = hintText === '' ? '' : `\n\n${hintText}`
    return { result: `${formatOutcome(outcome, calls, stderr, MAX_RESULT_CHARS)}${tail}` }
  }).catch(() => ({ deny: 'code-mode: run_code failed; see the debug log.' }))

  // Guard: an active hint is just a file, so the model must not write one
  // with its own tools, or add_hint's approval step means nothing. File tools
  // are checked by path; Bash by whether the command names a hint folder,
  // which is best effort (a shell can spell a path many ways). The person's
  // own editor is not a Claude tool and is not affected.
  // A guard that fails denies the call it guards (next.called: it already passed).
  const GUARD_FAILED = 'code-mode: the hint-file guard failed; try again.'
  on('tool.call', { tool: 'Write' }, async ($, e, next) =>
    (await touchesHints($, e.file_path)) ? { deny: HINT_GUARD_DENY } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))
  on('tool.call', { tool: 'Edit' }, async ($, e, next) =>
    (await touchesHints($, e.file_path)) ? { deny: HINT_GUARD_DENY } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) =>
    (await touchesHints($, e.notebook_path)) ? { deny: HINT_GUARD_DENY } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))
  on('tool.call', { tool: 'Bash' }, ($, e, next) =>
    /code-mode\/+hints/i.test(e.command) ? { deny: HINT_GUARD_DENY } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))

  // Optional: push the model to run_code by refusing its direct MCP calls.
  // Calls this plugin makes (from run_code) pass.
  on('tool.call', ($, e, next) => {
    if (opts.blockDirectMcp !== true) return next(e)
    if (!isCallable(e.tool, $.plugin.name)) return next(e)
    if (next.origin.plugin === $.plugin.name) return next(e)
    return { deny: `code-mode: call this tool from run_code instead: await call("${e.tool}", { ... })` }
  }).catch(($, e, next) => next(e))
}
