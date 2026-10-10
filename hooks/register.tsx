import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import {
  ADD_HINT_DESCRIPTION,
  HINT_KINDS,
  OTHER_INSTRUCTION,
  REMOVE_HINT_DESCRIPTION,
  activePathOf,
  appendHint,
  displayName,
  findItem,
  formatHints,
  hintLines,
  hintFileName,
  hintItems,
  hintKey,
  hintRef,
  hintsFor,
  hintApplies,
  isUnder,
  kindQuestion,
  normalize,
  parseHint,
  pendingFileName,
  pendingPathOf,
  parseRemoved,
  removalProposal,
  removeFromFile,
  resolvePath,
  reviewLines,
  serverKeyOf,
  serverLabel,
  targetsOf,
  textFlags,
  toolsByServer,
  withReview,
  withoutItems,
  withoutReview,
  type Hint,
  type HintScope,
  type Review,
} from './hints'
import {
  RUN_DESCRIPTION,
  SEARCH_DESCRIPTION,
  callKey,
  extractDeclaration,
  errorText,
  formatOutcome,
  hintNudge,
  isCallable,
  isSessionResult,
  mcpReply,
  missedData,
  rankTools,
  savedResultOf,
  savedReply,
  sessionContext,
  shapeOf,
  splitToolName,
  takeMessages,
  toValue,
  type CallRecord,
  type Projection,
  type Reply,
  type RunnerDone,
  type RunnerError,
} from './protocol'

const MAX_RESULT_CHARS = 20_000
const MAX_SAVED_BYTES = 4 * 1024 * 1024 // what one $.fs.read returns
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

type Options = {
  node?: string
  timeoutSeconds?: number
  blockDirectMcp?: boolean
  approval?: string
  projectHints?: boolean
  projection?: boolean
  metrics?: boolean
}

const ADD_HINT = 'mcp__code-mode__add_hint'
const REMOVE_HINT = 'mcp__code-mode__remove_hint'
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

// The scope of a proposal: a pending file is in the user or the project hint
// folder, and a project is often under HOME, so test the user folder itself.
async function scopeOf($: EngineInterface, path: string): Promise<HintScope> {
  const userDir = (await hintDirs($, false)).find(d => d.scope === 'user')?.dir
  return userDir !== undefined && isUnder(path, userDir) ? 'user' : 'project'
}

// A file that cannot be read, or that applies to no server, loads as nothing.
// The debug log says which, so a person can find out why a hint never shows.
async function readHintFiles($: EngineInterface, dir: string, scope: HintScope): Promise<Hint[]> {
  if (!(await $.fs.exists(dir).catch(() => false))) return []
  const entries = await $.fs.list(dir).catch(err => (debugLog($, `cannot list ${dir}: ${errorText(err)}`), []))
  const files = entries.filter(f => f.kind !== 'dir' && f.name.endsWith('.md'))
  const texts = await Promise.all(
    files.map(f => $.fs.read(`${dir}/${f.name}`).catch(err => (debugLog($, `cannot read ${dir}/${f.name}: ${errorText(err)}`), ''))),
  )
  return files.map((f, i) => {
    const hint = parseHint(String(texts[i]), `${dir}/${f.name}`, scope)
    if (hint.servers.length + hint.identify.length + hint.tools.length === 0 && hint.remove === undefined) {
      debugLog($, `${hint.path} names no servers, identify or tools in its frontmatter, so it applies to no server`)
    }
    return hint
  })
}

async function loadHintFiles($: EngineInterface, projectHints: boolean): Promise<Hint[]> {
  const dirs = await hintDirs($, projectHints)
  return (await Promise.all(dirs.map(d => readHintFiles($, d.dir, d.scope)))).flat()
}

// A line in the debug log (`claude --debug`). It never throws: a hook that
// failed can still log.
function debugLog($: EngineInterface, text: string): void {
  try {
    $.ui.log(`code-mode: ${text}`, { to: 'debug' })
  } catch {
    // no log in this frame
  }
}

// Per session, because one hooks module serves each session of the host (the
// desktop app runs many). `hidden`: the hints remove_hint hid (`hintRef` +
// newline + `hintKey`); they stay hidden in that session whatever the person
// decides, unless the person discards the removal. `tries`: servers whose
// calls failed and have not worked since, and search_tools queries that found
// nothing; a run that works after them is the moment to propose a hint
// (hintNudge). `failedTries` counts the runs with a failed try per server,
// for the card of a proposal. session.end drops the entry.
// `kept`: the results of nested calls as JSON text, by number, with the time
// of the call, for recall(n) (output projection). `seen`: the first number of
// each call key, to find a call that repeats an earlier one. `metrics`: one
// JSON line per run, when on.
type Tries = { failedServers: Set<string>; missedSearches: string[]; failedTries: Map<string, number> }
type Kept = { next: number; results: Map<number, { json: string; at: number }>; chars: number; seen: Map<string, number> }
type SessionState = { hidden: Set<string>; tries: Tries; kept: Kept; metrics: string[] }
const bySession = new Map<string, SessionState>()

async function sessionOf($: EngineInterface): Promise<SessionState> {
  const id = await $.session.id().catch(() => '')
  let state = bySession.get(id)
  if (!state) {
    state = {
      hidden: new Set(),
      tries: { failedServers: new Set(), missedSearches: [], failedTries: new Map() },
      kept: newKept(),
      metrics: [],
    }
    bySession.set(id, state)
  }
  return state
}

const newKept = (): Kept => ({ next: 1, results: new Map(), chars: 0, seen: new Map() })

// What one session keeps for recall(n): the newest results, up to these
// limits. About 10 MB per session, and the desktop app runs many sessions in
// one process.
const MAX_KEPT = 50
const MAX_KEPT_CHARS = 8_000_000
const MAX_SEEN = 2000

// Keeps a result and returns its number; the oldest results go first. A
// result larger than the whole limit is not kept.
function keep(kept: Kept, json: string): number | undefined {
  if (json.length > MAX_KEPT_CHARS) return undefined
  const ref = kept.next++
  kept.results.set(ref, { json, at: Date.now() })
  kept.chars += json.length
  for (const [old, r] of kept.results) {
    if (kept.results.size <= MAX_KEPT && kept.chars <= MAX_KEPT_CHARS) break
    if (old === ref) break
    kept.results.delete(old)
    kept.chars -= r.json.length
  }
  return ref
}

// One line per run in ~/.claude/code-mode/metrics/<session>.jsonl, for the
// output projection experiment: sizes and counts only, no data and no arguments.
async function writeMetrics($: EngineInterface, state: SessionState, line: Record<string, unknown>): Promise<void> {
  const [home, id] = await Promise.all([$.env.get('HOME').catch(() => undefined), $.session.id().catch(() => '')])
  if (!home || id === '') return
  state.metrics.push(JSON.stringify(line))
  await $.fs.write(`${home}/.claude/code-mode/metrics/${id}.jsonl`, `${state.metrics.join('\n')}\n`)
}

const removedFile = (userDir: string): string => `${userDir}/removed.json`

// The hints the model sees: without the ones hidden in this session and the
// bundled ones the person removed.
async function loadHints($: EngineInterface, projectHints: boolean): Promise<Hint[]> {
  const [hints, { hidden }, dirs] = await Promise.all([loadHintFiles($, projectHints), sessionOf($), hintDirs($, projectHints)])
  const userDir = dirs.find(d => d.scope === 'user')?.dir
  const removedText = userDir === undefined ? '' : await $.fs.read(removedFile(userDir)).catch(() => '')
  const removed = new Set(parseRemoved(String(removedText)).map(r => `bundled:${r.file}\n${r.hint}`))
  return hints.flatMap(h => {
    const ref = hintRef(h)
    const drop = (key: string) => hidden.has(`${ref}\n${key}`) || removed.has(`${ref}\n${key}`)
    if (!hintItems(h.body).some(i => drop(hintKey(i)))) return [h]
    const body = withoutItems(h.body, drop)
    return body === '' ? [] : [{ ...h, body }]
  })
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

// Approve a removal: take the hint out of its file (and remove a file with no
// hint left), or, for a bundled hint, add it to removed.json. The file must
// be directly in a hint folder: a pending file names it, and a pending file
// is only as safe as the folder it is in.
async function approveRemoval($: EngineInterface, hint: Hint, projectHints: boolean): Promise<string> {
  const ref = hint.remove!
  const key = hintKey(hint.body)
  const dirs = await hintDirs($, projectHints)
  const userDir = dirs.find(d => d.scope === 'user')?.dir
  if (ref.startsWith('bundled:')) {
    const file = ref.slice('bundled:'.length)
    if (userDir === undefined || !/^[\w.-]+\.md$/.test(file)) throw new Error(`not a bundled hint file: ${ref}`)
    const path = removedFile(userDir)
    const current = parseRemoved(String(await $.fs.read(path).catch(() => '')))
    if (!current.some(r => r.file === file && r.hint === key)) current.push({ file, hint: key })
    await $.fs.write(path, `${JSON.stringify(current, null, 2)}\n`)
    return path
  }
  const dir = dirs.find(d => d.scope !== 'bundled' && ref.startsWith(`${d.dir}/`) && !ref.slice(d.dir.length + 1).includes('/'))
  if (dir === undefined || !ref.endsWith('.md')) throw new Error(`not a hint file: ${ref}`)
  if (!(await $.fs.exists(ref))) return ref
  const rest = removeFromFile(String(await $.fs.read(ref)), key)
  if (rest === undefined) await $.process.run(['rm', '-f', ref])
  else await $.fs.write(ref, rest)
  return ref
}

// Approve: merge the proposal's bullets into the active file beside pending/
// (or move the whole file when there is none yet), then remove the proposal.
async function approvePending($: EngineInterface, path: string, projectHints: boolean): Promise<string> {
  const proposal = String(await $.fs.read(path))
  const removal = parseHint(proposal, path, 'user')
  if (removal.remove !== undefined) {
    const dest = await approveRemoval($, removal, projectHints)
    await $.process.run(['rm', '-f', path])
    return dest
  }
  const dest = activePathOf(path)
  const current = (await $.fs.exists(dest)) ? String(await $.fs.read(dest)) : undefined
  const bullets = parseHint(proposal, path, 'user').body.split('\n').filter(l => l.trim() !== '').join('\n')
  await $.fs.write(dest, current === undefined ? withoutReview(proposal) : `${current.replace(/\s*$/, '')}\n${bullets}\n`)
  await $.process.run(['rm', '-f', path])
  return dest
}

// Discard: delete the proposal. A discarded removal also shows the hint
// again in the session that hid it.
async function discardPending($: EngineInterface, path: string): Promise<void> {
  const hint = parseHint(String(await $.fs.read(path).catch(() => '')), path, 'user')
  if (hint.remove !== undefined) for (const { hidden } of bySession.values()) hidden.delete(`${hint.remove}\n${hintKey(hint.body)}`)
  await $.process.run(['rm', '-f', path])
}

// One decision, from the add_hint or remove_hint row or from the band: act
// on the file, remember the decision by path (the row reads it), and redraw both.
async function decidePending($: EngineInterface, path: string, action: 'approved' | 'discarded', projectHints: boolean): Promise<void> {
  const isRemoval = parseHint(String(await $.fs.read(path).catch(() => '')), path, 'user').remove !== undefined
  const dest = action === 'approved' ? await approvePending($, path, projectHints) : (await discardPending($, path), undefined)
  await $.store.set(`decision:${path}`, { action, dest, isRemoval })
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

// The review lines of a proposal's card, with the active file it goes to
// (or, for a removal, comes out of) and how many hints that file has now.
async function cardLines($: EngineInterface, hint: Hint): Promise<ReturnType<typeof reviewLines>> {
  if (hint.remove !== undefined) {
    const bundled = hint.remove.startsWith('bundled:')
    const name = hint.remove.slice(hint.remove.lastIndexOf(bundled ? ':' : '/') + 1)
    const path = bundled ? `${$.plugin.root}/hints/${name}` : hint.remove
    const text = await $.fs.read(path).catch(() => undefined)
    const hints = text === undefined ? undefined : hintItems(parseHint(String(text), path, hint.scope).body).length
    return reviewLines(hint, { file: bundled ? `the bundled ${name}` : name, hints, isRemoval: true })
  }
  const dest = activePathOf(hint.path)
  const file = dest.slice(dest.lastIndexOf('/') + 1)
  const current = (await $.fs.exists(dest).catch(() => false)) ? String(await $.fs.read(dest).catch(() => '')) : undefined
  const hints = current === undefined ? undefined : parseHint(current, dest, hint.scope).body.split('\n').filter(l => /^\s*[-*]\s/.test(l)).length
  return reviewLines(hint, { file, hints })
}

const HINT_GUARD_DENY =
  'code-mode: hint files steer the model, so they cannot be written with file tools. Propose the hint with add_hint instead.'

// What a hint-file guard that failed answers: it denies, and logs why.
function guardFailed($: EngineInterface, tool: string, error: { kind: string; message?: string }): { deny: string } {
  debugLog($, `the hint-file guard on ${tool} failed (${error.kind}): ${error.message ?? 'no message'}`)
  return { deny: 'code-mode: the hint-file guard failed; try again.' }
}

// Proposals waiting in the user's (and, when on, the project's) pending/.
async function loadPending($: EngineInterface, projectHints: boolean): Promise<Hint[]> {
  const dirs = (await hintDirs($, projectHints)).filter(d => d.scope !== 'bundled')
  return (await Promise.all(dirs.map(d => readHintFiles($, `${d.dir}/pending`, d.scope)))).flat()
}

const TOO_LARGE = 'ask the tool for less data (a page, a filter or fewer fields)'

// A result Claude Code saved to a file reaches the model as a note with the
// path. The program gets the file instead, so it can filter the data. Only a
// file in this session's tool-results/ is read: the note is tool output, and
// a server could name any path in it.
async function loadSaved($: EngineInterface, reply: Reply): Promise<Reply> {
  const text = reply.ok ? (typeof reply.value === 'string' ? reply.value : '') : reply.error
  if (!text.includes('tool-results/')) return reply
  const sessionId = await $.session.id().catch(() => '')
  const saved = savedResultOf(text, sessionId)
  if (saved === undefined) return reply
  if (saved.isCut) return { ok: false, error: `the result was too large to save whole; ${TOO_LARGE}` }
  const stat = await $.fs.stat(saved.path, { resolve: true }).catch(() => undefined)
  const real = stat?.realPath
  if (stat?.kind !== 'file' || real === undefined || !isSessionResult(real, sessionId)) {
    return { ok: false, error: `the result was saved to a file code-mode does not read; ${TOO_LARGE}` }
  }
  if (stat.size > MAX_SAVED_BYTES) return { ok: false, error: `the result is ${stat.size} bytes, more than code-mode loads; ${TOO_LARGE}` }
  const loaded = savedReply(saved.format, String(await $.fs.read(real)))
  return loaded.ok ? loaded : { ok: false, error: `${loaded.error}; ${TOO_LARGE}` }
}

async function recordMissedSearch($: EngineInterface, query: string): Promise<void> {
  const { tries } = await sessionOf($)
  if (query.trim() !== '' && tries.missedSearches.length < 5) tries.missedSearches.push(query.trim().slice(0, 60))
}

// After earlier tries, the first run with a call that works asks for a hint:
// for each server whose calls failed (earlier or in this run) and now work,
// and for the searches that found nothing. Each is named once.
async function nudgeAfter($: EngineInterface, failed: Set<string>, worked: Set<string>): Promise<string> {
  const { tries } = await sessionOf($)
  const serverOf = (tools: Set<string>) => new Set([...tools].flatMap(t => splitToolName(t)?.server ?? []))
  const failedNow = serverOf(failed)
  const learned = [...serverOf(worked)].filter(s => tries.failedServers.has(s) || failedNow.has(s))
  for (const s of failedNow) tries.failedTries.set(s, (tries.failedTries.get(s) ?? 0) + 1)
  for (const s of failedNow) if (!learned.includes(s)) tries.failedServers.add(s)
  for (const s of learned) tries.failedServers.delete(s)
  if (worked.size === 0) return ''
  const nudge = hintNudge(learned, tries.missedSearches)
  tries.missedSearches = []
  return nudge
}

// The engine's types of the connected MCP tools, read again only when the
// file changes: with hundreds of tools it is large, and search_tools runs often.
let mcpTypesCache: { key: string; text: string } | undefined

async function mcpTypes($: EngineInterface): Promise<string> {
  const file = `${$.plugin.root}/.claude-plugin/types/claude-code-mcp/index.d.ts`
  const stat = await $.fs.stat(file).catch(() => undefined)
  if (stat?.kind !== 'file') return ''
  const key = `${file}\n${stat.mtimeMs}\n${stat.size}`
  if (mcpTypesCache?.key !== key) {
    const text = String(await $.fs.read(file).catch(err => (debugLog($, `cannot read ${file}: ${errorText(err)}`), '')))
    mcpTypesCache = { key, text }
  }
  return mcpTypesCache.text
}

export const register: Register = (on, options) => {
  const opts = options as Options
  const node = opts.node || 'node'
  const timeoutSeconds = Math.max(5, Number(opts.timeoutSeconds) || 120)
  const programApproval = opts.approval !== 'per-call'
  const projectHints = opts.projectHints === true
  const projection = opts.projection !== false

  // One hooks module serves many sessions: drop the state of one that ended.
  on('session.end', ($, e, next) => {
    bySession.delete(e.sessionId)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The model reads this at the start of the session and after /clear or a
  // compaction: MCP calls go through run_code, direct calls only as a fallback.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    return { ...r, additionalContext: [...(r.additionalContext ?? []), sessionContext(opts.blockDirectMcp === true)] }
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'run_code',
      description: RUN_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Body of an async JavaScript function.' },
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
          why: { type: 'string', description: 'What failed before and what worked, in one sentence.' },
          tools: { type: 'array', items: { type: 'string' }, description: 'Optional: tool names on that server (globs allowed) when the hint is for some tools only.' },
          scope: { type: 'string', enum: ['user', 'project'], description: 'Default "user".' },
        },
        required: ['server', 'text', 'why'],
      },
    })
    await $.tool.register({
      name: 'remove_hint',
      description: REMOVE_HINT_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The hint file, from "[<scope> hint: <path>]".' },
          text: { type: 'string', description: 'The hint to remove, as shown.' },
          why: { type: 'string', description: 'What the hint says and what the tool does now, in one sentence.' },
        },
        required: ['path', 'text', 'why'],
      },
    })
    return next(e)
  })

  // add_hint never activates a hint: it writes a proposal under pending/,
  // which loads only after the person presses Approve on the call's row in
  // the chat. Text in a tool result therefore cannot plant a standing
  // instruction by itself: the model cannot press a button.
  // The proposal also carries a review for that person (Review): the model's
  // reason, a classifier's guess of the kind, and what code-mode saw. All of
  // it is advice: none of it approves or refuses a proposal.
  on('tool.call', { tool: ADD_HINT }, async ($, e) => {
    const input = e as unknown as { server?: unknown; text?: unknown; why?: unknown; tools?: unknown; scope?: unknown; tool_use_id: string }
    const server = typeof input.server === 'string' ? input.server.trim() : ''
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    const why = typeof input.why === 'string' ? input.why.trim().replace(/\s*\n\s*/g, ' ') : ''
    const tools = Array.isArray(input.tools) ? input.tools.filter((t): t is string => typeof t === 'string') : []
    const scope = input.scope === 'project' ? 'project' : 'user'
    if (server === '' || text === '' || why === '') return { result: 'Error: server, text and why are required.' }
    if (text.length > 500) return { result: 'Error: a hint is one short sentence (500 characters at most).' }
    if (why.length > 300) return { result: 'Error: why is one short sentence (300 characters at most).' }

    const dirs = await hintDirs($, projectHints)
    const target = dirs.find(d => d.scope === scope)
    if (!target) return { result: `Error: ${scope} hints are off. The person can turn on the code-mode option "projectHints".` }

    // Store the server by its /mcp name when the session knows one, and also
    // by one of its tools (`identify`): a tool name stays the same in every
    // session and host, a server key does not.
    // A classifier that fails or names no kind leaves the kind out.
    const [names, list, kind] = await Promise.all([
      serverNames($),
      $.tool.list(),
      $.model.classify(kindQuestion(server, text), HINT_KINDS).catch(() => undefined),
    ])
    const mcpTools = list.filter(t => t.mcp).map(t => t.name)
    const byServer = toolsByServer(mcpTools)
    const key = serverKeyOf(server, names, byServer)
    const offered = byServer.get(key) ?? []
    const servers = [displayName(names, key) ?? key]
    const named = tools.find(t => !t.includes('*') && offered.includes(t))
    const longest = [...offered].sort((a, b) => b.length - a.length)[0]
    const identify = named ?? longest
    // A UUID key makes an unreadable file name: name the file by the tool instead.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(servers[0]!)
    const fileName = hintFileName(isUuid && identify ? identify : servers[0]!, tools)
    const path = `${target.dir}/pending/${pendingFileName(fileName, input.tool_use_id)}`
    const failures = (await sessionOf($)).tries.failedTries.get(key) ?? 0
    const review: Review = {
      why,
      kind,
      seen: failures > 0 ? `${failures} run${failures === 1 ? '' : 's'} with a failed try on this server in this session.` : undefined,
      flags: [
        ...(offered.length === 0 ? ['Its server is not connected in this session.'] : []),
        ...(failures === 0 ? ['No try on this server failed in this session.'] : []),
        ...(kind === OTHER_INSTRUCTION ? ['A classifier reads it as an instruction, not as a fact about a call.'] : []),
        ...textFlags(text, key, mcpTools.filter(t => splitToolName(t)?.server !== key)),
      ],
    }
    await $.fs.write(path, withReview(appendHint(undefined, servers, identify ? [identify] : [], tools, text), review))
    $.ui.invalidate('ui.render') // the band above the prompt counts the proposal
    return {
      result: `Proposed a ${scope} hint for ${servers[0]}. It has no effect until the person approves it in the band above the prompt (Review, then Approve or Discard). Tell the person.\npending: ${path}`,
    }
  }).catch(($, e, next) => (debugLog($, `add_hint failed (${next.error.kind}): ${next.error.message ?? 'no message'}`), { deny: 'code-mode: add_hint failed; see the debug log.' }))

  // remove_hint hides the hint in this session at once (a wrong hint misleads
  // each later call) and proposes its removal. The file changes only after
  // the person approves, as for add_hint: a hidden hint costs one session at
  // most, a removed one costs every session.
  on('tool.call', { tool: REMOVE_HINT }, async ($, e) => {
    const input = e as unknown as { path?: unknown; text?: unknown; why?: unknown; tool_use_id: string }
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    const why = typeof input.why === 'string' ? input.why.trim().replace(/\s*\n\s*/g, ' ') : ''
    if (path === '' || text === '' || why === '') return { result: 'Error: path, text and why are required.' }
    if (why.length > 300) return { result: 'Error: why is one short sentence (300 characters at most).' }

    const hint = (await loadHintFiles($, projectHints)).find(h => h.path === path)
    if (!hint) return { result: `Error: ${path} is not a hint file. Give the path from "[<scope> hint: <path>]".` }
    const found = findItem(hint.body, text)
    if (found.item === undefined) return { result: `Error: ${found.error}` }
    const dirs = await hintDirs($, projectHints)
    const target = dirs.find(d => d.scope === (hint.scope === 'project' ? 'project' : 'user'))
    if (!target) return { result: 'Error: the user hint folder is not known (HOME is not set).' }

    // The failed tries on the servers the hint applies to, for the card.
    const [names, list] = await Promise.all([serverNames($), $.tool.list()])
    const mcpTools = list.filter(t => t.mcp).map(t => t.name)
    const servers = new Set(targetsOf(mcpTools, names, toolsByServer(mcpTools)).filter(t => hintApplies(hint, t)).map(t => t.serverKey))
    const { tries } = await sessionOf($)
    const failures = [...servers].reduce((n, s) => n + (tries.failedTries.get(s) ?? 0), 0)
    const review: Review = {
      why,
      seen: failures > 0 ? `${failures} run${failures === 1 ? '' : 's'} with a failed try on this server in this session.` : undefined,
      flags: failures === 0 ? ['No try on this server failed in this session.'] : [],
    }
    const name = hint.path.slice(hint.path.lastIndexOf('/') + 1).replace(/\.md$/, '')
    const pending = `${target.dir}/pending/${pendingFileName(`${name}.remove.md`, input.tool_use_id)}`
    await $.fs.write(pending, removalProposal(hint, found.item, review))
    ;(await sessionOf($)).hidden.add(`${hintRef(hint)}\n${hintKey(found.item)}`)
    $.ui.invalidate('ui.render')
    return {
      result: `Hid the hint in this session and proposed to remove it from ${path}. The file changes only after the person approves the removal in the band above the prompt. Tell the person.\npending: ${pending}`,
    }
  }).catch(($, e, next) => (debugLog($, `remove_hint failed (${next.error.kind}): ${next.error.message ?? 'no message'}`), { deny: 'code-mode: remove_hint failed; see the debug log.' }))

  // The add_hint and remove_hint rows show the proposal with Approve and
  // Discard, where the surface asks plugins to draw tool results (the desktop
  // app does not; the band above the prompt covers it). A press is the
  // person's own act; $.store keeps the decision so the row still shows it
  // after a reload.
  for (const tool of [ADD_HINT, REMOVE_HINT]) on('ui.render', { component: 'ToolResult', props: { tool } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const path = pendingPathOf(String(e.props.output ?? ''))
    if (path === undefined) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const decision = (await $.store.get(`decision:${path}`)) as { action: string; dest?: string; isRemoval?: boolean } | undefined

    if (decision?.action === 'approved') {
      return <Text color="green">{decision.isRemoval ? '✓ Hint removed' : '✓ Hint approved'}: {decision.dest}</Text>
    }
    if (decision?.action === 'discarded') return <Text dimColor>{decision.isRemoval ? 'Removal discarded. The hint stays.' : 'Hint discarded.'}</Text>
    if (!(await $.fs.exists(path))) return <Text dimColor>Hint proposal is no longer pending.</Text>

    const scope = await scopeOf($, path)
    const hint = parseHint(String(await $.fs.read(path)), path, scope)
    const decide = (action: 'approved' | 'discarded') => decidePending($, path, action, projectHints)
    const lines = await cardLines($, hint)

    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>{hint.remove === undefined ? 'Proposed usage hint' : 'Proposed removal of a usage hint'} ({scope})</Text>
        <Text dimColor>
          server: {hint.servers.join(', ')}
          {hint.identify.length > 0 ? ` · identify: ${hint.identify.join(', ')}` : ''}
          {hint.tools.length > 0 ? ` · tools: ${hint.tools.join(', ')}` : ''}
        </Text>
        <Text>{hint.body}</Text>
        {lines.map(l => <Text color={l.isWarning ? 'yellow' : undefined} dimColor={l.isDim}>{l.text}</Text>)}
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
    const count = `${pending.length} hint proposal${pending.length === 1 ? '' : 's'} for code mode`

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
    const lines = await Promise.all(shown.map(p => cardLines($, p)))
    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          <Text bold>{count}</Text>
          <Button key="close" label="Close" role="dismiss" onPress={() => update($, reviewOpen, () => false)} />
        </Box>
        {shown.map((p, i) => (
          <Box key={`proposal-${i}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text dimColor>
              {p.remove !== undefined ? 'Remove · ' : ''}
              {serverLabel(p)}
              {p.tools.length > 0 ? ` · ${p.tools.join(', ')}` : ''}
              {` · ${p.scope}`}
            </Text>
            {hintLines(p.body).map(line => <Text>{line}</Text>)}
            {lines[i]!.map(l => <Text color={l.isWarning ? 'yellow' : undefined} dimColor={l.isDim}>{l.text}</Text>)}
            <Box gap={1} marginTop={1}>
              <Button key={`approve-${i}`} label="Approve" variant="primary" onPress={() => decidePending($, p.path, 'approved', projectHints)} />
              <Button key={`discard-${i}`} label="Discard" onPress={() => decidePending($, p.path, 'discarded', projectHints)} />
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
    if (found.length === 0) {
      await recordMissedSearch($, query)
      return { result: `No MCP tool matches "${query}". ${all.length} MCP tools are connected.` }
    }

    const dts = await mcpTypes($)
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
  }).catch(($, e, next) => (debugLog($, `search_tools failed (${next.error.kind}): ${next.error.message ?? 'no message'}`), { deny: 'code-mode: search_tools failed; see the debug log.' }))

  on('tool.call', { tool: 'mcp__code-mode__run_code' }, async ($, e) => {
    const code = String((e as unknown as { code?: unknown }).code ?? '')
    if (code.trim() === '') return { result: 'Error: code is empty.' }

    // The real path: Node's --permission stops a main script whose path goes
    // through a link (a linked ~/.claude or plugin folder) before it starts.
    const bundled = `${$.plugin.root}/runtime/runner.mjs`
    const runner = await $.fs.stat(bundled, { resolve: true }).then(s => s.realPath ?? bundled, () => bundled)
    const made = await $.process.run(['mktemp', '-d', '-t', 'code-mode'])
    const xdir = made.stdout.trim()
    if (made.exitCode !== 0 || xdir === '') return { result: `Error: could not make a temp dir: ${made.stderr}` }

    let calls = 0
    let outcome: RunnerDone | RunnerError | undefined
    let stderr = ''
    const answers: Promise<void>[] = []
    const failed = new Set<string>()
    const worked = new Set<string>()
    const state = await sessionOf($)
    // Without a session id, the state above is shared by every session with no
    // id: results kept there could reach another session. Keep them for this run only.
    const hasSession = (await $.session.id().catch(() => '')) !== ''
    const kept = hasSession ? state.kept : newKept()
    const records = new Map<number, CallRecord>()
    const recalled: { ref: number; ageMs: number }[] = []
    let recalls = 0
    let recallMisses = 0

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
          reply = { ok: false, error: errorText(err) }
        }
      }
      reply = await loadSaved($, reply).catch((err): Reply => ({ ok: false, error: `could not read the saved result: ${errorText(err)}` }))
      if (isCallable(tool, $.plugin.name)) (reply.ok ? worked : failed).add(tool)
      const text = JSON.stringify(reply)
      await $.fs.write(`${xdir}/r${id}.json`, text)
      // A repeat is a call equal to an earlier one that worked, with projection
      // on or off, so both arms of the experiment count the same. A failed call
      // is not kept: a new call is the only way to retry it.
      const key = callKey(tool, args)
      const repeatOf = kept.seen.get(key)
      const json = reply.ok ? (JSON.stringify(reply.value) ?? 'null') : ''
      const chars = json.length
      const ref = reply.ok && projection ? keep(kept, json) : undefined
      if (reply.ok && repeatOf === undefined && kept.seen.size < MAX_SEEN) kept.seen.set(key, ref ?? 0)
      records.set(id, { ref, tool, ok: reply.ok, chars, shape: reply.ok && projection ? shapeOf(reply.value) : undefined, repeatOf })
    }

    // recall(n): a result this session kept, with no new call and no new check:
    // it was approved when the call ran.
    const answerRecall = async (id: number, ref: number): Promise<void> => {
      recalls++
      const found = projection ? kept.results.get(ref) : undefined
      if (found === undefined) recallMisses++
      else recalled.push({ ref, ageMs: Date.now() - found.at })
      const error =
        !projection ? 'recall() is off: call the tool again'
        : ref > 0 && ref < kept.next ? `result #${ref} is no longer kept: call the tool again`
        : `no result #${ref} in this session`
      // The kept JSON goes into the reply as it is: no parse and no copy of the value.
      const text = found !== undefined ? `{"ok":true,"value":${found.json}}` : JSON.stringify({ ok: false, error } satisfies Reply)
      await $.fs.write(`${xdir}/r${id}.json`, text)
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
          else if (m.t === 'recall') answers.push(answerRecall(m.id, m.ref))
          else outcome = m
        }
      }
      await Promise.allSettled(answers)
    } catch (err) {
      stderr += `\n${errorText(err)}`
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
      } catch (err) {
        debugLog($, `cannot load the hints for a failed run: ${errorText(err)}`)
        hintText = ''
      }
    }
    // A program that failed (a wrong result shape, a throw) is a failed try for every server it called.
    const isDone = outcome?.t === 'done'
    const nudge = await nudgeAfter($, isDone ? failed : new Set([...failed, ...worked]), isDone ? worked : new Set()).catch(() => '')
    const tail = [nudge, hintText].filter(t => t !== '').map(t => `\n\n${t}`).join('')
    const callRecords = [...records].sort((a, b) => a[0] - b[0]).map(([, r]) => r)
    // A result too large to show is kept whole, so the next program can page it.
    const returned = outcome?.t === 'done' ? outcome.value : undefined
    const outChars = returned?.length ?? 0
    const isCut = outChars > MAX_RESULT_CHARS
    const wholeRef = projection && isCut && returned !== undefined ? keep(kept, returned) : undefined
    const report: Projection | undefined = projection ? { calls: callRecords, recalls, recalled, wholeRef } : undefined
    if (opts.metrics === true) {
      await writeMetrics($, state, {
        ts: new Date().toISOString(),
        projection,
        ok: isDone,
        calls,
        failedCalls: callRecords.filter(r => !r.ok).length,
        repeats: callRecords.filter(r => r.repeatOf !== undefined).length,
        recalls,
        recallMisses,
        inChars: callRecords.reduce((n, r) => n + r.chars, 0),
        outChars,
        cut: isCut,
        empty: missedData(outcome, callRecords),
      }).catch(err => debugLog($, `cannot write the metrics: ${errorText(err)}`))
    }
    return { result: `${formatOutcome(outcome, calls, stderr, MAX_RESULT_CHARS, report)}${tail}` }
  }).catch(($, e, next) => (debugLog($, `run_code failed (${next.error.kind}): ${next.error.message ?? 'no message'}`), { deny: 'code-mode: run_code failed; see the debug log.' }))

  // Guard: an active hint is just a file, so the model must not write one
  // with its own tools, or add_hint's approval step means nothing. File tools
  // are checked by path; Bash by whether the command names a hint folder,
  // which is best effort (a shell can spell a path many ways). The person's
  // own editor is not a Claude tool and is not affected.
  // A guard that fails denies the call it guards (next.called: it already passed).
  // Each tool has its own registration, so `claude plugin validate` lists it.
  on('tool.call', { tool: 'Write' }, async ($, e, next) =>
    (await touchesHints($, e.file_path)) ? { deny: HINT_GUARD_DENY } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : guardFailed($, 'Write', next.error)))
  on('tool.call', { tool: 'Edit' }, async ($, e, next) =>
    (await touchesHints($, e.file_path)) ? { deny: HINT_GUARD_DENY } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : guardFailed($, 'Edit', next.error)))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) =>
    (await touchesHints($, e.notebook_path)) ? { deny: HINT_GUARD_DENY } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : guardFailed($, 'NotebookEdit', next.error)))
  on('tool.call', { tool: 'Bash' }, ($, e, next) =>
    /code-mode\/+hints/i.test(e.command) ? { deny: HINT_GUARD_DENY } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : guardFailed($, 'Bash', next.error)))

  // Optional: push the model to run_code by refusing its direct MCP calls.
  // Calls this plugin makes (from run_code) pass.
  on('tool.call', ($, e, next) => {
    if (opts.blockDirectMcp !== true) return next(e)
    if (!isCallable(e.tool, $.plugin.name)) return next(e)
    if (next.origin.plugin === $.plugin.name) return next(e)
    return { deny: `code-mode: call this tool from run_code instead: await call("${e.tool}", { ... })` }
  }).catch(($, e, next) => next(e))
}
