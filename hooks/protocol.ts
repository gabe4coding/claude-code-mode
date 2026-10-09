// Pure helpers for code-mode: the runner's wire protocol, result shaping,
// tool search and type extraction. No `$` here, so tests can call them directly.

export const MARK = '\u0001cm '

export type RunnerCall = { t: 'call'; id: number; tool: string; args: Record<string, unknown> }
export type RunnerDone = { t: 'done'; value: string; logs: string[] }
export type RunnerError = { t: 'error'; message: string; logs: string[] }
export type RunnerMessage = RunnerCall | RunnerDone | RunnerError

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

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n… [${text.length - max} more characters cut; return less data]`

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
): string => {
  const parts: string[] = []
  if (outcome === undefined) {
    parts.push('Error: the sandbox exited without a result.')
    if (stderr.trim() !== '') parts.push(`stderr:\n${clip(stderr.trim(), 2000)}`)
  } else if (outcome.t === 'done') {
    parts.push(clip(pretty(outcome.value), maxChars))
  } else {
    const message = /^\w*Error: /.test(outcome.message) ? outcome.message : `Error: ${outcome.message}`
    parts.push(clip(message, 4000))
  }
  const logs = outcome?.logs ?? []
  if (logs.length > 0) parts.push(`--- console (${logs.length} lines) ---\n${clip(logs.join('\n'), 4000)}`)
  parts.push(`--- ${calls} MCP call${calls === 1 ? '' : 's'} ---`)
  return parts.join('\n\n')
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

export const RUN_DESCRIPTION = `Run a JavaScript program that calls MCP tools, and get back only what it returns. Use it instead of direct MCP tool calls when a task needs several calls, loops, filtering or joining of results: intermediate data stays out of the context.

The program is the body of an async function. Available:
- await call("mcp__<server>__<tool>", args) -> the tool result (parsed JSON when the tool returns JSON, else text)
- console.log(...) -> shown after the result
- return <value> -> the result, as JSON

A failed call throws an Error (catch it to continue). Promise.all runs calls in parallel. There is no require, fetch, process, filesystem or timers: only MCP tools.

Find tools, their argument types and usage hints with search_tools first. When you learn something a later program needs (a result format, a limit, a fix), propose it with add_hint.

Example:
const issues = await call("mcp__linear__list_issues", { assignee: "me" })
const open = issues.filter(i => i.state !== "Done")
return open.map(i => ({ id: i.id, title: i.title }))`

export const SEARCH_DESCRIPTION = `Find MCP tools to use from run_code. Give keywords (for example "jira issue create"); get the matching tool names, their descriptions and, when known, their argument types. Use an empty query to list all MCP tools.`
