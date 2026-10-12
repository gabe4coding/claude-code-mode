// End-to-end smoke test: real headless Claude Code, this plugin and the fake
// MCP server of the bench. The other tests fake one side of each seam: the
// hooks tests fake the runner and Claude Code, the sandbox test fakes the
// plugin. This test runs them all together.
//
//   node tests/smoke.e2e.mjs                   one run with Haiku
//   node tests/smoke.e2e.mjs --model sonnet --keep
//
// It needs a logged-in Claude Code and costs API usage (less than $0.01 with
// Haiku 5.5), so CI does not run it. The prompt gives the model an exact
// program. The checks read the transcript, the calls that the fake server got
// and the files of the plugin, never the words of the model. If a check says
// that the model did not do a step, run the test again: the model can skip a
// step. --keep keeps the run folder; a failed run always keeps it.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ISSUES } from '../bench/data.mjs'
import { forgetRuns } from '../bench/forget.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}
const model = arg('--model', 'haiku')
const keep = process.argv.includes('--keep')
const TIMEOUT_MS = 300_000

// Its own server name, so the run sees no shapes or argument names of an
// earlier run. The end of the test removes what the run saved.
const server = `smoke_${crypto.randomUUID().slice(0, 8)}`
const tool = name => `mcp__${server}__${name}`
const RUN = 'mcp__code-mode__run_code'
const SEARCH = 'mcp__code-mode__search_tools'
const sessionId = crypto.randomUUID()
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'code-mode-smoke-'))
const cwd = path.join(out, 'cwd')
fs.mkdirSync(cwd)
const log = path.join(out, 'calls.jsonl')
const mcp = path.join(out, 'mcp.json')
fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { [server]: { command: 'node', args: [path.join(ROOT, 'bench', 'fake-server.mjs')], env: { BENCH_LOG: log } } } }))

// The low MAX_MCP_OUTPUT_TOKENS makes Claude Code save the list_issues result
// (all of ISSUES) to a file and give a note with its path. The plugin
// finds the note by its wording, so a new Claude Code release can break it.
const MAX_MCP_OUTPUT_TOKENS = '5000'

// list_issues has an allow rule. create_ticket has no rule: claude -p cannot
// ask, so the call must be refused. get_deploys has a deny rule, which takes
// it out of the session: the check before the run must stop the second
// program and say that a deny rule can hide the tool.
const PROGRAM = `const issues = await call("${tool('list_issues')}", { project: "OPS" })
const denied = await call("${tool('create_ticket')}", { title: "smoke" }).then(() => "ran", e => e.message)
const saved = await saveFile("smoke.json", { total: issues.total })
const back = JSON.parse(await readFile(saved))
return { total: issues.total, count: issues.issues.length, back: back.total, denied, process: typeof process, require: typeof require }`
const DENIED_PROGRAM = `return await call("${tool('get_deploys')}", { date: "2026-10-09" })`
const PROMPT = `Do these three steps, in this order. Do not change the program.
1. Call ${RUN} with exactly this code:
${PROGRAM}
2. Call ${SEARCH} with the query "list issues".
3. Call ${RUN} with exactly this code:
${DENIED_PROGRAM}
Then reply with the word DONE.`

const settings = {
  permissions: { deny: [tool('get_deploys')] },
  pluginConfigs: { 'code-mode': { options: { blockDirectMcp: true, metrics: true } } },
}
const argv = [
  '-p', PROMPT,
  '--restricted', '--strict-mcp-config', '--mcp-config', mcp,
  '--plugin-dir', ROOT,
  '--settings', JSON.stringify(settings),
  '--allowedTools', `${RUN},${SEARCH},${tool('list_issues')}`,
  '--output-format', 'json', '--session-id', sessionId, '--max-budget-usd', '0.5',
  '--model', model,
]

console.log(`claude -p with ${model}, into ${out}`)
const exit = await new Promise(resolve => {
  const child = spawn('claude', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MAX_MCP_OUTPUT_TOKENS } })
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
  child.stdout.on('data', d => fs.appendFileSync(path.join(out, 'out.json'), d))
  child.stderr.on('data', d => fs.appendFileSync(path.join(out, 'stderr.txt'), d))
  child.on('error', err => resolve(err.message))
  child.on('close', code => {
    clearTimeout(timer)
    resolve(code)
  })
})

const readLines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
const HOME = path.join(os.homedir(), '.claude')
const projectDir = path.join(HOME, 'projects', fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'))
const transcript = readLines(path.join(projectDir, `${sessionId}.jsonl`))
const blocks = transcript.flatMap(row => (Array.isArray(row.message?.content) ? row.message.content : []))
const uses = blocks.filter(b => b.type === 'tool_use')
// The result of the nth call of a tool (0 is the first).
const resultText = (name, n = 0) => {
  const use = uses.filter(b => b.name === name)[n]
  assert.ok(use, `the model did not call ${name}${n === 0 ? '' : ` ${n + 1} times`}`)
  const result = blocks.find(b => b.type === 'tool_result' && b.tool_use_id === use.id)
  assert.ok(result, `${name} has no result`)
  return typeof result.content === 'string' ? result.content : result.content.map(c => c.text ?? '').join('\n')
}
const calls = readLines(log)
const metricsFile = path.join(HOME, 'code-mode', 'metrics', `${sessionId}.jsonl`)

const cases = {
  'claude -p ends with no error': () => {
    assert.equal(exit, 0, `exit ${exit}, see stderr.txt`)
    const result = JSON.parse(fs.readFileSync(path.join(out, 'out.json'), 'utf8'))
    assert.equal(result.is_error, false, result.result)
  },

  // The option reaches the command hook as CLAUDE_PLUGIN_OPTION_BLOCKDIRECTMCP.
  'the SessionStart hook gives its context, with the option set': () => {
    const context = transcript.filter(r => r.attachment?.type === 'hook_additional_context').flatMap(r => r.attachment.content)
    assert.ok(context.some(t => t.includes('Direct MCP tool calls are denied.')), `context: ${JSON.stringify(context)}`)
  },

  'the model calls run_code, and no MCP tool directly': () => {
    assert.ok(uses.some(b => b.name === RUN), `tool calls: ${uses.map(b => b.name).join(', ')}`)
    assert.deepEqual(uses.filter(b => b.name.startsWith(`mcp__${server}__`)).map(b => b.name), [])
  },

  'a nested call with an allow rule reaches the MCP server': () => {
    assert.deepEqual(calls.filter(c => c.tool === 'list_issues').map(c => c.args), [{ project: 'OPS' }])
  },

  'the program runs in the sandbox and returns its value': () => {
    const text = resultText(RUN)
    assert.match(text, new RegExp(`"total": ${ISSUES.length}\\b`), text)
    assert.match(text, /"process": "undefined"/, text)
    assert.match(text, /"require": "undefined"/, text)
  },

  'a nested call that nobody approved does not reach the MCP server': () => {
    const text = resultText(RUN)
    assert.match(text, /"denied": "/, text)
    assert.doesNotMatch(text, /"denied": "ran"/, text)
    assert.deepEqual(calls.filter(c => c.tool === 'create_ticket'), [])
  },

  'a result that Claude Code saved to a file reaches the program whole': () => {
    // A large hook output of another plugin is saved there too, as hook-*.
    const saved = path.join(projectDir, sessionId, 'tool-results')
    const results = fs.existsSync(saved) ? fs.readdirSync(saved).filter(f => !f.startsWith('hook-')) : []
    assert.ok(results.length > 0, `Claude Code saved no MCP result to a file: lower MAX_MCP_OUTPUT_TOKENS (${MAX_MCP_OUTPUT_TOKENS})`)
    assert.match(resultText(RUN), new RegExp(`"count": ${ISSUES.length}\\b`))
  },

  'readFile reads the file from saveFile': () => {
    assert.match(resultText(RUN), new RegExp(`"back": ${ISSUES.length}\\b`))
  },

  'search_tools shows the argument names and result shape from the earlier run': () => {
    const text = resultText(SEARCH)
    assert.ok(text.includes(`### ${tool('list_issues')}`), text)
    assert.match(text, /names from earlier calls: \{project\}/, text)
    assert.match(text, /returns \(earlier call\): \{total, issues: /, text)
  },

  'the check before a run names a deny rule for a hidden tool': () => {
    const text = resultText(RUN, 1)
    assert.ok(text.includes(`no tool "${tool('get_deploys')}" on the connected server "${server}"; if the name is right, a deny rule hides it`), text)
    assert.deepEqual(calls.filter(c => c.tool === 'get_deploys'), [])
  },

  // A program that the check before a run stops writes no line.
  'metrics: one line for the run': () => {
    const rows = readLines(metricsFile)
    assert.equal(rows.length, 1, `rows: ${JSON.stringify(rows)}`)
    assert.equal(rows[0].ok, true, `rows: ${JSON.stringify(rows)}`)
  },
}

let failed = 0
for (const [name, fn] of Object.entries(cases)) {
  try {
    await fn()
    console.log(`pass  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`)
  }
}

// Remove what the run saved outside its folder.
forgetRuns(tool => tool.startsWith(`mcp__${server}__`), [sessionId])
if (failed === 0 && !keep) {
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(out, { recursive: true, force: true })
} else {
  if (fs.existsSync(projectDir)) fs.cpSync(projectDir, path.join(out, 'transcript'), { recursive: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
  console.log(`run folder: ${out}`)
}
console.log(failed === 0 ? 'all passed' : `${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
