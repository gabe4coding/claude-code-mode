import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren } from 'claude-code'
import {
  ADD_HINT_DESCRIPTION,
  HINT_KINDS,
  OTHER_INSTRUCTION,
  REMOVE_HINT_DESCRIPTION,
  TRANSFER_TEXT,
  activePathOf,
  appendHint,
  asCode,
  canApprove,
  codeNames,
  displayName,
  findItem,
  formatHints,
  hintFileName,
  hintItems,
  hintTransfer,
  hintKey,
  hintRef,
  hintsFor,
  hintApplies,
  isUnder,
  kindQuestion,
  normalize,
  parseHint,
  pendingFileName,
  decisionKey,
  pendingPathOf,
  parseRemoved,
  removalProposal,
  removalTransfer,
  removeFromFile,
  resolvePath,
  reviewFields,
  serverKeyOf,
  serverLabel,
  staleDecisionKeys,
  targetsOf,
  textFlags,
  toolsByServer,
  withReview,
  withoutItems,
  withoutReview,
  type Hint,
  type HintScope,
  type Review,
  type ReviewFields,
} from './hints'
import {
  RUN_DESCRIPTION,
  SEARCH_DESCRIPTION,
  argNamesOf,
  callKey,
  checkCalls,
  declarationKeys,
  extractDeclaration,
  errorText,
  fileNameError,
  fileText,
  formatOutcome,
  functionNudge,
  hintNudge,
  isCallable,
  isSessionResult,
  learnedShape,
  limiter,
  literalCalls,
  mcpReply,
  mergeArgNames,
  mergeShapes,
  missedData,
  parseArgNames,
  parseShapes,
  problemReport,
  rankTools,
  savedResultOf,
  savedReply,
  shapeOf,
  splitToolName,
  takeMessages,
  toValue,
  type ArgNames,
  type CallRecord,
  type Projection,
  type Reply,
  type RunnerDone,
  type RunnerError,
  type Shapes,
} from './protocol'
import {
  SAVE_FUNCTION_DESCRIPTION,
  formatFunction,
  formatFunctions,
  functionError,
  functionTransfer,
  functionsFor,
  parseFunction,
  signatureOf,
  usedFunctions,
  type SavedFunction,
} from './functions'

const MAX_RESULT_CHARS = 20_000
const MAX_SAVED_BYTES = 4 * 1024 * 1024 // what one $.fs.read returns
const SEARCH_LIMIT = 15
// Nested calls of one run that wait for a reply at one time: a program that
// maps over hundreds of ids must not hit a server's rate limit at once.
const MAX_PARALLEL_CALLS = 8
// How long the plugin waits for calls still running when the sandbox ends.
// An MCP call has no timeout of its own, so a call that hangs must not hold the result.
const SETTLE_MS = 1000
// The largest file saveFile writes, in characters.
const MAX_FILE_CHARS = 16 * 1024 * 1024

// No network for the sandbox process: sandbox-exec on macOS, a new network
// namespace (unshare -rn) on Linux where the kernel lets a user make one.
// Elsewhere it relies on the vm context (no fetch, no require) and --permission.
const NO_NETWORK = '(version 1)(allow default)(deny network*)'
const LAUNCH = [
  'ulimit -t "$1"',
  'if [ -x /usr/bin/sandbox-exec ]; then',
  '  exec /usr/bin/sandbox-exec -p "$2" "$3" --permission --allow-fs-read="$4" --allow-fs-read="$5" "$4" "$5"',
  'fi',
  'if unshare -rn true 2>/dev/null; then',
  '  exec unshare -rn "$3" --permission --allow-fs-read="$4" --allow-fs-read="$5" "$4" "$5"',
  'fi',
  'exec "$3" --permission --allow-fs-read="$4" --allow-fs-read="$5" "$4" "$5"',
].join('\n')
// GNU mktemp needs at least three X's at the end of the template. BSD mktemp
// adds its own suffix and keeps the X's as text, which is also safe.
const MKTEMP = ['mktemp', '-d', '-t', 'code-mode.XXXXXX']

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
const SAVE_FUNCTION = 'mcp__code-mode__save_function'
// The names a card shows as inline code when the model's reason names them.
const OWN_TOOLS = ['run_code', 'search_tools', 'add_hint', 'remove_hint', 'save_function']
// A program that did this many calls that worked, or this many to more than
// one tool, is worth a saved function.
const FUNCTION_CALLS = 10
const FUNCTION_JOIN_CALLS = 5

// Whether the band above the prompt shows the proposals (else one line), and
// which one it shows.
const reviewOpen = atom({ plugin: 'code-mode', key: 'isReviewOpen' } as const, false)
const reviewIndex = atom({ plugin: 'code-mode', key: 'reviewIndex' } as const, 0)

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

// Whether this host draws the plugin's Approve buttons (see canApprove).
async function approvalShown($: EngineInterface): Promise<boolean> {
  const [entrypoint, remote] = await Promise.all([
    $.env.get('CLAUDE_CODE_ENTRYPOINT').catch(() => undefined),
    $.env.get('CLAUDE_CODE_REMOTE').catch(() => undefined),
  ])
  return canApprove(entrypoint, remote)
}

// Per session, because one hooks module serves each session of the host (the
// desktop app runs many). `hidden`: the hints remove_hint hid (`hintRef` +
// newline + `hintKey`); they stay hidden in that session whatever the person
// decides, unless the person discards the removal. `tries`: servers whose
// calls failed and have not worked since, and search_tools queries that found
// nothing; a run that works after them is the moment to propose a hint
// (hintNudge). `failedTries` counts the runs with a failed try per server,
// for the card of a proposal. `usedTools`: tools that worked in a run that
// finished; a later run with one of them may follow a probe. `nudged`: the
// servers and tool sets a nudge named already, once each per session.
// session.end drops the entry.
// `kept`: the results of nested calls as JSON text, by number, with the time
// of the call, for recall(n) (output projection). `seen`: the first number of
// each call key, to find a call that repeats an earlier one. `metrics`: one
// JSON line per run, when on.
type Tries = { failedServers: Set<string>; missedSearches: string[]; failedTries: Map<string, number>; usedTools: Set<string>; nudged: Set<string> }
type Kept = { next: number; results: Map<number, { json: string; at: number }>; chars: number; seen: Map<string, number> }
type SessionState = { hidden: Set<string>; tries: Tries; kept: Kept; metrics: string[] }
const bySession = new Map<string, SessionState>()

async function sessionOf($: EngineInterface): Promise<SessionState> {
  const id = await $.session.id().catch(() => '')
  let state = bySession.get(id)
  if (!state) {
    state = {
      hidden: new Set(),
      tries: { failedServers: new Set(), missedSearches: [], failedTries: new Map(), usedTools: new Set(), nudged: new Set() },
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

// The result shape of each MCP tool from its last call that worked, in any
// session: search_tools shows it, so a first program need not guess it.
async function shapesPath($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME').catch(() => undefined)
  return home ? `${home}/.claude/code-mode/shapes.json` : undefined
}

async function readShapes($: EngineInterface): Promise<Shapes> {
  const path = await shapesPath($)
  return path === undefined ? {} : parseShapes(String(await $.fs.read(path).catch(() => '')))
}

// Writes only when a shape changed, so most runs write nothing.
async function saveShapes($: EngineInterface, learned: ReadonlyMap<string, string>): Promise<void> {
  const path = await shapesPath($)
  if (path === undefined || learned.size === 0) return
  const next = mergeShapes(await readShapes($), learned)
  if (next !== undefined) await $.fs.write(path, `${JSON.stringify(next, null, 2)}\n`)
}

// The argument names of each MCP tool from its calls that worked, in any
// session: search_tools shows them when no types file declares the tool, and
// the check before a run finds a name close to one of them.
async function argNamesPath($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME').catch(() => undefined)
  return home ? `${home}/.claude/code-mode/args.json` : undefined
}

async function readArgNames($: EngineInterface): Promise<ArgNames> {
  const path = await argNamesPath($)
  return path === undefined ? {} : parseArgNames(String(await $.fs.read(path).catch(() => '')))
}

async function saveArgNames($: EngineInterface, learned: ReadonlyMap<string, readonly string[]>): Promise<void> {
  const path = await argNamesPath($)
  if (path === undefined || learned.size === 0) return
  const next = mergeArgNames(await readArgNames($), learned)
  if (next !== undefined) await $.fs.write(path, `${JSON.stringify(next, null, 2)}\n`)
}

// The folder of saveFile: outside the project, so the plugin never writes
// where the person's Write rules apply. A move into the project goes through
// Bash and its permission check.
async function filesDir($: EngineInterface): Promise<string | undefined> {
  const [home, id] = await Promise.all([$.env.get('HOME').catch(() => undefined), $.session.id().catch(() => '')])
  return home ? `${home}/.claude/code-mode/files/${id || 'no-session'}` : undefined
}

// The text of a file for readFile: a file from saveFile, or a file that the
// person's Read rules let Claude Code read with no prompt. A program can send
// what it reads to an MCP tool, so a path that needs a prompt is refused.
async function readForProgram($: EngineInterface, path: string): Promise<Reply> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const full = resolvePath(path, home, await $.session.cwd())
  const stat = await $.fs.stat(full, { resolve: true }).catch(() => undefined)
  if (stat?.kind !== 'file') return { ok: false, error: `readFile: no file at ${path}` }
  const real = stat.realPath ?? full
  const dir = await filesDir($)
  const dirReal = dir === undefined ? undefined : await $.fs.stat(dir, { resolve: true }).then(s => s.realPath, () => undefined)
  const isSaved = [dir, dirReal].some(d => typeof d === 'string' && isUnder(real, d))
  if (!isSaved && (await $.tool.check({ tool: 'Read', input: { file_path: real } })).decision !== 'allow') {
    return { ok: false, error: `readFile: no permission to read ${path}; only files in the project, files a Read allow rule names, and files from saveFile` }
  }
  if (stat.size > MAX_SAVED_BYTES) return { ok: false, error: `readFile: ${path} is ${stat.size} bytes, more than readFile loads` }
  return { ok: true, value: String(await $.fs.read(real)) }
}

// The wrong names in a program's literal calls, before it runs: a write call
// early in a program must not run when a later call cannot.
async function checkProgram($: EngineInterface, code: string): Promise<string> {
  const calls = literalCalls(code).filter(c => isCallable(c.tool, $.plugin.name))
  if (calls.length === 0) return ''
  const [list, dts, learned] = await Promise.all([$.tool.list(), mcpTypes($), readArgNames($)])
  const tools = new Set(list.filter(t => t.mcp && isCallable(t.name, $.plugin.name)).map(t => t.name))
  const specOf = (tool: string) => {
    const declaration = dts === '' ? undefined : extractDeclaration(dts, tool)
    return declaration === undefined ? undefined : declarationKeys(declaration)
  }
  const problems = checkCalls(calls, tools, specOf, learned)
  return problems.length === 0 ? '' : problemReport(problems)
}

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

// Keep a decision for its row, within MAX_DECISIONS (see hints.ts).
async function rememberDecision($: EngineInterface, path: string, decision: Record<string, unknown>): Promise<void> {
  const key = decisionKey(path)
  for (const stale of staleDecisionKeys(await $.store.keys(), key)) await $.store.delete(stale)
  await $.store.set(key, decision)
}

// One decision, from the add_hint or remove_hint row or from the band: act
// on the file, remember the decision by path (the row reads it), and redraw both.
async function decidePending($: EngineInterface, path: string, action: 'approved' | 'discarded', projectHints: boolean): Promise<void> {
  const isRemoval = parseHint(String(await $.fs.read(path).catch(() => '')), path, 'user').remove !== undefined
  const dest = action === 'approved' ? await approvePending($, path, projectHints) : (await discardPending($, path), undefined)
  await rememberDecision($, path, { action, dest, isRemoval })
  $.ui.invalidate('ui.render')
}

// The folders whose files steer the model: the person's and the project's
// hints (the project's even while projectHints is off, so none can be
// planted to load later) and the person's saved functions, each as written
// and as its real path.
async function guardedHintDirs($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const root = await $.session.root()
  const dirs = [`${home}/.claude/code-mode/hints`, `${root}/.claude/code-mode/hints`, `${home}/.claude/code-mode/functions`]
    .filter(d => !d.startsWith('/.claude'))
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

// What code-mode saw in the session that made a proposal: the runs with a
// failed try on its server.
const seenText = (failures: number): string =>
  failures === 0 ? 'No failed call to this server in this session.' : `${failures} run${failures === 1 ? '' : 's'} with a failed call to this server in this session.`

// The review fields of a proposal's card, with the active file it goes to
// (or, for a removal, comes out of) and how many hints that file has now.
async function cardFields($: EngineInterface, hint: Hint): Promise<ReviewFields> {
  if (hint.remove !== undefined) {
    const bundled = hint.remove.startsWith('bundled:')
    const name = hint.remove.slice(hint.remove.lastIndexOf(bundled ? ':' : '/') + 1)
    const path = bundled ? `${$.plugin.root}/hints/${name}` : hint.remove
    const text = await $.fs.read(path).catch(() => undefined)
    const hints = text === undefined ? undefined : hintItems(parseHint(String(text), path, hint.scope).body).length
    return reviewFields(hint, { file: name, hints, isRemoval: true, isBundled: bundled })
  }
  const dest = activePathOf(hint.path)
  const file = dest.slice(dest.lastIndexOf('/') + 1)
  const current = (await $.fs.exists(dest).catch(() => false)) ? String(await $.fs.read(dest).catch(() => '')) : undefined
  const hints = current === undefined ? undefined : parseHint(current, dest, hint.scope).body.split('\n').filter(l => /^\s*[-*]\s/.test(l)).length
  return reviewFields(hint, { file, hints })
}

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code' | 'Markdown'>
type Decide = (action: 'approved' | 'discarded') => unknown

// One field of a card: a gray uppercase label over its value.
function cardField(ui: Ui, label: string, value: RenderChildren) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column">
      <Text dimColor>{label.toUpperCase()}</Text>
      {value}
    </Box>
  )
}

function cardButtons(ui: Ui, keys: { approve: string; discard: string }, decide: Decide) {
  const { Box, Button } = ui
  return (
    <Box gap={1}>
      <Button key={keys.approve} label="Approve" variant="primary" onPress={() => decide('approved')} />
      <Button key={keys.discard} label="Discard" onPress={() => decide('discarded')} />
    </Box>
  )
}

// A hint proposal's card, the same in the chat row and in the band. Names
// show as inline code; the hint and the reason are Markdown.
function hintCard(ui: Ui, hint: Hint, fields: ReviewFields, keys: { approve: string; discard: string }, decide: Decide, note?: string) {
  const { Box, Markdown, Text } = ui
  const reach = hint.scope === 'project' ? 'this project' : 'all projects'
  const names = [...hint.tools, ...hint.identify, ...OWN_TOOLS]
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
      <Markdown text={`**${hint.remove === undefined ? 'Usage hint' : 'Removal of a usage hint'}** · ${serverLabel(hint)} · ${reach}`} />
      {cardField(ui, hint.remove === undefined ? 'Hint' : 'Hint to remove', <Markdown text={hint.body} />)}
      {hint.tools.length > 0 ? cardField(ui, 'Only for tools', <Markdown text={hint.tools.map(asCode).join(', ')} />) : null}
      {fields.reason === undefined ? null : cardField(ui, "Claude's reason", <Markdown text={codeNames(fields.reason, names)} />)}
      {fields.warnings.length + (fields.seen === undefined ? 0 : 1) === 0 ? null : cardField(ui, 'Checks', (
        <Box flexDirection="column">
          {fields.warnings.map(w => <Text color="yellow">⚠ {w}</Text>)}
          {fields.seen === undefined ? null : <Text>{fields.seen}</Text>}
        </Box>
      ))}
      {cardField(ui, 'File', <Markdown text={fields.file} />)}
      {note === undefined ? null : <Text dimColor>{note}</Text>}
      {cardButtons(ui, keys, decide)}
    </Box>
  )
}

// A function proposal's card: the code to read, highlighted.
function functionCard(ui: Ui, f: SavedFunction, keys: { approve: string; discard: string }, decide: Decide) {
  const { Box, Code, Markdown, Text } = ui
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
      <Markdown text={`**Saved function** · ${asCode(`lib.${f.name}${signatureOf(f.code)}`)}`} />
      {cardField(ui, 'What it returns', <Text>{f.description}</Text>)}
      {f.why === undefined ? null : cardField(ui, "Claude's reason", <Markdown text={codeNames(f.why, OWN_TOOLS)} />)}
      {cardField(ui, 'Code', <Code source={f.code} language="javascript" />)}
      <Text dimColor>Programs can run this code in later sessions. Your approval of run_code covers its MCP calls. Approve only code you have read.</Text>
      {cardButtons(ui, keys, decide)}
    </Box>
  )
}

const HINT_GUARD_DENY =
  'code-mode: hint files and saved functions steer the model, so they cannot be written with file tools. Propose a hint with add_hint or a function with save_function instead.'

// What a hint-file guard that failed answers: it denies, and logs why.
function guardFailed($: EngineInterface, tool: string, error: { kind: string; message?: string }): { deny: string } {
  debugLog($, `the hint-file guard on ${tool} failed (${error.kind}): ${error.message ?? 'no message'}`)
  return { deny: 'code-mode: the hint-file guard failed; try again.' }
}

// Saved functions: the person's only, never the project's, because a
// function's code runs in programs. pending/ holds the proposals.
async function functionsDir($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME').catch(() => undefined)
  return home ? `${home}/.claude/code-mode/functions` : undefined
}

async function readFunctionFiles($: EngineInterface, dir: string): Promise<SavedFunction[]> {
  if (!(await $.fs.exists(dir).catch(() => false))) return []
  const entries = await $.fs.list(dir).catch(err => (debugLog($, `cannot list ${dir}: ${errorText(err)}`), []))
  const files = entries.filter(f => f.kind !== 'dir' && f.name.endsWith('.md'))
  const texts = await Promise.all(files.map(f => $.fs.read(`${dir}/${f.name}`).catch(() => '')))
  return files.flatMap((f, i) => {
    const parsed = parseFunction(String(texts[i]), `${dir}/${f.name}`)
    if (parsed === undefined) debugLog($, `${dir}/${f.name} is not a function file, so it does not load`)
    return parsed === undefined ? [] : [parsed]
  })
}

async function loadFunctions($: EngineInterface): Promise<SavedFunction[]> {
  const dir = await functionsDir($)
  return dir === undefined ? [] : readFunctionFiles($, dir)
}

async function loadFunctionProposals($: EngineInterface): Promise<SavedFunction[]> {
  const dir = await functionsDir($)
  return dir === undefined ? [] : readFunctionFiles($, `${dir}/pending`)
}

// Approve: the proposal becomes functions/<name>.md, without its reason, and
// replaces a function with that name. Discard: the proposal goes.
async function decideFunction($: EngineInterface, path: string, action: 'approved' | 'discarded'): Promise<void> {
  const proposal = parseFunction(String(await $.fs.read(path).catch(() => '')), path)
  const dir = await functionsDir($)
  let dest: string | undefined
  if (action === 'approved' && proposal !== undefined && dir !== undefined && path.startsWith(`${dir}/pending/`)) {
    dest = `${dir}/${proposal.name}.md`
    await $.fs.write(dest, formatFunction({ name: proposal.name, description: proposal.description, code: proposal.code }))
  }
  await $.process.run(['rm', '-f', path])
  await rememberDecision($, path, { action: dest === undefined ? 'discarded' : action, dest, isFunction: true })
  $.ui.invalidate('ui.render')
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
// and for the searches that found nothing. Each is named once. A finished
// run also asks for a hint when it calls again a tool of an earlier run and
// no hint covers that tool's server: the earlier run was often a probe.
async function nudgeAfter($: EngineInterface, failed: Set<string>, worked: Set<string>, projectHints: boolean): Promise<string> {
  const { tries } = await sessionOf($)
  const serverOf = (tools: Iterable<string>) => new Set([...tools].flatMap(t => splitToolName(t)?.server ?? []))
  const failedNow = serverOf(failed)
  const learned = [...serverOf(worked)].filter(s => tries.failedServers.has(s) || failedNow.has(s))
  for (const s of failedNow) tries.failedTries.set(s, (tries.failedTries.get(s) ?? 0) + 1)
  for (const s of failedNow) if (!learned.includes(s)) tries.failedServers.add(s)
  for (const s of learned) tries.failedServers.delete(s)
  for (const s of learned) tries.nudged.add(s)
  if (worked.size === 0) return ''
  const probed = await probedTools($, tries, worked, projectHints).catch(err => (debugLog($, `cannot check for a probe: ${errorText(err)}`), []))
  const nudge = hintNudge(learned, tries.missedSearches, probed)
  tries.missedSearches = []
  return nudge
}

// The tools of this run that an earlier run called too, on servers with no
// hint and no nudge yet. Each server is checked once per session.
async function probedTools($: EngineInterface, tries: Tries, worked: Set<string>, projectHints: boolean): Promise<string[]> {
  const again = [...worked].filter(t => tries.usedTools.has(t) && !tries.nudged.has(splitToolName(t)?.server ?? ''))
  for (const t of worked) tries.usedTools.add(t)
  if (again.length === 0) return []
  for (const t of again) tries.nudged.add(splitToolName(t)?.server ?? '')
  const [hints, names, list] = await Promise.all([loadHints($, projectHints), serverNames($), $.tool.list().catch(() => [])])
  const offered = toolsByServer(list.filter(t => t.mcp).map(t => t.name))
  return again.filter(t => hintsFor(hints, targetsOf([t], names, offered)).length === 0).map(t => splitToolName(t)?.name ?? t)
}

// A finished program with many calls that worked, or a join of tools, and no
// saved function asks for one; each set of tools once per session.
async function functionNudgeAfter($: EngineInterface, records: readonly CallRecord[], usesLib: boolean): Promise<string> {
  const ok = records.filter(r => r.ok)
  const tools = [...new Set(ok.map(r => r.tool))].sort()
  if (usesLib || !(ok.length >= FUNCTION_CALLS || (tools.length > 1 && ok.length >= FUNCTION_JOIN_CALLS))) return ''
  const { tries } = await sessionOf($)
  const key = `functions:${tools.join(',')}`
  if (tries.nudged.has(key)) return ''
  tries.nudged.add(key)
  return functionNudge(ok.length, tools.map(t => splitToolName(t)?.name ?? t).slice(0, 3))
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

  // The SessionStart context is hooks/session-start.sh, a command hook:
  // Claude Code skips a hooks module's classic.SessionStart.

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
    await $.tool.register({
      name: 'save_function',
      description: SAVE_FUNCTION_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A JavaScript name: programs call it as lib.<name>(args).' },
          description: { type: 'string', description: 'What it returns, in one sentence.' },
          code: { type: 'string', description: 'An async function expression with one argument, such as async ({ cloudId, jql }) => { ... }. It can use call, sleep and the other run_code functions.' },
          why: { type: 'string', description: 'Which task it did and why the task comes back, in one sentence.' },
        },
        required: ['name', 'description', 'code', 'why'],
      },
    })
    return next(e)
  })

  // save_function never activates a function: it writes a proposal under
  // functions/pending/, which loads only after the person reads the code
  // and presses Approve. The model cannot press a button.
  on('tool.call', { tool: SAVE_FUNCTION }, async ($, e) => {
    const input = e as unknown as { name?: unknown; description?: unknown; code?: unknown; why?: unknown; tool_use_id: string }
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    const oneLine = (v: unknown) => text(v).replace(/\s*\n\s*/g, ' ')
    const [name, description, code, why] = [text(input.name), oneLine(input.description), text(input.code), oneLine(input.why)]
    if (why === '' || why.length > 300) return { result: 'Error: why is one short sentence (300 characters at most).' }
    const problem = functionError(name, description, code)
    if (problem !== undefined) return { result: `Error: ${problem}.` }
    const dir = await functionsDir($)
    if (dir === undefined) return { result: 'Error: the function folder is not known (HOME is not set).' }
    const path = `${dir}/pending/${pendingFileName(`${name}.md`, input.tool_use_id)}`
    await $.fs.write(path, formatFunction({ name, description, code, why }))
    $.ui.invalidate('ui.render')
    const replaces = (await loadFunctions($)).some(f => f.name === name) ? ` It replaces the saved function ${name}.` : ''
    if (!(await approvalShown($))) {
      return { result: `Proposed the function lib.${name}.${replaces} ${TRANSFER_TEXT}\n\n${functionTransfer({ name, description, code, why })}\npending: ${path}` }
    }
    return {
      result: `Proposed the function lib.${name}.${replaces} It has no effect until the person reads it and approves it in the band above the prompt. Tell the person.\npending: ${path}`,
    }
  }).catch(($, e, next) => (debugLog($, `save_function failed (${next.error.kind}): ${next.error.message ?? 'no message'}`), { deny: 'code-mode: save_function failed; see the debug log.' }))

  // The save_function row: the code to read, with Approve and Discard.
  on('ui.render', { component: 'ToolResult', props: { tool: SAVE_FUNCTION } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const path = pendingPathOf(String(e.props.output ?? ''))
    if (path === undefined) return next(e)
    const ui = $.ui.resolve(e)
    const { Text } = ui
    const decision = (await $.store.get(decisionKey(path))) as { action: string; dest?: string } | undefined
    if (decision?.action === 'approved') return <Text color="green">✓ Function saved: {decision.dest}</Text>
    if (decision?.action === 'discarded') return <Text dimColor>Function discarded.</Text>
    const proposal = parseFunction(String(await $.fs.read(path).catch(() => '')), path)
    if (proposal === undefined) return <Text dimColor>Function proposal is no longer pending.</Text>
    return functionCard(ui, proposal, { approve: 'approve', discard: 'discard' }, action => decideFunction($, path, action))
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
      seen: seenText(failures),
      flags: [
        ...(offered.length === 0 ? ['Its server is not connected in this session.'] : []),
        ...(kind === OTHER_INSTRUCTION ? ['A classifier reads it as an instruction, not as a fact about a call.'] : []),
        ...textFlags(text, key, mcpTools.filter(t => splitToolName(t)?.server !== key)),
      ],
    }
    await $.fs.write(path, withReview(appendHint(undefined, servers, identify ? [identify] : [], tools, text), review))
    $.ui.invalidate('ui.render') // the band above the prompt counts the proposal
    if (!(await approvalShown($))) {
      return { result: `Proposed a ${scope} hint for ${servers[0]}. ${TRANSFER_TEXT}\n\n${hintTransfer({ server: isUuid && identify ? `the server with the tool ${identify}` : servers[0]!, tools, scope, text, why })}\npending: ${path}` }
    }
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
      seen: seenText(failures),
      flags: [],
    }
    const name = hint.path.slice(hint.path.lastIndexOf('/') + 1).replace(/\.md$/, '')
    const pending = `${target.dir}/pending/${pendingFileName(`${name}.remove.md`, input.tool_use_id)}`
    await $.fs.write(pending, removalProposal(hint, found.item, review))
    ;(await sessionOf($)).hidden.add(`${hintRef(hint)}\n${hintKey(found.item)}`)
    $.ui.invalidate('ui.render')
    if (!(await approvalShown($))) {
      const server = serverLabel(hint)
      return { result: `Hid the hint in this session and proposed to remove it from ${path}. ${TRANSFER_TEXT}\n\n${removalTransfer({ server, text: hintKey(found.item), why })}\npending: ${pending}` }
    }
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
    const ui = $.ui.resolve(e)
    const { Text } = ui
    const decision = (await $.store.get(decisionKey(path))) as { action: string; dest?: string; isRemoval?: boolean } | undefined

    if (decision?.action === 'approved') {
      return <Text color="green">{decision.isRemoval ? '✓ Hint removed' : '✓ Hint approved'}: {decision.dest}</Text>
    }
    if (decision?.action === 'discarded') return <Text dimColor>{decision.isRemoval ? 'Removal discarded. The hint stays.' : 'Hint discarded.'}</Text>
    if (!(await $.fs.exists(path))) return <Text dimColor>Hint proposal is no longer pending.</Text>

    const hint = parseHint(String(await $.fs.read(path)), path, await scopeOf($, path))
    const note = 'Claude sees approved hints in later sessions. Approve only what you would write yourself.'
    return hintCard(ui, hint, await cardFields($, hint), { approve: 'approve', discard: 'discard' }, action => decidePending($, path, action, projectHints), note)
  })

  // The band above the prompt: while proposals wait in pending/ (from any
  // session, a headless one included), one line with Review; opened, one
  // proposal at a time with its own Approve and Discard, and Previous and
  // Next when there are more. Nothing shows otherwise.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [pending, functions] = await Promise.all([loadPending($, projectHints), loadFunctionProposals($)])
    const total = pending.length + functions.length
    if (total === 0) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const kinds = [
      ...(pending.length === 0 ? [] : [`${pending.length} hint${pending.length === 1 ? '' : 's'}`]),
      ...(functions.length === 0 ? [] : [`${functions.length} function${functions.length === 1 ? '' : 's'}`]),
    ]

    if (!(await read($, reviewOpen))) {
      return (
        <Box gap={1} alignItems="center">
          <Text color="yellow">●</Text>
          <Text>{`${total} proposal${total === 1 ? '' : 's'} for code mode: ${kinds.join(', ')}`}</Text>
          <Button key="review" label="Review" onPress={() => update($, reviewOpen, () => true)} />
        </Box>
      )
    }

    // A decision shortens the list: the same index then shows the next one.
    const index = Math.min(await read($, reviewIndex), total - 1)
    const go = (step: number) => update($, reviewIndex, () => (index + step + total) % total)
    const card = index < pending.length
      ? hintCard(ui, pending[index]!, await cardFields($, pending[index]!), { approve: `approve-${index}`, discard: `discard-${index}` }, action => decidePending($, pending[index]!.path, action, projectHints))
      : functionCard(ui, functions[index - pending.length]!, { approve: `approve-f-${index - pending.length}`, discard: `discard-f-${index - pending.length}` }, action => decideFunction($, functions[index - pending.length]!.path, action))
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold>Code mode proposal {index + 1} of {total}</Text>
            <Box gap={1}>
              {total > 1 ? <Button key="previous" label="Previous" onPress={() => go(-1)} /> : null}
              {total > 1 ? <Button key="next" label="Next" onPress={() => go(1)} /> : null}
              <Button key="close" label="Close" role="dismiss" onPress={() => update($, reviewOpen, () => false)} />
            </Box>
          </Box>
          <Text dimColor>Approve only what you would write yourself. Approved hints guide Claude in later sessions. Approved functions run in its programs.</Text>
        </Box>
        {card}
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

    const [dts, shapes, argNames] = await Promise.all([mcpTypes($), projection ? readShapes($) : ({} as Shapes), readArgNames($)])
    const blocks = found.map(t => {
      const declaration = dts === '' ? undefined : extractDeclaration(dts, t.name)
      const names = argNames[t.name] === undefined ? '' : `names from earlier calls: {${argNames[t.name]!.join(', ')}}; `
      const args = declaration ?? `(argument types unknown here: ${names}ToolSearch "select:${t.name}" shows the schema)`
      const summary = t.description.split('\n')[0]!.slice(0, 300)
      const shape = shapes[t.name] === undefined ? '' : `\nreturns (earlier call): ${shapes[t.name]}`
      return `### ${t.name}\n${summary}\nargs: ${args}${shape}`
    })
    const [hints, names] = await Promise.all([loadHints($, projectHints), serverNames($)])
    const offered = toolsByServer(all.map(t => t.name))
    const hintText = formatHints(hintsFor(hints, targetsOf(found.map(t => t.name), names, offered)))
    const functionText = formatFunctions(functionsFor(await loadFunctions($), found.map(t => t.name), query))
    const tail = [functionText, hintText].filter(t => t !== '').map(t => `\n\n${t}`).join('')
    return { result: `${found.length} of ${all.length} MCP tools. Call them in run_code with call("<name>", args).\n\n${blocks.join('\n\n')}${tail}` }
  }).catch(($, e, next) => (debugLog($, `search_tools failed (${next.error.kind}): ${next.error.message ?? 'no message'}`), { deny: 'code-mode: search_tools failed; see the debug log.' }))

  on('tool.call', { tool: 'mcp__code-mode__run_code' }, async ($, e) => {
    const code = String((e as unknown as { code?: unknown }).code ?? '')
    if (code.trim() === '') return { result: 'Error: code is empty.' }
    const problems = await checkProgram($, code).catch(err => (debugLog($, `cannot check the program: ${errorText(err)}`), ''))
    if (problems !== '') return { result: problems }

    // The real path: Node's --permission stops a main script whose path goes
    // through a link (a linked ~/.claude or plugin folder) before it starts.
    const bundled = `${$.plugin.root}/runtime/runner.mjs`
    const runner = await $.fs.stat(bundled, { resolve: true }).then(s => s.realPath ?? bundled, () => bundled)
    // The saved functions the program names, and the ones those name.
    const saved = new Map((await loadFunctions($).catch(() => [])).map(f => [f.name, f]))
    const lib = Object.fromEntries(usedFunctions(code, saved).map(name => [name, saved.get(name)!.code]))
    const made = await $.process.run(MKTEMP)
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
    // Every call the program made, by id: one with no record when the run ends did not finish.
    const started = new Map<number, string>()
    // Set when the sandbox ends: a call still in the queue has no reader, so it does not start.
    let ended = false
    // Set when the wait for running calls ends: a late reply has no reader and its folder is removed.
    let closed = false
    const recalled: { ref: number; ageMs: number }[] = []
    let recalls = 0
    let recallMisses = 0
    const shapes = new Map<string, string>()
    const argNames = new Map<string, string[]>()
    const limit = limiter(MAX_PARALLEL_CALLS)

    const answer = async (id: number, tool: string, args: Record<string, unknown>): Promise<void> => {
      if (ended) return
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
      if (closed) return
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
      const learned = reply.ok && projection ? learnedShape(reply.value) : undefined
      if (learned !== undefined) shapes.set(tool, learned)
      if (reply.ok) argNames.set(tool, [...new Set([...(argNames.get(tool) ?? []), ...argNamesOf(args)])])
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

    // saveFile, readFile and the resources: the sandbox cannot do them, so the plugin does.
    const answerLocal = async (id: number, op: () => Promise<Reply>): Promise<void> => {
      const reply = await op().catch((err): Reply => ({ ok: false, error: errorText(err) }))
      if (closed) return
      await $.fs.write(`${xdir}/r${id}.json`, JSON.stringify(reply))
    }
    // MCP resources through Claude Code's own resource tools, with the normal
    // permission check: there is no $.mcp call for resources.
    const resourceTool = async (input: Record<string, string>): Promise<Reply> => {
      try {
        const r = await $.tool.call(input as unknown as Parameters<typeof $.tool.call>[0])
        if (r.deny !== undefined) return { ok: false, error: `denied: ${r.deny}` }
        if (r.isError === true) return { ok: false, error: r.text ?? String(r.result) }
        return await loadSaved($, { ok: true, value: toValue(r.result, r.text) })
      } catch (err) {
        const text = errorText(err)
        return { ok: false, error: /no tool named/.test(text) ? 'no MCP server in this session offers resources' : text }
      }
    }
    const readResource = async (server: string, uri: string): Promise<Reply> => {
      const reply = await resourceTool({ tool: 'ReadMcpResourceTool', server, uri })
      if (!reply.ok || reply.value === null || typeof reply.value !== 'object') return reply
      const { contents, error } = reply.value as { contents?: unknown; error?: unknown }
      if (typeof error === 'string') return { ok: false, error }
      return { ok: true, value: contents ?? reply.value }
    }
    const save = async (name: string, data: unknown): Promise<Reply> => {
      const problem = fileNameError(name)
      if (problem !== undefined) return { ok: false, error: problem }
      const text = fileText(name, data)
      if (text.length > MAX_FILE_CHARS) return { ok: false, error: `saveFile: ${text.length} characters is more than ${MAX_FILE_CHARS}; save less data` }
      const dir = await filesDir($)
      if (dir === undefined) return { ok: false, error: 'saveFile: there is no HOME folder' }
      await $.fs.write(`${dir}/${name}`, text)
      return { ok: true, value: `${dir}/${name}` }
    }

    try {
      const stream = $.process.spawn({
        argv: ['/bin/sh', '-c', LAUNCH, 'code-mode', String(timeoutSeconds), NO_NETWORK, node, runner, xdir],
        input: JSON.stringify({ code, timeoutMs: timeoutSeconds * 1000, lib }),
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
          if (m.t === 'call') {
            calls++
            started.set(m.id, m.tool)
            answers.push(limit(() => answer(m.id, m.tool, m.args)))
          } else if (m.t === 'recall') answers.push(answerRecall(m.id, m.ref))
          else if (m.t === 'save') answers.push(answerLocal(m.id, () => save(m.name, m.data)))
          else if (m.t === 'read') answers.push(answerLocal(m.id, () => readForProgram($, m.path)))
          else if (m.t === 'resources') answers.push(answerLocal(m.id, () => resourceTool({ tool: 'ListMcpResourcesTool', ...(m.server === undefined ? {} : { server: m.server }) })))
          else if (m.t === 'resource') answers.push(answerLocal(m.id, () => readResource(m.server, m.uri)))
          else outcome = m
        }
      }
      ended = true
      const stop = new AbortController()
      await Promise.race([Promise.allSettled(answers), $.clock.sleep(SETTLE_MS, { signal: stop.signal }).catch(() => undefined)])
      stop.abort()
    } catch (err) {
      stderr += `\n${errorText(err)}`
    } finally {
      ended = true
      closed = true
      await $.process.run(['rm', '-rf', xdir]).catch(() => undefined)
    }

    for (const [id, tool] of started) {
      if (records.has(id)) continue
      records.set(id, { tool, ok: false, chars: 0, unfinished: true })
      if (isCallable(tool, $.plugin.name)) failed.add(tool)
    }

    await saveShapes($, shapes).catch(err => debugLog($, `cannot write the result shapes: ${errorText(err)}`))
    await saveArgNames($, argNames).catch(err => debugLog($, `cannot write the argument names: ${errorText(err)}`))

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
    const nudge = await nudgeAfter($, isDone ? failed : new Set([...failed, ...worked]), isDone ? worked : new Set(), projectHints).catch(() => '')
    const callRecords = [...records].sort((a, b) => a[0] - b[0]).map(([, r]) => r)
    const keepNudge = isDone ? await functionNudgeAfter($, callRecords, Object.keys(lib).length > 0).catch(() => '') : ''
    const tail = [nudge, keepNudge, hintText].filter(t => t !== '').map(t => `\n\n${t}`).join('')
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

  // Guard: an active hint or a saved function is just a file, so the model
  // must not write one with its own tools, or the approval step means nothing. File tools
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
    /code-mode\/+(hints|functions)/i.test(e.command) ? { deny: HINT_GUARD_DENY } : next(e),
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
