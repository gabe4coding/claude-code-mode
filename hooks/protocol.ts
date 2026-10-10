// Pure helpers for code-mode: the runner's wire protocol, result shaping,
// tool search and type extraction. No `$` here, so tests can call them directly.

export const MARK = '\u0001cm '

export type RunnerCall = { t: 'call'; id: number; tool: string; args: Record<string, unknown> }
export type RunnerRecall = { t: 'recall'; id: number; ref: number }
export type RunnerDone = { t: 'done'; value: string; logs: string[] }
export type RunnerError = { t: 'error'; message: string; logs: string[] }
export type RunnerMessage = RunnerCall | RunnerRecall | RunnerDone | RunnerError

export type Reply = { ok: true; value: unknown } | { ok: false; error: string }

export type ToolEntry = { name: string; description: string }

/** Splits buffered stdout into whole protocol lines; other lines are ignored. */
export const takeMessages = (buffer: string): { messages: RunnerMessage[]; rest: string } => {
  const messages: RunnerMessage[] = []
  let rest = buffer
  let i = rest.indexOf('\n')
  while (i >= 0) {
    const line = rest.slice(0, i)
    rest = rest.slice(i + 1)
    if (line.startsWith(MARK)) {
      try {
        messages.push(JSON.parse(line.slice(MARK.length)) as RunnerMessage)
      } catch {
        // a malformed line is the script's own output, not ours
      }
    }
    i = rest.indexOf('\n')
  }
  return { messages, rest }
}

/** The message of a thrown value. */
export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** True for a tool the sandbox may call: any MCP tool except this plugin's own. */
export const isCallable = (tool: string, plugin: string): tool is `mcp__${string}__${string}` =>
  tool.startsWith('mcp__') && !tool.startsWith(`mcp__${plugin}__`)

/** `mcp__<server>__<tool>` as the server and the tool's name on it. */
export const splitToolName = (tool: string): { server: string; name: string } | undefined => {
  const rest = tool.startsWith('mcp__') ? tool.slice('mcp__'.length) : ''
  const at = rest.indexOf('__')
  if (at <= 0 || at + 2 >= rest.length) return undefined
  return { server: rest.slice(0, at), name: rest.slice(at + 2) }
}

type McpResultLike = {
  content: readonly { type: string; text?: unknown }[]
  isError: boolean
  structuredContent?: unknown
}

/** The reply for a `$.mcp.call` result: its text blocks joined, as the model would read them. */
export const mcpReply = (r: McpResultLike): Reply => {
  const text = r.content
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : `[${block.type} block]`))
    .join('\n')
  if (r.isError) return { ok: false, error: text || 'the tool reported an error' }
  return { ok: true, value: toValue({ structuredContent: r.structuredContent }, text) }
}

/** What the script receives for a tool result: structured data when there is any. */
export const toValue = (result: unknown, text: string | undefined): unknown => {
  if (result !== null && typeof result === 'object' && 'structuredContent' in result) {
    const structured = (result as { structuredContent?: unknown }).structuredContent
    if (structured !== undefined) return structured
  }
  const raw = text ?? (typeof result === 'string' ? result : undefined)
  if (raw === undefined) return result ?? null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * A tool result Claude Code saved to a file because it was too large: the
 * model would read only a note with the path, so the program gets the file.
 * `format` is how the file holds the result, when the note says; `isCut`
 * when the note says the file holds part of it.
 */
export type SavedResult = { path: string; format: 'text' | 'json' | 'blocks' | 'unknown'; isCut: boolean }

// Claude Code's notes as of 2.1.295: the MCP one ("Format: Plain text", "JSON
// with schema: …", "JSON array …") and the one for any tool's output. They
// give the format and a path with spaces. A note in another wording is found
// by the path alone: a path in this session's tool-results/ folder.
const MCP_SAVED = /^Error: result \([^)]*\) exceeds maximum allowed tokens\. Output has been saved to (.+)\.\nFormat: ([^\n]*)/
const OUTPUT_SAVED = /^<persisted-output>\n[^\n]*?(?:Full output saved to|were saved to): ([^\n]+)/
const CUT = /exceeded the persist byte limit|only the first [^\n]* were saved to/
const PATH = /\/[^\s"'`<>()]+/g
// A note is short; a longer result that names a path is the tool's own data.
const MAX_NOTE_CHARS = 8_000

/** The saved result a tool's text names, or undefined for an ordinary result. */
export const savedResultOf = (text: string, sessionId: string): SavedResult | undefined => {
  if (sessionId === '' || text.length > MAX_NOTE_CHARS) return undefined
  const isCut = CUT.test(text)
  const mcp = MCP_SAVED.exec(text)
  if (mcp && isSessionResult(mcp[1]!, sessionId)) {
    const format = mcp[2]!.startsWith('JSON array') ? 'blocks' : mcp[2]!.startsWith('JSON') ? 'json' : 'text'
    return { path: mcp[1]!, format, isCut }
  }
  const output = OUTPUT_SAVED.exec(text)
  if (output && isSessionResult(output[1]!.trim(), sessionId)) return { path: output[1]!.trim(), format: 'text', isCut }
  const paths = new Set(
    [...text.matchAll(PATH)].map(m => m[0].replace(/[.,;:!?\]]+$/, '')).filter(p => isSessionResult(p, sessionId)),
  )
  return paths.size === 1 ? { path: [...paths][0]!, format: 'unknown', isCut } : undefined
}

/** True when a path is a file in this session's `tool-results/` folder. */
export const isSessionResult = (path: string, sessionId: string): boolean => {
  const parts = path.split('/')
  return sessionId !== '' && parts.at(-2) === 'tool-results' && parts.includes(sessionId) && !parts.includes('..')
}

const CONTENT_TYPES = new Set(['text', 'image', 'audio', 'resource', 'resource_link', 'document'])

// MCP content blocks, not data that has a `type` field of its own.
const isBlocks = (v: unknown): v is McpResultLike['content'] =>
  Array.isArray(v) &&
  v.some(b => b?.type === 'text') &&
  v.every(b => b !== null && typeof b === 'object' && CONTENT_TYPES.has((b as { type?: unknown }).type as string))

/** The reply for a saved result, read back from its file. */
export const savedReply = (format: SavedResult['format'], fileText: string): Reply => {
  if (format === 'text') return { ok: true, value: toValue(undefined, fileText) }
  let parsed: unknown
  try {
    parsed = JSON.parse(fileText)
  } catch {
    // JSON that does not parse was cut; text that is not JSON is the result.
    if (format === 'unknown') return { ok: true, value: fileText }
    return { ok: false, error: 'the saved result is not whole' }
  }
  if (format === 'json' || !isBlocks(parsed)) return { ok: true, value: parsed }
  // Content blocks: joined as the model would read them, like a live result.
  return mcpReply({ content: parsed, isError: false })
}

const clip = (text: string, max: number, whole?: number): string => {
  if (text.length <= max) return text
  const fix = whole === undefined ? 'return less data' : `await recall(${whole}) returns the whole result: return a part of it`
  return `${text.slice(0, max)}\n… [${text.length - max} more characters cut; ${fix}]`
}

const pretty = (json: string): string => {
  try {
    return JSON.stringify(JSON.parse(json), null, 2) ?? 'null'
  } catch {
    return json
  }
}

/** The text the model reads after a run. */
export const formatOutcome = (
  outcome: RunnerDone | RunnerError | undefined,
  calls: number,
  stderr: string,
  maxChars: number,
  projection?: Projection,
): string => {
  const parts: string[] = []
  if (outcome === undefined) {
    parts.push('Error: the sandbox exited without a result.')
    if (stderr.trim() !== '') parts.push(`stderr:\n${clip(stderr.trim(), 2000)}`)
  } else if (outcome.t === 'done') {
    parts.push(clip(pretty(outcome.value), maxChars, projection?.wholeRef))
  } else {
    const message = /^\w*Error: /.test(outcome.message) ? outcome.message : `Error: ${outcome.message}`
    parts.push(clip(message, 4000))
  }
  const logs = outcome?.logs ?? []
  if (logs.length > 0) parts.push(`--- console (${logs.length} lines) ---\n${clip(logs.join('\n'), 4000)}`)
  parts.push(projection === undefined ? `--- ${calls} MCP call${calls === 1 ? '' : 's'} ---` : projectionFooter(projection, outcome))
  return parts.join('\n\n')
}

/**
 * One nested call as the run's footer shows it: its number in the session
 * (`ref`, absent when it failed or was not kept), its size and shape, and the
 * earlier call it repeats (`repeatOf`: that call's number, 0 when it has none).
 */
export type CallRecord = { ref?: number; tool: string; ok: boolean; chars: number; shape?: string; repeatOf?: number }

/**
 * What a run with output projection reports: its calls, the results it read
 * again with recall() and how old each one was, and the number of a cut result.
 */
export type Projection = { calls: CallRecord[]; recalls: number; recalled: { ref: number; ageMs: number }[]; wholeRef?: number }

const MAX_SHAPE_CHARS = 200
const MAX_KEYS = 8
const SAMPLE = 20

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || v === '' ||
  (Array.isArray(v) ? v.every(isEmpty) : typeof v === 'object' && Object.values(v as object).every(isEmpty))

// The keys of many objects in first-seen order, each with its first value that is not empty.
const mergeObjects = (items: Record<string, unknown>[]): Record<string, unknown> => {
  const merged: Record<string, unknown> = {}
  for (const item of items) for (const [k, v] of Object.entries(item)) if (!(k in merged) || isEmpty(merged[k])) merged[k] = v
  return merged
}

// A key that reads as a field name: `status`, `next_cursor`, `realName`. Ids,
// emails, ticket keys and other data used as keys do not.
const isFieldName = (key: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]{0,39}$/.test(key) && (key.match(/\d/g)?.length ?? 0) <= 2

const kindOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? `{${Object.keys(v as object).sort().join(',')}}` : typeof v

// A map from data to values, such as error counts by service or users by
// name: three keys or more whose values are all of one kind. A record's
// fields differ in kind.
const isMap = (o: Record<string, unknown>): boolean => {
  const values = Object.values(o)
  return values.length >= 3 && values.every(v => kindOf(v) === kindOf(values[0]))
}

// The keys of an object are shown only when they are field names: keys that
// are data would put the data into the context, which the program kept out.
// The merged items of an array are records (their keys repeat), so only the
// spelling of their keys counts.
const shapeAt = (v: unknown, depth: number, isRecord = false): string => {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    if (depth >= 2) return `[${v.length}]`
    const sample = v.slice(0, SAMPLE)
    const objects = sample.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x))
    // The items are at the array's own depth: a list of records shows their keys.
    const inner = objects.length === sample.length ? shapeAt(mergeObjects(objects), depth, objects.length > 1) : shapeAt(sample[0], depth + 1)
    return `[${v.length} × ${inner}]`
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v)
    if (keys.length === 0) return '{}'
    const hidden = !keys.every(isFieldName) || (!isRecord && isMap(v as Record<string, unknown>))
    if (depth >= 2 || hidden) return `{${keys.length} key${keys.length === 1 ? '' : 's'}}`
    const fields = keys.slice(0, MAX_KEYS).map(k => {
      const inner = (v as Record<string, unknown>)[k]
      return inner !== null && typeof inner === 'object' ? `${k}: ${shapeAt(inner, depth + 1)}` : k
    })
    const more = keys.length > MAX_KEYS ? [`…+${keys.length - MAX_KEYS}`] : []
    return `{${[...fields, ...more].join(', ')}}`
  }
  if (typeof v === 'string') {
    const lines = v.split('\n').length
    return depth === 0 ? `text, ${lines} line${lines === 1 ? '' : 's'}` : 'string'
  }
  return typeof v
}

/** The structure of a value in one short line: keys, array lengths, nesting to depth 2. */
export const shapeOf = (v: unknown): string => {
  const shape = shapeAt(v, 0)
  return shape.length <= MAX_SHAPE_CHARS ? shape : `${shape.slice(0, MAX_SHAPE_CHARS)}…`
}

/** A character count, short: 812, 18k, 1.2M. */
export const charCount = (n: number): string =>
  n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`

/** True when a program returned nothing although its calls returned data: a filter that missed. */
export const missedData = (outcome: RunnerDone | RunnerError | undefined, calls: readonly CallRecord[]): boolean => {
  if (outcome?.t !== 'done' || !calls.some(c => c.ok && c.chars > 2)) return false
  try {
    return isEmpty(JSON.parse(outcome.value))
  } catch {
    return false
  }
}

const MAX_CALL_LINES = 8

// JSON with sorted keys, so two calls with the same arguments match.
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  : JSON.stringify(v) ?? 'null'

/** The identity of a call: the tool and its arguments. Two equal keys are the same call. */
export const callKey = (tool: string, args: Record<string, unknown>): string => `${tool}\n${stable(args)}`

const callLine = (c: CallRecord): string => {
  const id = c.ref === undefined ? '-' : `#${c.ref}`
  if (!c.ok) return `${id} ${c.tool} failed`
  const repeat = c.repeatOf === undefined || c.repeatOf === 0 ? '' : `, the same call as #${c.repeatOf}`
  return `${id} ${c.tool} ${charCount(c.chars)}${repeat} ${c.shape ?? ''}`.trimEnd()
}

// Many calls: one line per tool, with the shape of its first result.
const groupLines = (calls: readonly CallRecord[]): string[] => {
  const byTool = new Map<string, CallRecord[]>()
  for (const c of calls) byTool.set(c.tool, [...(byTool.get(c.tool) ?? []), c])
  return [...byTool].map(([tool, group]) => {
    const kept = group.filter(c => c.ref !== undefined).map(c => c.ref!)
    const ids = kept.length === 0 ? '-' : kept.length === 1 ? `#${kept[0]}` : `#${kept[0]}…#${kept.at(-1)}`
    const failed = group.filter(c => !c.ok).length
    const chars = group.reduce((n, c) => n + c.chars, 0)
    const first = group.find(c => c.ok)
    const failures = failed === 0 ? '' : `, ${failed} failed`
    return `${ids} ${tool} ×${group.length}${failures} ${charCount(chars)} ${first?.shape ?? ''}`.trimEnd()
  })
}

/** How old a kept result is, short: 40 s old, 12 min old, 3 h old. */
export const age = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s old` : s < 3600 ? `${Math.round(s / 60)} min old` : `${Math.round(s / 3600)} h old`
}

/** The footer of a run with output projection: what came in, what went out, and how to get it again. */
export const projectionFooter = (p: Projection, outcome: RunnerDone | RunnerError | undefined): string => {
  const n = p.calls.length
  const inChars = p.calls.reduce((sum, c) => sum + c.chars, 0)
  const outChars = outcome?.t === 'done' ? outcome.value.length : 0
  const recalls = p.recalls === 0 ? '' : `, ${p.recalls} recall${p.recalls === 1 ? '' : 's'}`
  const head = `--- ${n} MCP call${n === 1 ? '' : 's'}${recalls}: ${charCount(inChars)} characters in, ${charCount(outChars)} out ---`
  const recalled = p.recalled.length === 0 ? [] : [`recalled: ${[...new Map(p.recalled.map(r => [r.ref, r])).values()].map(r => `#${r.ref} (${age(r.ageMs)})`).join(', ')}`]
  if (n === 0) return [head, ...recalled].join('\n')
  const lines = n <= MAX_CALL_LINES ? p.calls.map(callLine) : groupLines(p.calls)
  const missed = missedData(outcome, p.calls) ? ['The result is empty, but the calls returned data: check the shapes.'] : []
  return [head, ...lines, ...recalled, ...missed, 'await recall(n) returns result #n again, with no new call.'].join('\n')
}

const words = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1)

/** Ranks tools by how many query words their name and description hold. */
export const rankTools = (tools: readonly ToolEntry[], query: string, limit: number): ToolEntry[] => {
  const wanted = words(query)
  const scored = tools.map(tool => {
    const name = tool.name.toLowerCase()
    const description = tool.description.toLowerCase()
    let score = 0
    for (const w of wanted) {
      if (name.includes(w)) score += 3
      else if (description.includes(w)) score += 1
    }
    return { tool, score }
  })
  return scored
    .filter(s => wanted.length === 0 || s.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(s => s.tool)
}

/**
 * The input declaration of one tool in the engine's generated MCP types
 * (`interface McpToolInputs { "mcp__x__y": { ... } }`), or undefined.
 */
export const extractDeclaration = (dts: string, name: string): string | undefined => {
  const keys = [`"${name}"`, `'${name}'`]
  let at = -1
  for (const key of keys) {
    const found = dts.indexOf(`${key}:`)
    if (found >= 0) {
      at = found
      break
    }
  }
  if (at < 0) return undefined
  const open = dts.indexOf('{', at)
  if (open < 0) return undefined
  let depth = 0
  for (let i = open; i < dts.length; i++) {
    const c = dts[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return dedent(dts.slice(open, i + 1))
    }
  }
  return undefined
}

// Re-indents a block cut from the middle of a file: its closing brace at
// column 0, everything else shifted by the same amount.
const dedent = (block: string): string => {
  const lines = block.split('\n')
  if (lines.length === 1) return block
  const last = lines[lines.length - 1]!
  const cut = last.length - last.trimStart().length
  return [lines[0], ...lines.slice(1).map(l => l.slice(Math.min(cut, l.length - l.trimStart().length)))].join('\n')
}

export const RUN_DESCRIPTION = `Run a JavaScript program that calls MCP tools, and get back only what it returns. Use it instead of direct MCP tool calls, for one call or many: intermediate data stays out of the context.

The program is the body of an async function. Available:
- await call("mcp__<server>__<tool>", args) -> the tool result (parsed JSON when the tool returns JSON, else text)
- console.log(...) -> shown after the result
- return <value> -> the result, as JSON

A failed call throws an Error (catch it to continue). Promise.all runs calls in parallel. There is no require, fetch, process, filesystem or timers: only MCP tools.

Find tools, their argument types and usage hints with search_tools first. When a task took more than one try (a search, a tool, an argument, a result format), propose what worked with add_hint, so the next session gets it right the first time.

Example:
const issues = await call("mcp__linear__list_issues", { assignee: "me" })
const open = issues.filter(i => i.state !== "Done")
return open.map(i => ({ id: i.id, title: i.title }))`

export const SEARCH_DESCRIPTION = `Find MCP tools to use from run_code. Give keywords (for example "jira issue create"); get the matching tool names, their descriptions and, when known, their argument types. Use an empty query to list all MCP tools.`

/**
 * The note after a run that worked where earlier tries did not: the servers
 * whose calls failed before and work now, and the searches that found nothing.
 */
export const hintNudge = (servers: readonly string[], missedSearches: readonly string[]): string => {
  if (servers.length === 0 && missedSearches.length === 0) return ''
  const failed = servers.length === 0 ? [] : [`Calls to ${servers.join(', ')} failed earlier and work now.`]
  const missed = missedSearches.length === 0 ? [] : [`search_tools found nothing for ${missedSearches.map(q => JSON.stringify(q)).join(', ')}.`]
  return `## Worth a hint\n\n${[...failed, ...missed].join(' ')} If you know what made it work (the search words, the tool, an argument, a format), propose it with add_hint, one short fact per hint, so the next session gets it right the first time.`
}
