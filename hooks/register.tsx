import { atom, read, update } from 'claude-code'
import type { Caught, Elements, EngineInterface, Register, RenderChildren } from 'claude-code'
import {
  BUNDLED_LIST,
  HINT_KINDS,
  PROPOSAL_TEXT,
  TRANSFER_TEXT,
  activePathOf,
  appendHint,
  appendItems,
  approvalKey,
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
  bundledRef,
  hiddenKey,
  hintRef,
  refTarget,
  parseDecision,
  type Decision,
  type HiddenKey,
  type HintEdit,
  hintsFor,
  hintApplies,
  isApprovalKey,
  isUnder,
  isUnderAnyCase,
  isUuidLike,
  kindQuestion,
  newHintFlags,
  normalize,
  oneLine,
  parseBundledList,
  parseHint,
  pendingFileName,
  proposalKind,
  decisionKey,
  pendingPathOf,
  parseRemoved,
  removalProposal,
  removalTransfer,
  removeFromFile,
  replaceInFile,
  resolvePath,
  reviewFields,
  sameReach,
  serverKeyOf,
  serverLabel,
  staleDecisionKeys,
  targetsOf,
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
  approvalNote,
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
  shownText,
  splitToolName,
  takeMessages,
  toValue,
  UNTYPED_NOTE,
  type ArgNames,
  type CallRecord,
  type Projection,
  type Reply,
  type RunnerDone,
  type RunnerError,
  type Shapes,
} from './protocol'
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
} from './functions'
import { codeModePath, functionsFolder, guardedDirs, hintsFolder, normalizePath } from './paths'
import { SEARCH_LIMIT, TOOL, TOOL_NAMES, parseInput, registration } from './tools'

const MAX_RESULT_CHARS = 20_000
const MAX_SAVED_BYTES = 4 * 1024 * 1024 // what one $.fs.read returns
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
// env -i starts Node with no environment variables, so a program that gets out
// of the vm context cannot read secrets there. env -i also clears PATH, so the
// shell finds node first. A version-manager shim is a script that needs the
// environment, so the shell asks it for the real binary.
const NO_NETWORK = '(version 1)(allow default)(deny network*)'
const LAUNCH = [
  'ulimit -t "$1"',
  'profile=$2',
  'node=$(command -v "$3") || { echo "code-mode: $3: not found" >&2; exit 127; }',
  'case $(head -c 2 "$node") in "#!") node=$("$node" -p process.execPath) || exit 127 ;; esac',
  'set -- env -i "$node" --permission --allow-fs-read="$4" --allow-fs-read="$5" "$4" "$5"',
  'if [ -x /usr/bin/sandbox-exec ]; then',
  '  exec /usr/bin/sandbox-exec -p "$profile" "$@"',
  'fi',
  'if unshare -rn true 2>/dev/null; then',
  '  exec unshare -rn "$@"',
  'fi',
  'exec "$@"',
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

// A program that did this many calls that worked, or this many to more than
// one tool, is worth a saved function.
const FUNCTION_CALLS = 10
const FUNCTION_JOIN_CALLS = 5

// Whether the band above the prompt shows the proposals (else one line),
// which one it shows, and the result of the last decision in it.
const reviewOpen = atom({ plugin: 'code-mode', key: 'isReviewOpen' } as const, false)
const reviewIndex = atom({ plugin: 'code-mode', key: 'reviewIndex' } as const, 0)
const reviewResult = atom({ plugin: 'code-mode', key: 'reviewResult' } as const, null)

// The person's HOME, or '' when it is not set.
async function homeOf($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME').catch(() => undefined)) ?? ''
}

// Hint folders. Bundled and user hints always load; project hints come from
// the repository, so anyone who can commit there could steer the model: they
// load only when the person turns `projectHints` on.
async function hintDirs($: EngineInterface, projectHints: boolean): Promise<{ scope: HintScope; dir: string }[]> {
  const home = await homeOf($)
  const dirs: { scope: HintScope; dir: string }[] = [{ scope: 'bundled', dir: `${$.plugin.root}/hints` }]
  if (home) dirs.push({ scope: 'user', dir: hintsFolder(home) })
  if (projectHints) dirs.push({ scope: 'project', dir: hintsFolder(await $.session.root()) })
  return dirs
}

// The user hint folder, or undefined when HOME is not set.
const userHintDir = async ($: EngineInterface): Promise<string | undefined> =>
  (await hintDirs($, false)).find(d => d.scope === 'user')?.dir

// The scope of a proposal: a pending file is in the user or the project hint
// folder, and a project is often under HOME, so test the user folder itself.
async function scopeOf($: EngineInterface, path: string): Promise<HintScope> {
  const userDir = await userHintDir($)
  return userDir !== undefined && isUnder(path, userDir) ? 'user' : 'project'
}

// The .md files directly in dir, with their text: '' for a file that cannot
// be read. A folder that is not there has none; one that cannot be listed
// gives undefined, so a caller can tell it from an empty folder.
async function readMdFiles($: EngineInterface, dir: string): Promise<{ path: string; text: string }[] | undefined> {
  if (!(await $.fs.exists(dir).catch(() => false))) return []
  const entries = await $.fs.list(dir).catch(err => (debugLog($, `cannot list ${dir}: ${errorText(err)}`), undefined))
  if (entries === undefined) return undefined
  const paths = entries.filter(f => f.kind !== 'dir' && f.name.endsWith('.md')).map(f => `${dir}/${f.name}`)
  return Promise.all(
    paths.map(async path => ({
      path,
      text: String(await $.fs.read(path).catch(err => (debugLog($, `cannot read ${path}: ${errorText(err)}`), ''))),
    })),
  )
}

// Active files split by the ledger: the ones whose text an Approve wrote, and the rest.
async function splitApproved<F extends { path: string; text: string }>(
  $: EngineInterface,
  files: readonly F[],
): Promise<{ approved: F[]; unapproved: F[] }> {
  const ok = await Promise.all(files.map(f => isApproved($, f.path, f.text)))
  return { approved: files.filter((f, i) => ok[i]), unapproved: files.filter((f, i) => !ok[i]) }
}

// For a loader: only the approved files. The debug log names the others, so
// a person can find out why a hint never shows.
async function approvedFiles(
  $: EngineInterface,
  files: readonly { path: string; text: string }[],
): Promise<{ path: string; text: string }[]> {
  const { approved, unapproved } = await splitApproved($, files)
  for (const f of unapproved) debugLog($, `${f.path} is not approved: no Approve wrote its text, so it does not load`)
  return approved
}

type MdFiles = { path: string; text: string }[]

// For the loader of bundled hints: only the files whose hash is in the
// bundled list (BUNDLED_LIST). A list that cannot be read lists nothing.
async function listedBundled($: EngineInterface, dir: string, files: MdFiles): Promise<MdFiles> {
  if (files.length === 0) return []
  const list = parseBundledList(
    String(
      await $.fs
        .read(`${dir}/${BUNDLED_LIST}`)
        .catch(err => (debugLog($, `cannot read the bundled list: ${errorText(err)}`), '')),
    ),
  )
  const hashes = await Promise.all(files.map(f => sha256Hex(f.text)))
  return files.filter((f, i) => {
    const listed = list[f.path.slice(dir.length + 1)] === hashes[i]
    if (!listed) debugLog($, `${f.path} is not in the bundled list ${BUNDLED_LIST} with this text, so it does not load`)
    return listed
  })
}

// A file that cannot be read, or that applies to no server, loads as nothing.
// The debug log says which. `keep` drops the files that may not load.
async function readHintFiles(
  $: EngineInterface,
  dir: string,
  scope: HintScope,
  keep: (files: MdFiles) => Promise<MdFiles> = async files => files,
): Promise<Hint[]> {
  const files = await keep((await readMdFiles($, dir)) ?? [])
  return files.map(f => {
    const hint = parseHint(f.text, f.path, scope)
    if (hint.servers.length + hint.identify.length + hint.tools.length === 0 && hint.edit === undefined) {
      debugLog($, `${hint.path} names no servers, identify or tools in its frontmatter, so it applies to no server`)
    }
    return hint
  })
}

// Bundled hints load when the list that ships with them has their hash; user
// and project hints when an Approve wrote their text.
async function loadHintFiles($: EngineInterface, projectHints: boolean): Promise<Hint[]> {
  const dirs = await hintDirs($, projectHints)
  const keep = (dir: string, scope: HintScope) => (files: MdFiles) =>
    scope === 'bundled' ? listedBundled($, dir, files) : approvedFiles($, files)
  return (await Promise.all(dirs.map(d => readHintFiles($, d.dir, d.scope, keep(d.dir, d.scope))))).flat()
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
// desktop app runs many). `hidden`: the hints remove_hint hid (`hiddenKey`);
// they stay hidden in that session whatever the person decides, unless the
// person discards the removal. `tries`: servers whose
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
type Tries = {
  failedServers: Set<string>
  missedSearches: string[]
  failedTries: Map<string, number>
  usedTools: Set<string>
  nudged: Set<string>
}
type Kept = {
  next: number
  results: Map<number, { json: string; at: number }>
  chars: number
  seen: Map<string, number>
}
type SessionState = { hidden: Set<HiddenKey>; tries: Tries; kept: Kept; metrics: string[] }
const bySession = new Map<string, SessionState>()

async function sessionOf($: EngineInterface): Promise<SessionState> {
  const id = await $.session.id().catch(() => '')
  // Without a session id, state kept under '' would reach every other session
  // with no id: each call gets its own state, which ends with its run.
  if (id === '') return newSessionState()
  let state = bySession.get(id)
  if (!state) {
    state = newSessionState()
    bySession.set(id, state)
  }
  return state
}

const newSessionState = (): SessionState => ({
  hidden: new Set(),
  tries: {
    failedServers: new Set(),
    missedSearches: [],
    failedTries: new Map(),
    usedTools: new Set(),
    nudged: new Set(),
  },
  kept: newKept(),
  metrics: [],
})

const newKept = (): Kept => ({ next: 1, results: new Map(), chars: 0, seen: new Map() })

// What one session keeps for recall(n): the newest results, up to these
// limits. About 10 MB per session, and the desktop app runs many sessions in
// one process.
const MAX_KEPT = 50
const MAX_KEPT_CHARS = 8_000_000
const MAX_SEEN = 2000

// Keeps a result from time `at` and returns its number; the oldest results go
// first. A result larger than the whole limit is not kept.
function keep(kept: Kept, json: string, at: number): number | undefined {
  if (json.length > MAX_KEPT_CHARS) return undefined
  const ref = kept.next++
  kept.results.set(ref, { json, at })
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
  const [home, id, now] = await Promise.all([homeOf($), $.session.id().catch(() => ''), $.clock.now()])
  if (!home || id === '') return
  state.metrics.push(JSON.stringify({ ts: new Date(now).toISOString(), ...line }))
  await $.fs.write(codeModePath(home, 'metrics', `${id}.jsonl`), `${state.metrics.join('\n')}\n`)
}

const removedFile = (userDir: string): string => `${userDir}/removed.json`

// The text of a file, or undefined when there is none. A file that exists
// but cannot be read throws: an approval must not write over it.
async function readIfExists($: EngineInterface, path: string): Promise<string | undefined> {
  return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// The approval ledger: for each active hint or function file, the SHA-256 of
// the text an Approve wrote, so a file that another tool wrote or changed can
// be told from an approved one. An Approve writes or removes an active file
// only through these two. The ledger changes first: when the file step then
// fails, the file and its hash differ, and the file counts as not approved.
const ledgerKey = async (path: string): Promise<string> => approvalKey(await sha256Hex(path))

async function recordApproval($: EngineInterface, path: string, text: string): Promise<void> {
  await $.store.set(await ledgerKey(path), { path, sha256: await sha256Hex(text) })
}

async function writeApproved($: EngineInterface, path: string, text: string): Promise<void> {
  await recordApproval($, path, text)
  await $.fs.write(path, text)
}

async function removeApproved($: EngineInterface, path: string): Promise<void> {
  await $.store.delete(await ledgerKey(path))
  await $.process.run(['rm', '-f', path])
}

// Approvals run one at a time in this hooks module, which serves every
// session of the host: two that change one file, each from its own
// proposal, must not mix their reads, hashes and writes. Approvals from
// another process can still overlap; then the hash and the file differ, and
// the file waits in the band (fail closed).
let approvalQueue: Promise<unknown> = Promise.resolve()
function oneApprovalAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = approvalQueue.then(work, work)
  approvalQueue = run.catch(() => undefined)
  return run
}

// True when the ledger has the hash of this text for this path. A ledger
// that cannot be read approves nothing.
async function isApproved($: EngineInterface, path: string, text: string): Promise<boolean> {
  let entry: { path?: unknown; sha256?: unknown } | undefined
  try {
    entry = (await $.store.get(await ledgerKey(path))) as typeof entry
  } catch {
    return false
  }
  return entry?.path === path && entry.sha256 === (await sha256Hex(text))
}

// An Approve that merges into an active file must not approve text in it
// that nobody reviewed: a file with text and no matching hash fails it.
async function assertApproved($: EngineInterface, path: string, text: string | undefined): Promise<void> {
  if (text !== undefined && text.trim() !== '' && !(await isApproved($, path, text)))
    throw new Error(`${path} is not approved: approve or discard it in the band first`)
}

// What runs learn about each MCP tool, in a JSON file in ~/.claude/code-mode
// that every session shares. `parse` drops what the plugin cannot have
// written; `merge` gives undefined when a run learned nothing new.
type Learned<T, L extends ReadonlyMap<string, unknown>> = {
  file: string
  parse: (text: string) => T
  merge: (current: T, learned: L) => T | undefined
}

// The result shape of each MCP tool from its last call that worked:
// search_tools shows it, so a first program need not guess it.
const SHAPES: Learned<Shapes, ReadonlyMap<string, string>> = {
  file: 'shapes.json',
  parse: parseShapes,
  merge: mergeShapes,
}

// The argument names of each MCP tool from its calls that worked:
// search_tools shows them when no types file declares the tool, and the
// check before a run finds a name close to one of them.
const ARG_NAMES: Learned<ArgNames, ReadonlyMap<string, readonly string[]>> = {
  file: 'args.json',
  parse: parseArgNames,
  merge: mergeArgNames,
}

async function learnedPath($: EngineInterface, file: string): Promise<string | undefined> {
  const home = await homeOf($)
  return home ? codeModePath(home, file) : undefined
}

async function readLearned<T, L extends ReadonlyMap<string, unknown>>(
  $: EngineInterface,
  store: Learned<T, L>,
): Promise<T> {
  const path = await learnedPath($, store.file)
  return store.parse(path === undefined ? '' : String(await $.fs.read(path).catch(() => '')))
}

// Writes only when something changed, so most runs write nothing.
async function saveLearned<T, L extends ReadonlyMap<string, unknown>>(
  $: EngineInterface,
  store: Learned<T, L>,
  learned: L,
): Promise<void> {
  const path = await learnedPath($, store.file)
  if (path === undefined || learned.size === 0) return
  const next = store.merge(await readLearned($, store), learned)
  if (next !== undefined) await $.fs.write(path, `${JSON.stringify(next, null, 2)}\n`)
}

// The folder of saveFile: outside the project, so the plugin never writes
// where the person's Write rules apply. A move into the project goes through
// Bash and its permission check.
async function filesDir($: EngineInterface): Promise<string | undefined> {
  const [home, id] = await Promise.all([homeOf($), $.session.id().catch(() => '')])
  return home ? codeModePath(home, 'files', id || 'no-session') : undefined
}

// The text of a file for readFile: a file from saveFile, or a file that the
// person's Read rules let Claude Code read with no prompt. A program can send
// what it reads to an MCP tool, so a path that needs a prompt is refused.
async function readForProgram($: EngineInterface, path: string): Promise<Reply> {
  const home = await homeOf($)
  const full = resolvePath(path, home, await $.session.cwd())
  const stat = await $.fs.stat(full, { resolve: true }).catch(() => undefined)
  if (stat?.kind !== 'file') return { ok: false, error: `readFile: no file at ${path}` }
  const real = stat.realPath ?? full
  const dir = await filesDir($)
  const dirReal =
    dir === undefined
      ? undefined
      : await $.fs.stat(dir, { resolve: true }).then(
          s => s.realPath,
          () => undefined,
        )
  const isSaved = [dir, dirReal].some(d => typeof d === 'string' && isUnder(real, d))
  if (!isSaved && (await $.tool.check({ tool: 'Read', input: { file_path: real } })).decision !== 'allow') {
    return {
      ok: false,
      error: `readFile: no permission to read ${path}; only files in the project, files a Read allow rule names, and files from saveFile`,
    }
  }
  if (stat.size > MAX_SAVED_BYTES)
    return { ok: false, error: `readFile: ${path} is ${stat.size} bytes, more than readFile loads` }
  return { ok: true, value: String(await $.fs.read(real)) }
}

// The wrong names in a program's literal calls, before it runs: a write call
// early in a program must not run when a later call cannot.
async function checkProgram($: EngineInterface, code: string): Promise<string> {
  const calls = literalCalls(code).filter(c => isCallable(c.tool, $.plugin.name))
  if (calls.length === 0) return ''
  const [list, dts, learned] = await Promise.all([$.tool.list(), mcpTypes($), readLearned($, ARG_NAMES)])
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
  const [hints, { hidden }, dirs] = await Promise.all([
    loadHintFiles($, projectHints),
    sessionOf($),
    hintDirs($, projectHints),
  ])
  const userDir = dirs.find(d => d.scope === 'user')?.dir
  const removedText = userDir === undefined ? '' : await $.fs.read(removedFile(userDir)).catch(() => '')
  const removed = new Set(parseRemoved(String(removedText)).map(r => hiddenKey(bundledRef(r.file), r.hint)))
  return hints.flatMap(h => {
    const ref = hintRef(h)
    const drop = (key: string) => {
      const k = hiddenKey(ref, key)
      return hidden.has(k) || removed.has(k)
    }
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

// The user file that a change of a bundled hint writes the new hint to: the
// file of the same name, or, when that file is for other servers or tools,
// <name>-changed.md, then <name>-changed-2.md and so on, so the new hint keeps
// the bundled reach. The card names the same file. Gives the file's text too.
async function bundledChangeFile(
  $: EngineInterface,
  userDir: string,
  file: string,
  hint: Hint,
): Promise<{ path: string; text: string | undefined }> {
  const base = `${userDir}/${file.replace(/\.md$/, '')}`
  for (let n = 0; ; n++) {
    const path = n === 0 ? `${base}.md` : `${base}-changed${n === 1 ? '' : `-${n}`}.md`
    const text = await readIfExists($, path)
    if (text === undefined || text.trim() === '' || sameReach(parseHint(text, path, 'user'), hint))
      return { path, text }
  }
}

// The name of the user file for the card, or undefined when the user hint
// folder cannot be read: then Approve fails too, and the card says so.
async function bundledChangeName($: EngineInterface, file: string, hint: Hint): Promise<string | undefined> {
  const userDir = await userHintDir($)
  const own = userDir === undefined ? undefined : await bundledChangeFile($, userDir, file, hint).catch(() => undefined)
  return own?.path.slice(own.path.lastIndexOf('/') + 1)
}

// Approve a removal: take the hint out of its file (and remove a file with no
// hint left), or, for a bundled hint, add it to removed.json. A change puts
// the new hint in its place: in the same file, or, for a bundled hint, in the
// user file that bundledChangeFile gives. The file must be directly in a hint folder: a
// pending file names it, and a pending file is only as safe as the folder it is in.
async function approveRemoval($: EngineInterface, hint: Hint, edit: HintEdit, projectHints: boolean): Promise<string> {
  const target = refTarget(edit.ref)
  const key = hintKey(hint.body)
  const dirs = await hintDirs($, projectHints)
  const userDir = dirs.find(d => d.scope === 'user')?.dir
  // The new hint at the end of a file, with the old hint's frontmatter when the file is new or empty.
  const withNew = (text: string | undefined, newText: string) =>
    appendHint(text, hint.servers, hint.identify, hint.tools, newText)
  if (target.bundled) {
    const { file } = target
    if (userDir === undefined || !/^[\w.-]+\.md$/.test(file)) throw new Error(`not a bundled hint file: ${edit.ref}`)
    // The new hint first: if a write fails, the old hint still shows.
    const path = removedFile(userDir)
    let dest = path
    if (edit.kind === 'change') {
      const own = await bundledChangeFile($, userDir, file, hint)
      await assertApproved($, own.path, own.text)
      await writeApproved($, own.path, withNew(own.text, edit.text))
      dest = own.path
    }
    const removed = parseRemoved(String(await $.fs.read(path).catch(() => '')))
    if (!removed.some(r => r.file === file && r.hint === key)) removed.push({ file, hint: key })
    await $.fs.write(path, `${JSON.stringify(removed, null, 2)}\n`)
    return dest
  }
  const { path } = target
  const dir = dirs.find(
    d => d.scope !== 'bundled' && path.startsWith(`${d.dir}/`) && !path.slice(d.dir.length + 1).includes('/'),
  )
  if (dir === undefined || !path.endsWith('.md')) throw new Error(`not a hint file: ${path}`)
  const text = await readIfExists($, path)
  await assertApproved($, path, text)
  if (edit.kind === 'change') {
    await writeApproved(
      $,
      path,
      (text === undefined ? undefined : replaceInFile(text, key, edit.text)) ?? withNew(text, edit.text),
    )
    return path
  }
  if (text === undefined) return path
  const rest = removeFromFile(text, key)
  if (rest === undefined) await removeApproved($, path)
  else await writeApproved($, path, rest)
  return path
}

// Approve: merge the proposal's bullets into the active file beside pending/
// (or move the whole file when there is none yet), then remove the proposal.
// A bullet the file has already is not added again (see appendItems).
// `proposal` is the text the card showed (see cardText).
async function approvePending(
  $: EngineInterface,
  path: string,
  proposal: string,
  projectHints: boolean,
): Promise<string> {
  const hint = parseHint(proposal, path, 'user')
  if (hint.edit !== undefined) {
    const dest = await approveRemoval($, hint, hint.edit, projectHints)
    await $.process.run(['rm', '-f', path])
    return dest
  }
  const dest = activePathOf(path)
  const current = await readIfExists($, dest)
  await assertApproved($, dest, current)
  const text =
    current === undefined || current.trim() === ''
      ? withoutReview(proposal)
      : appendItems(current, hintItems(hint.body))
  if (text !== current) await writeApproved($, dest, text)
  await $.process.run(['rm', '-f', path])
  return dest
}

// Discard: delete the proposal. A discarded removal also shows the hint
// again in the session that hid it.
async function discardPending($: EngineInterface, path: string, proposal: string): Promise<void> {
  const hint = parseHint(proposal, path, 'user')
  if (hint.edit !== undefined)
    for (const { hidden } of bySession.values()) hidden.delete(hiddenKey(hint.edit.ref, hintKey(hint.body)))
  await $.process.run(['rm', '-f', path])
}

type Action = Decision['action']

// The line a decided proposal shows, in its row and in the band: green when
// approved, dim otherwise (no color).
type Shown = { text: string; color?: 'green' | 'red' }
function decisionShown(d: Decision): Shown {
  const color = d.action === 'approved' ? { color: 'green' as const } : {}
  if (d.kind === 'function')
    return { text: d.action === 'approved' ? `✓ Function saved: ${d.dest}` : 'Function discarded.', ...color }
  const words = PROPOSAL_TEXT[d.kind]
  return { text: d.action === 'approved' ? `${words.approved}: ${d.dest}` : words.discarded, ...color }
}

// Keep a decision for its row, within MAX_DECISIONS (see hints.ts).
async function rememberDecision($: EngineInterface, path: string, decision: Decision): Promise<void> {
  const key = decisionKey(path)
  await Promise.all(staleDecisionKeys(await $.store.keys(), key).map(stale => $.store.delete(stale)))
  await $.store.set(key, decision)
}

// One decision, from a row or from the band: act on the file, remember the
// decision by path (the row reads it), and redraw both. A second press on the
// same proposal (a double click, or a press before the redraw) gets undefined
// and changes nothing: the hint is not added two times.
const deciding = new Set<string>()
async function decideOnce(
  $: EngineInterface,
  path: string,
  decide: () => Promise<Decision>,
): Promise<Decision | undefined> {
  if (deciding.has(path)) return undefined
  deciding.add(path)
  try {
    if (!(await $.fs.exists(path).catch(() => false))) return undefined
    const decision = await oneApprovalAtATime(decide)
    await rememberDecision($, path, decision)
    $.ui.invalidate('ui.render')
    return decision
  } finally {
    deciding.delete(path)
  }
}

// The proposal text that a card showed, when its file still has it. Approve
// and Discard act on this text and fail when the file changed after the card
// drew it, so the person decides on the text they read (as decideUnapproved).
async function cardText($: EngineInterface, path: string, shown: string): Promise<string> {
  if ((await readIfExists($, path)) !== shown)
    throw new Error(`${path} changed after the card showed it; review it again`)
  return shown
}

function decidePending(
  $: EngineInterface,
  path: string,
  shown: string,
  action: Action,
  projectHints: boolean,
): Promise<Decision | undefined> {
  return decideOnce($, path, async () => {
    const proposal = await cardText($, path, shown)
    const hint = parseHint(proposal, path, 'user')
    const dest =
      action === 'approved'
        ? await approvePending($, path, proposal, projectHints)
        : (await discardPending($, path, proposal), undefined)
    return { action, dest, kind: proposalKind(hint) }
  })
}

// The folders whose files steer the model (guardedDirs in paths.ts), each as
// written and in real form: HOME or a root can be a symbolic link.
async function guardedHintDirs($: EngineInterface, home: string): Promise<string[]> {
  const dirs = guardedDirs(home, await $.session.root(), $.plugin.root)
  const real = await Promise.all(dirs.map(d => realFormOf($, d)))
  return [...dirs, ...real.filter((r): r is string => typeof r === 'string')]
}

function realPathOf($: EngineInterface, path: string): Promise<string | undefined> {
  return $.fs.stat(path, { resolve: true }).then(
    s => s.realPath,
    () => undefined,
  )
}

// An absolute path in real form: the real path of its nearest folder that
// exists, then the rest of the path. A write makes the missing folders under
// that real folder, so a symbolic link above them decides where it lands.
async function realFormOf($: EngineInterface, path: string): Promise<string | undefined> {
  for (let head = path; ; head = head.slice(0, head.lastIndexOf('/')) || '/') {
    const real = await realPathOf($, head)
    if (real !== undefined) return normalizePath(`${real}/${path.slice(head.length)}`)
    if (head === '/') return undefined
  }
}

// Where an absolute path can land: as written, in real form, or under its
// parent's real form. The file itself can be a symbolic link out of the folder,
// and the write still names a file in that folder.
async function landings($: EngineInterface, full: string): Promise<string[]> {
  const parent = full.slice(0, full.lastIndexOf('/')) || '/'
  const [self, dir] = await Promise.all([realFormOf($, full), realFormOf($, parent)])
  const candidates = [
    full,
    self,
    dir === undefined ? undefined : normalizePath(`${dir}/${full.slice(parent.length + 1)}`),
  ]
  return candidates.filter((c): c is string => typeof c === 'string')
}

// True when a file tool's path lands in a hint folder, in any letter case
// (isUnderAnyCase): a case-insensitive volume opens the folder for each.
async function touchesHints($: EngineInterface, filePath: string): Promise<boolean> {
  const [home, cwd] = await Promise.all([homeOf($), $.session.cwd()])
  const [candidates, dirs] = await Promise.all([
    landings($, resolvePath(filePath, home, cwd)),
    guardedHintDirs($, home),
  ])
  return candidates.some(c => dirs.some(d => isUnderAnyCase(c, d)))
}

// What code-mode saw in the session that made a proposal: the runs with a
// failed try on its server.
const seenText = (failures: number): string =>
  failures === 0
    ? 'No failed call to this server in this session.'
    : `${failures} run${failures === 1 ? '' : 's'} with a failed call to this server in this session.`

// How many hints the file at path has now, or undefined when it cannot be read.
async function hintCount($: EngineInterface, path: string, scope: HintScope): Promise<number | undefined> {
  const text = await $.fs.read(path).catch(() => undefined)
  return text === undefined ? undefined : hintItems(parseHint(String(text), path, scope).body).length
}

// The review fields of a proposal's card, with the active file it goes to
// (or, for a removal, comes out of) and how many hints that file has now.
async function cardFields($: EngineInterface, hint: Hint): Promise<ReviewFields> {
  if (hint.edit !== undefined) {
    const target = refTarget(hint.edit.ref)
    const path = target.bundled ? `${$.plugin.root}/hints/${target.file}` : target.path
    // A change of a bundled hint names the user file that Approve writes.
    const [hints, ownFile] = await Promise.all([
      hintCount($, path, hint.scope),
      target.bundled && hint.edit.kind === 'change' ? bundledChangeName($, target.file, hint) : undefined,
    ])
    return reviewFields(hint, {
      file: target.file,
      hints,
      kind: proposalKind(hint),
      isBundled: target.bundled,
      ownFile,
    })
  }
  const dest = activePathOf(hint.path)
  const file = dest.slice(dest.lastIndexOf('/') + 1)
  return reviewFields(hint, { file, hints: await hintCount($, dest, hint.scope) })
}

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code' | 'Markdown'>
type Decide = (action: Action) => unknown

// The line of a decision, in a row or in the band: no color shows dim.
const shownLine = (ui: Ui, shown: Shown) => (
  <ui.Text color={shown.color} dimColor={shown.color === undefined}>
    {shown.text}
  </ui.Text>
)

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
// show as inline code; the hint and the reason are Markdown. `buttons` go
// at the end in the row; the band shows them in its top row instead.
function hintCard(ui: Ui, hint: Hint, fields: ReviewFields, buttons: RenderChildren, note?: string) {
  const { Box, Markdown, Text } = ui
  const reach = hint.scope === 'project' ? 'this project' : 'all projects'
  const names = [...hint.tools, ...hint.identify, ...TOOL_NAMES]
  const words = PROPOSAL_TEXT[proposalKind(hint)]
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
      <Markdown text={`**${words.title}** · ${serverLabel(hint)} · ${reach}`} />
      {cardField(ui, words.label, <Markdown text={hint.body} />)}
      {hint.edit?.kind === 'change' ? cardField(ui, 'New hint', <Markdown text={`- ${hint.edit.text}`} />) : null}
      {hint.tools.length > 0
        ? cardField(ui, 'Only for tools', <Markdown text={hint.tools.map(asCode).join(', ')} />)
        : null}
      {fields.reason === undefined
        ? null
        : cardField(ui, "Claude's reason", <Markdown text={codeNames(fields.reason, names)} />)}
      {fields.warnings.length + (fields.seen === undefined ? 0 : 1) === 0
        ? null
        : cardField(
            ui,
            'Checks',
            <Box flexDirection="column">
              {fields.warnings.map(w => (
                <Text color="yellow">⚠ {w}</Text>
              ))}
              {fields.seen === undefined ? null : <Text>{fields.seen}</Text>}
            </Box>,
          )}
      {cardField(ui, 'File', <Markdown text={fields.file} />)}
      {note === undefined ? null : <Text dimColor>{note}</Text>}
      {buttons}
    </Box>
  )
}

// A function proposal's card: the code to read, highlighted. A proposal that
// replaces a saved function (`current`) shows the code as a diff from it.
// `buttons` as for hintCard.
function functionCard(ui: Ui, f: SavedFunction, current: SavedFunction | undefined, buttons: RenderChildren) {
  const { Box, Code, Markdown, Text } = ui
  const before =
    current !== undefined && current.description !== f.description ? (
      <Text dimColor>{`Now: ${current.description}`}</Text>
    ) : null
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
      <Markdown
        text={`**${current === undefined ? 'Saved function' : 'Change of a saved function'}** · ${asCode(`lib.${f.name}${signatureOf(f.code)}`)}`}
      />
      {cardField(
        ui,
        'What it returns',
        <Box flexDirection="column">
          <Text>{f.description}</Text>
          {before}
        </Box>,
      )}
      {f.why === undefined ? null : cardField(ui, "Claude's reason", <Markdown text={codeNames(f.why, TOOL_NAMES)} />)}
      {current === undefined
        ? cardField(ui, 'Code', <Code source={f.code} language="javascript" />)
        : cardField(
            ui,
            'Code changes',
            <Code source={codeDiff(current.code, f.code)} language="javascript" format="diff" />,
          )}
      <Text dimColor>
        Programs can run this code in later sessions. Your approval of run_code covers its MCP calls. Approve only code
        you have read.
      </Text>
      {buttons}
    </Box>
  )
}

// The band's card of a file that is not approved: its whole text, as Approve
// approves all of it.
function unapprovedCard(ui: Ui, file: Unapproved) {
  const { Box, Code, Markdown, Text } = ui
  const what = file.kind === 'function' ? 'Saved function' : 'Hint file'
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
      <Markdown text={`**${what} not approved** · ${file.scope === 'project' ? 'this project' : 'all projects'}`} />
      <Text dimColor>
        This file was written or changed outside an Approve. It does not load until you approve it. Discard deletes it.
      </Text>
      {cardField(ui, 'File', <Markdown text={asCode(file.path)} />)}
      {cardField(ui, 'Text', <Code source={file.text} language="markdown" />)}
    </Box>
  )
}

const HINT_GUARD_DENY =
  'code-mode: hint files and saved functions steer the model, so they cannot be written with file tools. Propose a hint with add_hint, a change of one with edit_hint, or a new or changed function with save_function instead.'

// The .catch of each tool.call hook here: it fails closed. A hook that passed
// the call on before it failed (next.called) keeps that answer. Any other
// failure denies the call, and the debug log says why. A tool that is not one
// of this plugin's is a file tool, and its hook is the hint-file guard. The
// engine takes only a function literal or a function name as a .catch handler.
function failClosed<E extends { tool: string }, R>(
  $: EngineInterface,
  e: E,
  next: ((e: E) => R) & Caught,
): R | { deny: string } {
  if (next.called) return next(e)
  const own = TOOL_NAMES.find(n => TOOL[n] === e.tool)
  debugLog(
    $,
    `${own ?? `the hint-file guard on ${e.tool}`} failed (${next.error.kind}): ${next.error.message ?? 'no message'}`,
  )
  return {
    deny:
      own === undefined
        ? 'code-mode: the hint-file guard failed; try again.'
        : `code-mode: ${own} failed; see the debug log.`,
  }
}

// Saved functions: the person's only, never the project's, because a
// function's code runs in programs. pending/ holds the proposals.
async function functionsDir($: EngineInterface): Promise<string | undefined> {
  const home = await homeOf($)
  return home ? functionsFolder(home) : undefined
}

// `active`: load only approved files (approvedFiles).
async function readFunctionFiles($: EngineInterface, dir: string, active = false): Promise<SavedFunction[]> {
  const read = (await readMdFiles($, dir)) ?? []
  const files = active ? await approvedFiles($, read) : read
  return files.flatMap(f => {
    const parsed = parseFunction(f.text, f.path)
    if (parsed === undefined) debugLog($, `${f.path} is not a function file, so it does not load`)
    return parsed === undefined ? [] : [parsed]
  })
}

async function loadFunctions($: EngineInterface): Promise<SavedFunction[]> {
  const dir = await functionsDir($)
  return dir === undefined ? [] : readFunctionFiles($, dir, true)
}

// An active hint or function file that no Approve wrote as it is now: planted
// by another tool, changed after its Approve, or older than the ledger.
type Unapproved = { path: string; text: string; kind: 'hint' | 'function'; scope: HintScope }

// The files the band asks the person to approve or discard. On the way, it
// drops the ledger entries of files that are gone from these folders.
async function loadUnapproved($: EngineInterface, projectHints: boolean): Promise<Unapproved[]> {
  const [hints, functions] = await Promise.all([hintDirs($, projectHints), functionsDir($)])
  const dirs = [
    ...hints.filter(d => d.scope !== 'bundled').map(d => ({ ...d, kind: 'hint' as const })),
    ...(functions === undefined ? [] : [{ dir: functions, scope: 'user' as const, kind: 'function' as const }]),
  ]
  const read = await Promise.all(dirs.map(d => readMdFiles($, d.dir)))
  const files = dirs.flatMap((d, i) => (read[i] ?? []).map(f => ({ ...f, kind: d.kind, scope: d.scope })))
  // A folder that cannot be listed keeps its entries.
  await pruneLedger(
    $,
    dirs.filter((d, i) => read[i] !== undefined).map(d => d.dir),
    new Set(files.map(f => f.path)),
  ).catch(err => debugLog($, `cannot prune the approval ledger: ${errorText(err)}`))
  return (await splitApproved($, files)).unapproved
}

// The store is shared by every project: only an entry of a file directly in
// one of these folders, and not among `present`, goes. An Approve sets the
// hash before it writes a new file, so the prune waits for the approvals and
// checks that the file is still missing.
function pruneLedger($: EngineInterface, dirs: readonly string[], present: ReadonlySet<string>): Promise<void> {
  return oneApprovalAtATime(async () => {
    const keys = (await $.store.keys()).filter(isApprovalKey)
    const entries = await Promise.all(keys.map(k => $.store.get(k)))
    const inDirs = (path: string) => dirs.some(d => isUnder(path, d) && !path.slice(d.length + 1).includes('/'))
    await Promise.all(
      keys.map(async (key, i) => {
        const path = (entries[i] as { path?: unknown } | undefined)?.path
        if (typeof path !== 'string' || !inDirs(path) || present.has(path)) return
        if (!(await $.fs.exists(path))) await $.store.delete(key)
      }),
    )
  })
}

// One function file, or undefined when it is missing or not a function. For
// a proposal, activePathOf gives the saved function it replaces.
async function readFunction($: EngineInterface, path: string): Promise<SavedFunction | undefined> {
  return parseFunction(String(await $.fs.read(path).catch(() => '')), path)
}

async function loadFunctionProposals($: EngineInterface): Promise<SavedFunction[]> {
  const dir = await functionsDir($)
  return dir === undefined ? [] : readFunctionFiles($, `${dir}/pending`)
}

// Approve: the proposal becomes functions/<name>.md, without its reason, and
// replaces a function with that name. An Approve that cannot write it fails
// and keeps the proposal. `text` is the text the card showed (see cardText).
async function saveFunction($: EngineInterface, path: string, text: string): Promise<string> {
  const proposal = parseFunction(text, path)
  const dir = await functionsDir($)
  if (proposal === undefined || dir === undefined || !isUnder(path, `${dir}/pending`))
    throw new Error(`not a function proposal in the function folder: ${path}`)
  const dest = `${dir}/${proposal.name}.md`
  await writeApproved(
    $,
    dest,
    formatFunction({ name: proposal.name, description: proposal.description, code: proposal.code }),
  )
  return dest
}

// Approve saves the function; both then remove the proposal.
function decideFunction(
  $: EngineInterface,
  path: string,
  shown: string,
  action: Action,
): Promise<Decision | undefined> {
  return decideOnce($, path, async () => {
    const text = await cardText($, path, shown)
    const dest = action === 'approved' ? await saveFunction($, path, text) : undefined
    await $.process.run(['rm', '-f', path])
    return { action, dest, kind: 'function' }
  })
}

// Approve keeps the hash of the text the band showed; Discard deletes the
// file. Both fail when the file changed after the band drew it, so the person
// decides on the text they read. Undefined: the file is gone. Only the band
// decides these files, and it takes one press per drawing (decideHere).
function decideUnapproved($: EngineInterface, file: Unapproved, action: Action): Promise<Shown | undefined> {
  return oneApprovalAtATime(async (): Promise<Shown | undefined> => {
    const now = await readIfExists($, file.path)
    if (now === undefined) return undefined
    if (now !== file.text) throw new Error(`${file.path} changed after the band showed it; review it again`)
    if (action === 'approved') await recordApproval($, file.path, now)
    else await removeApproved($, file.path)
    $.ui.invalidate('ui.render')
    return action === 'approved'
      ? { text: `✓ File approved: ${file.path}`, color: 'green' }
      : { text: `File discarded: ${file.path}` }
  })
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
  if (stat.size > MAX_SAVED_BYTES)
    return { ok: false, error: `the result is ${stat.size} bytes, more than code-mode loads; ${TOO_LARGE}` }
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
async function nudgeAfter(
  $: EngineInterface,
  failed: Set<string>,
  worked: Set<string>,
  projectHints: boolean,
): Promise<string> {
  const { tries } = await sessionOf($)
  const serverOf = (tools: Iterable<string>) => new Set([...tools].flatMap(t => splitToolName(t)?.server ?? []))
  const failedNow = serverOf(failed)
  const learned = [...serverOf(worked)].filter(s => tries.failedServers.has(s) || failedNow.has(s))
  for (const s of failedNow) tries.failedTries.set(s, (tries.failedTries.get(s) ?? 0) + 1)
  for (const s of failedNow) if (!learned.includes(s)) tries.failedServers.add(s)
  for (const s of learned) tries.failedServers.delete(s)
  for (const s of learned) tries.nudged.add(s)
  if (worked.size === 0) return ''
  const probed = await probedTools($, tries, worked, projectHints).catch(
    err => (debugLog($, `cannot check for a probe: ${errorText(err)}`), []),
  )
  const nudge = hintNudge(learned, tries.missedSearches, probed)
  tries.missedSearches = []
  return nudge
}

// The tools of this run that an earlier run called too, on servers with no
// hint and no nudge yet. Each server is checked once per session.
async function probedTools(
  $: EngineInterface,
  tries: Tries,
  worked: Set<string>,
  projectHints: boolean,
): Promise<string[]> {
  const again = [...worked].filter(t => tries.usedTools.has(t) && !tries.nudged.has(splitToolName(t)?.server ?? ''))
  for (const t of worked) tries.usedTools.add(t)
  if (again.length === 0) return []
  for (const t of again) tries.nudged.add(splitToolName(t)?.server ?? '')
  const [hints, names, list] = await Promise.all([
    loadHints($, projectHints),
    serverNames($),
    $.tool.list().catch(() => []),
  ])
  const offered = toolsByServer(list.filter(t => t.mcp).map(t => t.name))
  return again
    .filter(t => hintsFor(hints, targetsOf([t], names, offered)).length === 0)
    .map(t => splitToolName(t)?.name ?? t)
}

// A finished program with many calls that worked, or a join of tools, and no
// saved function asks for one; each set of tools once per session.
async function functionNudgeAfter(
  $: EngineInterface,
  records: readonly CallRecord[],
  usesLib: boolean,
): Promise<string> {
  const ok = records.filter(r => r.status === 'ok')
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

// remove_hint and edit_hint: hide the hint in this session and write the
// proposal (see where they register).
async function proposeRemoval(
  $: EngineInterface,
  e: { tool_use_id: string },
  isEdit: boolean,
  projectHints: boolean,
): Promise<{ result: string }> {
  // remove_hint takes the input of edit_hint without new_text.
  const input = parseInput('edit_hint', e)
  const path = input.path.trim()
  const text = input.text.trim()
  // The new text of a change; undefined for a removal.
  const replacement = isEdit ? input.new_text.trim() : undefined
  const why = oneLine(input.why)
  if (path === '' || text === '' || why === '' || replacement === '') {
    return { result: `Error: path, text, ${isEdit ? 'new_text ' : ''}and why are required.` }
  }
  if (why.length > 300) return { result: 'Error: why is one short sentence (300 characters at most).' }
  if ((replacement?.length ?? 0) > 500)
    return { result: 'Error: a hint is one short sentence (500 characters at most).' }

  const hint = (await loadHintFiles($, projectHints)).find(h => h.path === path)
  if (!hint) return { result: `Error: ${path} is not a hint file. Give the path from "[<scope> hint: <path>]".` }
  const found = findItem(hint.body, text)
  if (found.item === undefined) return { result: `Error: ${found.error}` }
  if (replacement !== undefined && hintKey(replacement) === hintKey(found.item))
    return { result: 'Error: new_text is the same as the hint.' }
  const dirs = await hintDirs($, projectHints)
  const target = dirs.find(d => d.scope === (hint.scope === 'project' ? 'project' : 'user'))
  if (!target) return { result: 'Error: the user hint folder is not known (HOME is not set).' }

  // The failed tries on the servers the hint applies to, for the card. The
  // new text of a change gets the checks of a new hint.
  const [names, list, kind, state, shown] = await Promise.all([
    serverNames($),
    $.tool.list(),
    replacement === undefined
      ? undefined
      : $.model.classify(kindQuestion(serverLabel(hint), replacement), HINT_KINDS).catch(() => undefined),
    sessionOf($),
    approvalShown($),
  ])
  const mcpTools = list.filter(t => t.mcp).map(t => t.name)
  const servers = [
    ...new Set(
      targetsOf(mcpTools, names, toolsByServer(mcpTools))
        .filter(t => hintApplies(hint, t))
        .map(t => t.serverKey),
    ),
  ]
  const failures = servers.reduce((n, s) => n + (state.tries.failedTries.get(s) ?? 0), 0)
  const review: Review = {
    why,
    kind,
    seen: seenText(failures),
    flags: replacement === undefined ? [] : newHintFlags(kind, replacement, servers, servers.length > 0, mcpTools),
  }
  const name = hint.path.slice(hint.path.lastIndexOf('/') + 1).replace(/\.md$/, '')
  const pending = `${target.dir}/pending/${pendingFileName(`${name}.${isEdit ? 'edit' : 'remove'}.md`, e.tool_use_id)}`
  await $.fs.write(pending, removalProposal(hint, found.item, review, replacement))
  state.hidden.add(hiddenKey(hintRef(hint), hintKey(found.item)))
  $.ui.invalidate('ui.render')
  const done = `Hid the hint in this session and proposed to ${isEdit ? 'change it in' : 'remove it from'} ${path}.`
  if (!shown) {
    const block = removalTransfer({ server: serverLabel(hint), text: hintKey(found.item), why, replacement })
    return { result: `${done} ${TRANSFER_TEXT}\n\n${block}\npending: ${pending}` }
  }
  return {
    result: `${done} The file changes only after the person approves the ${isEdit ? 'change' : 'removal'} in the band above the prompt. Tell the person.\npending: ${pending}`,
  }
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
    for (const name of TOOL_NAMES) await $.tool.register(registration(name))
    return next(e)
  })

  // save_function never activates a function: it writes a proposal under
  // functions/pending/, which loads only after the person reads the code
  // and presses Approve. The model cannot press a button.
  on('tool.call', { tool: TOOL.save_function }, async ($, e) => {
    const input = parseInput('save_function', e)
    const [name, description, code, why] = [
      input.name.trim(),
      oneLine(input.description),
      input.code.trim(),
      oneLine(input.why),
    ]
    if (why === '' || why.length > 300) return { result: 'Error: why is one short sentence (300 characters at most).' }
    const problem = functionError(name, description, code)
    if (problem !== undefined) return { result: `Error: ${problem}.` }
    const dir = await functionsDir($)
    if (dir === undefined) return { result: 'Error: the function folder is not known (HOME is not set).' }
    const path = `${dir}/pending/${pendingFileName(`${name}.md`, e.tool_use_id)}`
    const [current, shown] = await Promise.all([
      readFunction($, `${dir}/${name}.md`),
      approvalShown($),
      $.fs.write(path, formatFunction({ name, description, code, why })).then(() => $.ui.invalidate('ui.render')),
    ])
    const replaces = current === undefined ? '' : ` It replaces the saved function ${name}.`
    if (!shown) {
      return {
        result: `Proposed the function lib.${name}.${replaces} ${TRANSFER_TEXT}\n\n${functionTransfer({ name, description, code, why })}\npending: ${path}`,
      }
    }
    return {
      result: `Proposed the function lib.${name}.${replaces} It has no effect until the person reads it and approves it in the band above the prompt. Tell the person.\npending: ${path}`,
    }
  }).catch(failClosed)

  // The save_function row: the code to read, with Approve and Discard.
  on('ui.render', { component: 'ToolResult', props: { tool: TOOL.save_function } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const path = pendingPathOf(String(e.props.output ?? ''))
    if (path === undefined) return next(e)
    const ui = $.ui.resolve(e)
    const { Text } = ui
    const decision = parseDecision(await $.store.get(decisionKey(path)))
    if (decision !== undefined) return shownLine(ui, decisionShown(decision))
    const [text, current] = await Promise.all([readIfExists($, path), readFunction($, activePathOf(path))])
    const proposal = text === undefined ? undefined : parseFunction(text, path)
    if (text === undefined || proposal === undefined)
      return <Text dimColor>Function proposal is no longer pending.</Text>
    return functionCard(
      ui,
      proposal,
      current,
      cardButtons(ui, { approve: 'approve', discard: 'discard' }, action => decideFunction($, path, text, action)),
    )
  })

  // add_hint never activates a hint: it writes a proposal under pending/,
  // which loads only after the person presses Approve on the call's row in
  // the chat. Text in a tool result therefore cannot plant a standing
  // instruction by itself: the model cannot press a button.
  // The proposal also carries a review for that person (Review): the model's
  // reason, a classifier's guess of the kind, and what code-mode saw. All of
  // it is advice: none of it approves or refuses a proposal.
  on('tool.call', { tool: TOOL.add_hint }, async ($, e) => {
    const input = parseInput('add_hint', e)
    const [server, text, why, tools] = [input.server.trim(), input.text.trim(), oneLine(input.why), input.tools]
    const scope = input.scope === 'project' ? 'project' : 'user'
    if (server === '' || text === '' || why === '') return { result: 'Error: server, text and why are required.' }
    if (text.length > 500) return { result: 'Error: a hint is one short sentence (500 characters at most).' }
    if (why.length > 300) return { result: 'Error: why is one short sentence (300 characters at most).' }

    const dirs = await hintDirs($, projectHints)
    const target = dirs.find(d => d.scope === scope)
    if (!target)
      return { result: `Error: ${scope} hints are off. The person can turn on the code-mode option "projectHints".` }

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
    const isUuid = isUuidLike(servers[0]!)
    const fileName = hintFileName(isUuid && identify ? identify : servers[0]!, tools)
    const path = `${target.dir}/pending/${pendingFileName(fileName, e.tool_use_id)}`
    const failures = (await sessionOf($)).tries.failedTries.get(key) ?? 0
    const review: Review = {
      why,
      kind,
      seen: seenText(failures),
      flags: newHintFlags(kind, text, [key], offered.length > 0, mcpTools),
    }
    await $.fs.write(path, withReview(appendHint(undefined, servers, identify ? [identify] : [], tools, text), review))
    $.ui.invalidate('ui.render') // the band above the prompt counts the proposal
    if (!(await approvalShown($))) {
      return {
        result: `Proposed a ${scope} hint for ${servers[0]}. ${TRANSFER_TEXT}\n\n${hintTransfer({ server: isUuid && identify ? `the server with the tool ${identify}` : servers[0]!, tools, scope, text, why })}\npending: ${path}`,
      }
    }
    return {
      result: `Proposed a ${scope} hint for ${servers[0]}. It has no effect until the person approves it in the band above the prompt (Review, then Approve or Discard). Tell the person.\npending: ${path}`,
    }
  }).catch(failClosed)

  // remove_hint hides the hint in this session at once (a wrong hint misleads
  // each later call) and proposes its removal. The file changes only after
  // the person approves, as for add_hint: a hidden hint costs one session at
  // most, a removed one costs every session. edit_hint is a removal that
  // puts a new hint in the old one's place; its new text gets the checks of
  // add_hint, so a change cannot carry what a new hint would be warned about.
  on('tool.call', { tool: TOOL.remove_hint }, ($, e) => proposeRemoval($, e, false, projectHints)).catch(failClosed)
  on('tool.call', { tool: TOOL.edit_hint }, ($, e) => proposeRemoval($, e, true, projectHints)).catch(failClosed)

  // The add_hint, remove_hint and edit_hint rows show the proposal with Approve and
  // Discard, where the surface asks plugins to draw tool results (the desktop
  // app does not; the band above the prompt covers it). A press is the
  // person's own act; $.store keeps the decision so the row still shows it
  // after a reload.
  for (const tool of [TOOL.add_hint, TOOL.remove_hint, TOOL.edit_hint])
    on('ui.render', { component: 'ToolResult', props: { tool } }, async ($, e, next) => {
      if (e.props.isErrored) return next(e)
      const path = pendingPathOf(String(e.props.output ?? ''))
      if (path === undefined) return next(e)
      const ui = $.ui.resolve(e)
      const { Text } = ui
      const decision = parseDecision(await $.store.get(decisionKey(path)))
      if (decision !== undefined) return shownLine(ui, decisionShown(decision))
      if (!(await $.fs.exists(path))) return <Text dimColor>Hint proposal is no longer pending.</Text>

      const text = String(await $.fs.read(path))
      const hint = parseHint(text, path, await scopeOf($, path))
      const note = 'Claude sees approved hints in later sessions. Approve only what you would write yourself.'
      return hintCard(
        ui,
        hint,
        await cardFields($, hint),
        cardButtons(ui, { approve: 'approve', discard: 'discard' }, action =>
          decidePending($, path, text, action, projectHints),
        ),
        note,
      )
    })

  // The band above the prompt: while proposals wait in pending/ (from any
  // session, a headless one included), one line with Review; opened, one
  // proposal at a time with its own Approve and Discard, and Previous and
  // Next when there are more. Nothing shows otherwise.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [pending, functions, unapproved, isOpen, result] = await Promise.all([
      loadPending($, projectHints),
      loadFunctionProposals($),
      loadUnapproved($, projectHints),
      read($, reviewOpen),
      read($, reviewResult),
    ])
    const total = pending.length + functions.length + unapproved.length
    if (total === 0) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const kinds = [
      ...(pending.length === 0 ? [] : [`${pending.length} hint${pending.length === 1 ? '' : 's'}`]),
      ...(functions.length === 0 ? [] : [`${functions.length} function${functions.length === 1 ? '' : 's'}`]),
      ...(unapproved.length === 0
        ? []
        : [`${unapproved.length} file${unapproved.length === 1 ? '' : 's'} not approved`]),
    ]

    const title = `${total} proposal${total === 1 ? '' : 's'} for code mode`
    if (!isOpen) {
      return (
        <Box gap={1} alignItems="center">
          <Text color="yellow">●</Text>
          <Text>{`${title}: ${kinds.join(', ')}`}</Text>
          <Button key="review" label="Review" onPress={() => update($, reviewOpen, () => true)} />
        </Box>
      )
    }

    // Close also drops the result, so the next Review starts on a proposal.
    const close = (
      <Button
        key="close"
        label="Close"
        role="dismiss"
        onPress={() => Promise.all([update($, reviewOpen, () => false), update($, reviewResult, () => null)])}
      />
    )
    // After a decision, the band shows its result until Show next, not the
    // next proposal: the second click of a double click lands on this text,
    // not on the next proposal's Approve.
    if (result !== null) {
      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold>{title}</Text>
            <Box gap={1}>
              <Button key="show-next" label="Show next" onPress={() => update($, reviewResult, () => null)} />
              {close}
            </Box>
          </Box>
          {shownLine(ui, result)}
        </Box>
      )
    }

    // A decision shortens the list: the same index then shows the next one.
    const index = Math.min(await read($, reviewIndex), total - 1)
    const go = (step: number) => update($, reviewIndex, () => (index + step + total) % total)
    // In order: hint proposals, function proposals, files not approved.
    const hint = pending[index]
    const f = functions[index - pending.length]
    const shownOf = (d: Decision | undefined) => (d === undefined ? undefined : decisionShown(d))
    let decide: (action: Action) => Promise<Shown | undefined>
    let card: RenderChildren
    // The card and its buttons take the text of one read of the file.
    if (hint !== undefined) {
      const text = (await readIfExists($, hint.path)) ?? ''
      const drawn = parseHint(text, hint.path, hint.scope)
      decide = action => decidePending($, hint.path, text, action, projectHints).then(shownOf)
      card = hintCard(ui, drawn, await cardFields($, drawn), null)
    } else if (f !== undefined) {
      const text = (await readIfExists($, f.path)) ?? ''
      const drawn = parseFunction(text, f.path) ?? f
      decide = action => decideFunction($, f.path, text, action).then(shownOf)
      card = functionCard(ui, drawn, await readFunction($, activePathOf(f.path)), null)
    } else {
      // index < total, so the rest is a file not approved.
      const file = unapproved[index - pending.length - functions.length]!
      decide = action => decideUnapproved($, file, action)
      card = unapprovedCard(ui, file)
    }
    // The result shows before the files change, so no redraw puts the next
    // proposal under the pointer. Only the press that sets the result counts:
    // a second press, from this drawing or a later one, finds it set.
    const decideHere: Decide = async action => {
      let isFirst = false
      await update($, reviewResult, r => {
        isFirst = r === null
        return isFirst ? { text: action === 'approved' ? 'Approving…' : 'Discarding…' } : r
      })
      if (!isFirst) return
      const shown = await decide(action).then(
        (s): Shown => s ?? { text: 'This proposal is no longer pending.' },
        (err: unknown) => ({
          text: `${action === 'approved' ? 'Approve' : 'Discard'} failed: ${errorText(err)}`,
          color: 'red' as const,
        }),
      )
      // With no proposal left the band hides: drop the result, so the next
      // proposal does not open on it.
      const left = await Promise.all([
        loadPending($, projectHints),
        loadFunctionProposals($),
        loadUnapproved($, projectHints),
      ])
      await update($, reviewResult, () => (left.every(l => l.length === 0) ? null : shown))
    }
    // Approve and Discard above the card: a card taller than the band
    // scrolls, and buttons under it would start out of view.
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold>
              Code mode proposal {index + 1} of {total}
            </Text>
            <Box gap={1}>
              {total > 1 ? <Button key="previous" label="Previous" onPress={() => go(-1)} /> : null}
              {total > 1 ? <Button key="next" label="Next" onPress={() => go(1)} /> : null}
              {close}
            </Box>
          </Box>
          <Text dimColor>
            Approve only what you would write yourself. Approved hints guide Claude in later sessions. Approved
            functions run in its programs.
          </Text>
          {cardButtons(ui, { approve: `approve-${index}`, discard: `discard-${index}` }, decideHere)}
        </Box>
        {card}
      </Box>
    )
  })

  on('tool.call', { tool: TOOL.search_tools }, async ($, e) => {
    const { query, limit: asked } = parseInput('search_tools', e)
    const limit = Math.min(100, Math.max(1, asked || SEARCH_LIMIT))
    const all = (await $.tool.list()).filter(t => t.mcp && isCallable(t.name, $.plugin.name))
    const found = rankTools(all, query, limit)
    if (found.length === 0) {
      await recordMissedSearch($, query)
      return { result: `No MCP tool matches "${query}". ${all.length} MCP tools are connected.` }
    }

    const [dts, shapes, argNames] = await Promise.all([
      mcpTypes($),
      projection ? readLearned($, SHAPES) : ({} as Shapes),
      readLearned($, ARG_NAMES),
    ])
    const declarations = found.map(t => (dts === '' ? undefined : extractDeclaration(dts, t.name)))
    const blocks = found.map((t, i) => {
      const names = argNames[t.name]
      const args =
        declarations[i] ?? (names === undefined ? 'unknown' : `names from earlier calls: {${names.join(', ')}}`)
      const summary = t.description.split('\n')[0]!.slice(0, 300)
      const shape = shapes[t.name] === undefined ? '' : `\nreturns (earlier call): ${shapes[t.name]}`
      return `### ${t.name}\n${summary}\nargs: ${args}${shape}`
    })
    const [hints, names] = await Promise.all([loadHints($, projectHints), serverNames($)])
    const offered = toolsByServer(all.map(t => t.name))
    const hintText = formatHints(
      hintsFor(
        hints,
        targetsOf(
          found.map(t => t.name),
          names,
          offered,
        ),
      ),
    )
    const functionText = formatFunctions(
      functionsFor(
        await loadFunctions($),
        found.map(t => t.name),
        query,
      ),
    )
    const tail = [functionText, hintText]
      .filter(t => t !== '')
      .map(t => `\n\n${t}`)
      .join('')
    return {
      result: `${found.length} of ${all.length} MCP tools. Call them in run_code with call("<name>", args).${declarations.includes(undefined) ? UNTYPED_NOTE : ''}\n\n${blocks.join('\n\n')}${tail}`,
    }
  }).catch(failClosed)

  on('tool.call', { tool: TOOL.run_code }, async ($, e) => {
    const { code } = parseInput('run_code', e)
    if (code.trim() === '') return { result: 'Error: code is empty.' }
    const problems = await checkProgram($, code).catch(
      err => (debugLog($, `cannot check the program: ${errorText(err)}`), ''),
    )
    if (problems !== '') return { result: problems }

    // The real path: Node's --permission stops a main script whose path goes
    // through a link (a linked ~/.claude or plugin folder) before it starts.
    const bundled = `${$.plugin.root}/runtime/runner.mjs`
    const runner = await $.fs.stat(bundled, { resolve: true }).then(
      s => s.realPath ?? bundled,
      () => bundled,
    )
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
    // Tools whose call no rule decided (verdict `ask`) and that were refused:
    // they need an allow rule.
    const unapproved = new Set<string>()
    // The tool names the session offers, read once per run and only after a throw.
    let offeredNames: Promise<Set<string> | undefined> | undefined
    const isOffered = async (tool: string): Promise<boolean> => {
      offeredNames ??= $.tool.list().then(
        list => new Set(list.map(t => t.name)),
        () => undefined,
      )
      return (await offeredNames)?.has(tool) ?? true
    }
    const state = await sessionOf($)
    // Without a session id, results kept across runs could reach another session
    // with no id. Keep them for this run only, apart from what sessionOf gives.
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
      // Refused after an ask that no rule and no organization ceiling decided:
      // an allow rule is the fix, not a hint about the server.
      let isUnapproved = false
      if (!isCallable(tool, $.plugin.name)) {
        reply = { ok: false, error: `only MCP tools (mcp__<server>__<tool>) can be called, not "${tool}"` }
      } else {
        try {
          // Program approval: the person or the auto-mode classifier approved
          // run_code with this program in view, so a call no rule decides
          // (verdict `ask`) runs as part of it. A deny rule still refuses, and
          // an allow rule, an ask rule or an organization ceiling takes the
          // normal path: an ask rule says "ask me each time", which the
          // approval of the program does not answer.
          const check = await $.tool.check({ tool, input: args })
          const target = splitToolName(tool)
          const needsAllowRule = check.decision === 'ask' && check.ceiling === undefined && check.rule === undefined
          if (check.decision === 'deny') {
            reply = { ok: false, error: `denied: ${check.reason ?? 'a permission rule refuses this tool'}` }
          } else if (programApproval && needsAllowRule && target !== undefined) {
            // A refused $.mcp.call throws (a server error comes back as isError).
            // So do a lost connection, which the note's condition covers, and a
            // name from a variable that no server offers, which needs no allow rule.
            reply = await $.mcp.call(target.server, target.name, args).then(mcpReply, async (err): Promise<Reply> => {
              isUnapproved = needsAllowRule && (await isOffered(tool))
              return { ok: false, error: errorText(err) }
            })
          } else {
            const r = await $.tool.call({ ...args, tool })
            if (r.deny !== undefined) {
              reply = { ok: false, error: `denied: ${r.deny}` }
              isUnapproved = needsAllowRule
            } else if (r.isError === true) reply = { ok: false, error: r.text ?? String(r.result) }
            else reply = { ok: true, value: toValue(r.result, r.text) }
          }
        } catch (err) {
          reply = { ok: false, error: errorText(err) }
        }
      }
      reply = await loadSaved($, reply).catch(
        (err): Reply => ({ ok: false, error: `could not read the saved result: ${errorText(err)}` }),
      )
      if (closed) return
      if (isCallable(tool, $.plugin.name)) (isUnapproved ? unapproved : reply.ok ? worked : failed).add(tool)
      const text = JSON.stringify(reply)
      await $.fs.write(`${xdir}/r${id}.json`, text)
      // A repeat is a call equal to an earlier one that worked, with projection
      // on or off, so both arms of the experiment count the same. A failed call
      // is not kept: a new call is the only way to retry it.
      const key = callKey(tool, args)
      const repeatOf = kept.seen.get(key)
      const json = reply.ok ? (JSON.stringify(reply.value) ?? 'null') : ''
      const chars = json.length
      const ref = reply.ok && projection ? keep(kept, json, await $.clock.now()) : undefined
      const learned = reply.ok && projection ? learnedShape(reply.value) : undefined
      if (learned !== undefined) shapes.set(tool, learned)
      if (reply.ok) argNames.set(tool, [...new Set([...(argNames.get(tool) ?? []), ...argNamesOf(args)])])
      if (reply.ok && repeatOf === undefined && kept.seen.size < MAX_SEEN) kept.seen.set(key, ref ?? 0)
      records.set(id, {
        ref,
        tool,
        status: reply.ok ? 'ok' : 'failed',
        chars,
        shape: reply.ok && projection ? shapeOf(reply.value) : undefined,
        repeatOf,
      })
    }

    // recall(n): a result this session kept, with no new call and no new check:
    // it was approved when the call ran.
    const answerRecall = async (id: number, ref: number): Promise<void> => {
      recalls++
      const found = projection ? kept.results.get(ref) : undefined
      const error = !projection
        ? 'recall() is off: call the tool again'
        : ref > 0 && ref < kept.next
          ? `result #${ref} is no longer kept: call the tool again`
          : `no result #${ref} in this session`
      // The kept JSON goes into the reply as it is: no parse and no copy of the value.
      const text =
        found !== undefined ? `{"ok":true,"value":${found.json}}` : JSON.stringify({ ok: false, error } satisfies Reply)
      await $.fs.write(`${xdir}/r${id}.json`, text)
      if (found === undefined) recallMisses++
      else recalled.push({ ref, ageMs: (await $.clock.now()) - found.at })
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
        return {
          ok: false,
          error: /no tool named/.test(text) ? 'no MCP server in this session offers resources' : text,
        }
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
      if (text.length > MAX_FILE_CHARS)
        return {
          ok: false,
          error: `saveFile: ${text.length} characters is more than ${MAX_FILE_CHARS}; save less data`,
        }
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
          switch (m.t) {
            case 'call':
              calls++
              started.set(m.id, m.tool)
              answers.push(limit(() => answer(m.id, m.tool, m.args)))
              break
            case 'recall':
              answers.push(answerRecall(m.id, m.ref))
              break
            case 'save':
              answers.push(answerLocal(m.id, () => save(m.name, m.data)))
              break
            case 'read':
              answers.push(answerLocal(m.id, () => readForProgram($, m.path)))
              break
            case 'resources':
              answers.push(
                answerLocal(m.id, () =>
                  resourceTool({
                    tool: 'ListMcpResourcesTool',
                    ...(m.server === undefined ? {} : { server: m.server }),
                  }),
                ),
              )
              break
            case 'resource':
              answers.push(answerLocal(m.id, () => readResource(m.server, m.uri)))
              break
            case 'done':
            case 'error':
              outcome = m
              break
            default:
              m satisfies never // a new kind needs a case here
          }
        }
      }
      ended = true
      const stop = new AbortController()
      await Promise.race([
        Promise.allSettled(answers),
        $.clock.sleep(SETTLE_MS, { signal: stop.signal }).catch(() => undefined),
      ])
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
      records.set(id, { tool, status: 'unfinished', chars: 0 })
      if (isCallable(tool, $.plugin.name)) failed.add(tool)
    }

    await Promise.all([
      saveLearned($, SHAPES, shapes).catch(err => debugLog($, `cannot write the result shapes: ${errorText(err)}`)),
      saveLearned($, ARG_NAMES, argNames).catch(err =>
        debugLog($, `cannot write the argument names: ${errorText(err)}`),
      ),
    ])

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
    // A refusal for want of an allow rule can end the program too, but then the servers are not at fault.
    const isDone = outcome?.t === 'done'
    const isProgramFault = !isDone && unapproved.size === 0
    const nudge = await nudgeAfter(
      $,
      isProgramFault ? new Set([...failed, ...worked]) : failed,
      isDone ? worked : new Set(),
      projectHints,
    ).catch(() => '')
    const callRecords = [...records].sort((a, b) => a[0] - b[0]).map(([, r]) => r)
    const keepNudge = isDone
      ? await functionNudgeAfter($, callRecords, Object.keys(lib).length > 0).catch(() => '')
      : ''
    // The names that `kind` was not yet noted for in this session; they count as noted from now.
    const notYetNoted = (kind: string, names: readonly string[]): string[] => {
      const fresh = names.filter(n => !state.tries.nudged.has(`${kind}:${n}`))
      for (const n of fresh) state.tries.nudged.add(`${kind}:${n}`)
      return fresh
    }
    // A run that failed in a saved function asks for a fix, once per function in a session.
    const broken = outcome?.t === 'error' ? notYetNoted('fix', failedFunctions(outcome.message, Object.keys(lib))) : []
    // The allow rule note, once per tool in a session.
    const toAllow = notYetNoted('allow', [...unapproved])
    const tail = [approvalNote(toAllow), nudge, keepNudge, functionFixNudge(broken), hintText]
      .filter(t => t !== '')
      .map(t => `\n\n${t}`)
      .join('')
    // A result too large to show is kept whole, so the next program can page it.
    const returned = outcome?.t === 'done' ? outcome.value : undefined
    const outChars = returned?.length ?? 0
    // Cut on the shown text. outChars stays the raw length, for the metrics.
    // With no session id the store dies with this run, so the clip names no recall.
    const isCut = returned !== undefined && shownText(returned).length > MAX_RESULT_CHARS
    const wholeRef =
      hasSession && projection && isCut && returned !== undefined
        ? keep(kept, returned, await $.clock.now())
        : undefined
    const report: Projection | undefined = projection ? { calls: callRecords, recalls, recalled, wholeRef } : undefined
    if (opts.metrics === true) {
      await writeMetrics($, state, {
        projection,
        ok: isDone,
        calls,
        failedCalls: callRecords.filter(r => r.status !== 'ok').length,
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
  }).catch(failClosed)

  // Guard: the file tools may not write a hint or a function file, checked
  // by path, so the model gets an early error. The approval ledger is what
  // keeps a file from loading: a file that any other tool or program writes
  // (Bash, a script, the person's editor) waits in the band until approved.
  // A guard that fails denies the call it guards (next.called: it already passed).
  // Each tool has its own registration, so `claude plugin validate` lists it.
  on('tool.call', { tool: 'Write' }, async ($, e, next) =>
    (await touchesHints($, e.file_path)) ? { deny: HINT_GUARD_DENY } : next(e),
  ).catch(failClosed)
  on('tool.call', { tool: 'Edit' }, async ($, e, next) =>
    (await touchesHints($, e.file_path)) ? { deny: HINT_GUARD_DENY } : next(e),
  ).catch(failClosed)
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) =>
    (await touchesHints($, e.notebook_path)) ? { deny: HINT_GUARD_DENY } : next(e),
  ).catch(failClosed)

  // Optional: push the model to run_code by refusing its direct MCP calls.
  // Calls this plugin makes (from run_code) pass.
  on('tool.call', ($, e, next) => {
    if (opts.blockDirectMcp !== true) return next(e)
    if (!isCallable(e.tool, $.plugin.name)) return next(e)
    if (next.origin.plugin === $.plugin.name) return next(e)
    return { deny: `code-mode: call this tool from run_code instead: await call("${e.tool}", { ... })` }
  }).catch(($, e, next) => next(e))
}
