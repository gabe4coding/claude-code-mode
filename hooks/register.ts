import type { Register } from 'claude-code'
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

type Options = { node?: string; timeoutSeconds?: number; blockDirectMcp?: boolean; approval?: string }

export const register: Register = (on, options) => {
  const opts = options as Options
  const node = opts.node || 'node'
  const timeoutSeconds = Math.max(5, Number(opts.timeoutSeconds) || 120)
  const programApproval = opts.approval !== 'per-call'

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
    return next(e)
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
    return { result: `${found.length} of ${all.length} MCP tools. Call them in run_code with call("<name>", args).\n\n${blocks.join('\n\n')}` }
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

    return { result: formatOutcome(outcome, calls, stderr, MAX_RESULT_CHARS) }
  }).catch(() => ({ deny: 'code-mode: run_code failed; see the debug log.' }))

  // Optional: push the model to run_code by refusing its direct MCP calls.
  // Calls this plugin makes (from run_code) pass.
  on('tool.call', ($, e, next) => {
    if (opts.blockDirectMcp !== true) return next(e)
    if (!isCallable(e.tool, $.plugin.name)) return next(e)
    if (next.origin.plugin === $.plugin.name) return next(e)
    return { deny: `code-mode: call this tool from run_code instead: await call("${e.tool}", { ... })` }
  }).catch(($, e, next) => next(e))
}
