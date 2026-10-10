// Output projection bench: runs each task in headless Claude Code with the
// option `projection` off and on, against the fake MCP server, and compares.
//
//   node bench/run.mjs                         3 reps of every task, both arms
//   node bench/run.mjs --reps 1 --tasks logs,issues
//   node bench/run.mjs --model sonnet --parallel 4
//   node bench/run.mjs --report <out dir>      the table again, with no new runs
//
// Each run costs API usage (about $0.11 with Opus 5.5, $0.005 with Haiku 5.5). A run is
// `claude -p --restricted --strict-mcp-config`: no user settings, plugins,
// hooks or other MCP servers; Bash is off; direct MCP calls are blocked, so
// every call goes through run_code. Output: <out>/results.jsonl, one row per run.

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASKS } from './data.mjs'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}
const reps = Number(arg('--reps', 3))
const parallel = Number(arg('--parallel', 3))
const model = arg('--model')
const taskIds = arg('--tasks')?.split(',') ?? TASKS.map(t => t.id)
const arms = (arg('--arms', 'off,on')).split(',')
const reportOnly = arg('--report')
const out = reportOnly ?? arg('--out', path.join(os.tmpdir(), `code-mode-bench-${new Date().toISOString().replace(/[:.]/g, '-')}`))
const METRICS = path.join(os.homedir(), '.claude', 'code-mode', 'metrics')

const readLines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])

const runOne = async ({ task, arm, rep }) => {
  const dir = path.join(out, `${task.id}-${arm}-${rep}`)
  const cwd = path.join(dir, 'cwd')
  fs.mkdirSync(cwd, { recursive: true })
  const log = path.join(dir, 'calls.jsonl')
  const mcp = path.join(dir, 'mcp.json')
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { bench: { command: 'node', args: [path.join(REPO, 'bench', 'fake-server.mjs')], env: { BENCH_LOG: log } } } }))
  const settings = { pluginConfigs: { 'code-mode': { options: { projection: arm === 'on', metrics: true, blockDirectMcp: true } } } }
  const sessionId = crypto.randomUUID()
  const argv = [
    '-p', task.prompt,
    '--restricted', '--strict-mcp-config', '--mcp-config', mcp,
    '--plugin-dir', REPO,
    '--settings', JSON.stringify(settings),
    '--allowedTools', 'mcp__code-mode__run_code,mcp__code-mode__search_tools,mcp__bench__*',
    '--output-format', 'json', '--session-id', sessionId, '--max-budget-usd', '1',
    ...(model ? ['--model', model] : []),
  ]
  const started = Date.now()
  const stdout = await new Promise(resolve => {
    const child = spawn('claude', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', d => (text += d))
    child.stderr.on('data', d => fs.appendFileSync(path.join(dir, 'stderr.txt'), d))
    child.on('close', () => resolve(text))
  })
  fs.writeFileSync(path.join(dir, 'out.json'), stdout)
  let result = {}
  try {
    result = JSON.parse(stdout)
  } catch {
    // a run that crashed: graded as wrong
  }
  const calls = readLines(log)
  const runs = readLines(path.join(METRICS, `${sessionId}.jsonl`))
  const seen = new Set()
  let duplicates = 0
  for (const c of calls) {
    const key = `${c.tool}\n${JSON.stringify(c.args, Object.keys(c.args).sort())}`
    if (seen.has(key)) duplicates++
    seen.add(key)
  }
  const answer = String(result.result ?? '')
  const usage = result.usage ?? {}
  return {
    task: task.id, arm, rep, sessionId,
    correct: task.check(answer, calls),
    mcpCalls: calls.length,
    duplicates,
    creates: calls.filter(c => c.tool === 'create_ticket').length,
    runs: runs.length,
    failedRuns: runs.filter(r => !r.ok).length,
    recalls: runs.reduce((n, r) => n + r.recalls, 0),
    cutRuns: runs.filter(r => r.cut).length,
    emptyRuns: runs.filter(r => r.empty).length,
    turns: result.num_turns ?? 0,
    costUsd: result.total_cost_usd ?? 0,
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    ms: Date.now() - started,
    answer: answer.slice(0, 400),
  }
}

const report = rows => {
  const mean = (xs, f) => (xs.length === 0 ? 0 : xs.reduce((n, x) => n + Number(f(x)), 0) / xs.length)
  const fmt = (v, d = 2) => (Number.isInteger(v) ? String(v) : v.toFixed(d))
  const metrics = [
    ['runs of the bench', rs => rs.length, 0],
    ['correct answers', rs => `${rs.filter(r => r.correct).length}/${rs.length}`],
    ['MCP calls per task', rs => mean(rs, r => r.mcpCalls)],
    ['duplicate MCP calls per task', rs => mean(rs, r => r.duplicates)],
    ['tickets created (ticket task)', rs => mean(rs.filter(r => r.task === 'ticket'), r => r.creates)],
    ['run_code runs per task', rs => mean(rs, r => r.runs)],
    ['failed runs per task', rs => mean(rs, r => r.failedRuns)],
    ['recalls per task', rs => mean(rs, r => r.recalls)],
    ['cut results per task', rs => mean(rs, r => r.cutRuns)],
    ['turns per task', rs => mean(rs, r => r.turns)],
    ['input tokens per task', rs => mean(rs, r => r.inputTokens), 0],
    ['output tokens per task', rs => mean(rs, r => r.outputTokens), 0],
    ['cost per task (USD)', rs => mean(rs, r => r.costUsd), 3],
    ['seconds per task', rs => mean(rs, r => r.ms / 1000), 1],
  ]
  const byArm = Object.fromEntries(arms.map(a => [a, rows.filter(r => r.arm === a)]))
  const w = Math.max(...metrics.map(m => m[0].length))
  console.log(`${''.padEnd(w)}  ${arms.map(a => a.padStart(9)).join('  ')}`)
  for (const [name, f, d] of metrics) console.log(`${name.padEnd(w)}  ${arms.map(a => { const v = f(byArm[a]); return (typeof v === 'number' ? fmt(v, d) : v).padStart(9) }).join('  ')}`)
  console.log('\ncorrect answers by task')
  for (const id of [...new Set(rows.map(r => r.task))]) {
    console.log(`  ${id.padEnd(10)} ${arms.map(a => { const rs = byArm[a].filter(r => r.task === id); return `${a} ${rs.filter(r => r.correct).length}/${rs.length}` }).join('   ')}`)
  }
  console.log(`\nrows: ${path.join(out, 'results.jsonl')}`)
}

if (reportOnly) {
  report(readLines(path.join(out, 'results.jsonl')))
} else {
  fs.mkdirSync(out, { recursive: true })
  // Arms alternate inside each rep, so a change of model load over time hits both.
  const jobs = []
  for (let rep = 1; rep <= reps; rep++) for (const task of TASKS.filter(t => taskIds.includes(t.id))) for (const arm of arms) jobs.push({ task, arm, rep })
  console.log(`${jobs.length} runs, ${parallel} at a time, into ${out}`)
  const rows = []
  let next = 0
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      const row = await runOne(job)
      rows.push(row)
      fs.appendFileSync(path.join(out, 'results.jsonl'), `${JSON.stringify(row)}\n`)
      console.log(`${String(rows.length).padStart(3)}/${jobs.length} ${row.task}-${row.arm}-${row.rep} ${row.correct ? 'ok   ' : 'WRONG'} calls=${row.mcpCalls} dup=${row.duplicates} runs=${row.runs} recalls=${row.recalls} $${row.costUsd.toFixed(3)}`)
    }
  }))
  report(rows)
}
