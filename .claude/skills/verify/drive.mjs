#!/usr/bin/env node
// Drives this plugin in real Claude Code against the bench's fake MCP server,
// for /verify. Each run gets its own folder, server name and session id; the
// prompt and the tool names can say {srv} for the server name.
//
//   node drive.mjs run "<prompt>" [--auto] [--allow t1,t2] [--settings <json>]
//                      [--max-output-tokens N] [--model haiku] [--base <dir>]
//   node drive.mjs evidence <dir>
//   node drive.mjs clean <dir>
//   node drive.mjs band start [--settings <json>] [--model haiku] [--base <dir>]
//   node drive.mjs band send <dir> "<text>"
//   node drive.mjs band wait "<text>" [seconds]
//   node drive.mjs band capture
//   node drive.mjs band click "<label>"
//   node drive.mjs band files <dir>
//   node drive.mjs band restart <dir>
//   node drive.mjs band stop <dir>
//
// `run` prints the evidence as JSON. `clean` removes what a run saved outside
// its folder (shapes.json, args.json, files/, metrics/, the transcript), then
// the folder. `band` uses the tmux socket "cmverify".

import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { forgetRuns } from '../../../bench/forget.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const HOME = path.join(os.homedir(), '.claude')
const SOCKET = 'cmverify'
const TIMEOUT_MS = 300_000

const [cmd, ...rest] = process.argv.slice(2)
const flags = {}
const args = []
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) args.push(rest[i])
  else if (rest[i] === '--auto') flags.auto = true
  else flags[rest[i].slice(2)] = rest[++i]
}

const die = msg => {
  console.error(msg)
  process.exit(2)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const readJsonl = file =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const projectDirOf = cwd => path.join(HOME, 'projects', fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'))
const fill = (text, meta) => text.replaceAll('{srv}', meta.server)

// A folder with cwd/, mcp.json for the fake server and meta.json.
function newRun() {
  const base = flags.base ?? os.tmpdir()
  const dir = fs.mkdtempSync(path.join(base, 'cm-verify-'))
  fs.mkdirSync(path.join(dir, 'cwd'))
  const meta = { dir, server: `verify_${crypto.randomUUID().slice(0, 8)}`, sessions: [] }
  const server = { command: 'node', args: [path.join(ROOT, 'bench', 'fake-server.mjs')], env: { BENCH_LOG: path.join(dir, 'calls.jsonl') } }
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { [meta.server]: server } }))
  saveMeta(meta)
  return meta
}
const saveMeta = meta => fs.writeFileSync(path.join(meta.dir, 'meta.json'), JSON.stringify(meta, null, 2))
const loadMeta = dir => {
  if (!dir || !fs.existsSync(path.join(dir, 'meta.json'))) die(`no run folder: ${dir}`)
  return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
}
const settingsFile = (meta, extra) => {
  const file = path.join(meta.dir, 'settings.json')
  fs.writeFileSync(file, fill(extra ?? '{}', meta))
  return file
}

async function run() {
  if (!args[0]) die('usage: drive.mjs run "<prompt>" [--auto] [--allow t1,t2] [--settings <json>]')
  const meta = newRun()
  const session = crypto.randomUUID()
  meta.sessions.push(session)
  saveMeta(meta)
  const argv = [
    '-p', fill(args[0], meta),
    '--restricted', '--strict-mcp-config', '--mcp-config', path.join(meta.dir, 'mcp.json'),
    '--plugin-dir', ROOT,
    '--settings', settingsFile(meta, flags.settings),
    '--output-format', 'json', '--session-id', session, '--max-budget-usd', '0.5',
    '--model', flags.model ?? 'haiku',
  ]
  if (flags.auto) argv.push('--permission-mode', 'auto')
  if (flags.allow) argv.push('--allowedTools', fill(flags.allow, meta))
  const env = { ...process.env }
  if (flags['max-output-tokens']) env.MAX_MCP_OUTPUT_TOKENS = flags['max-output-tokens']
  const out = fs.openSync(path.join(meta.dir, 'out.json'), 'w')
  const err = fs.openSync(path.join(meta.dir, 'stderr.txt'), 'w')
  meta.exit = await new Promise(resolve => {
    const child = spawn('claude', argv, { cwd: path.join(meta.dir, 'cwd'), stdio: ['ignore', out, err], env })
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.on('error', e => resolve(e.message))
    child.on('close', code => (clearTimeout(timer), resolve(code)))
  })
  saveMeta(meta)
  evidence(meta)
}

// What the run did, read from its files: never from the words of the model alone.
function evidence(meta) {
  const projectDir = projectDirOf(path.join(meta.dir, 'cwd'))
  const out = fs.existsSync(path.join(meta.dir, 'out.json')) ? fs.readFileSync(path.join(meta.dir, 'out.json'), 'utf8') : ''
  const result = out ? JSON.parse(out) : {}
  const rows = meta.sessions.flatMap(s => readJsonl(path.join(projectDir, `${s}.jsonl`)))
  const blocks = rows.flatMap(r => (Array.isArray(r.message?.content) ? r.message.content : []))
  const textOf = c => (typeof c === 'string' ? c : (c ?? []).map(b => b.text ?? '').join('\n'))
  const savedDir = s => path.join(projectDir, s, 'tool-results')
  console.log(JSON.stringify({
    dir: meta.dir,
    server: meta.server,
    sessions: meta.sessions,
    exit: meta.exit,
    isError: result.is_error,
    costUsd: result.total_cost_usd,
    reply: result.result,
    calls: readJsonl(path.join(meta.dir, 'calls.jsonl')).map(({ tool, args, isError }) => ({ tool, args, isError })),
    toolUses: blocks.filter(b => b.type === 'tool_use').map(b => ({ name: b.name, input: b.input })),
    toolResults: blocks.filter(b => b.type === 'tool_result').map(b => textOf(b.content).slice(0, 800)),
    hookContext: rows.filter(r => r.attachment?.type === 'hook_additional_context').flatMap(r => r.attachment.content).filter(t => t.includes('code-mode')),
    savedResults: meta.sessions.flatMap(s => (fs.existsSync(savedDir(s)) ? fs.readdirSync(savedDir(s)) : [])),
  }, null, 2))
}

function clean(meta) {
  forgetRuns(tool => tool.startsWith(`mcp__${meta.server}__`), meta.sessions)
  fs.rmSync(projectDirOf(path.join(meta.dir, 'cwd')), { recursive: true, force: true })
  fs.rmSync(meta.dir, { recursive: true, force: true })
  console.log(`cleaned ${meta.dir}`)
}

const tmux = (...a) => execFileSync('tmux', ['-L', SOCKET, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const capture = () => tmux('capture-pane', '-p', '-t', 'v')
async function waitFor(text, seconds = 30) {
  for (let i = 0; i < seconds * 2; i++) {
    if (capture().includes(text)) return true
    await sleep(500)
  }
  return false
}
// A left click as an SGR mouse report at the label's 1-based row and column.
function click(label) {
  const lines = capture().split('\n')
  const row = lines.findIndex(l => l.includes(label))
  if (row < 0) die(`not on screen: ${label}`)
  const col = [...lines[row].slice(0, lines[row].indexOf(label))].length + 2
  for (const end of ['M', 'm']) tmux('send-keys', '-t', 'v', '-l', `\x1b[<0;${col};${row + 1}${end}`)
  console.log(`clicked ${label} at row ${row + 1}, col ${col}`)
}
function startClaude(meta, extra = []) {
  const argv = ['claude', ...extra, '--plugin-dir', ROOT, '--strict-mcp-config', '--mcp-config', path.join(meta.dir, 'mcp.json'), '--settings', path.join(meta.dir, 'settings.json'), '--model', meta.model]
  // remain-on-exit keeps the pane, so a capture shows why Claude Code ended.
  tmux('new-session', '-d', '-s', 'v', '-x', '150', '-y', '45', '-c', path.join(meta.dir, 'cwd'), argv.map(a => `'${a}'`).join(' '), ';', 'set-option', '-t', 'v', 'remain-on-exit', 'on')
}
// The trust dialog of the run's own empty folder. Keys sent too fast pick "No, exit".
async function acceptTrust() {
  if (!(await waitFor('trust this folder', 20))) return
  await sleep(1000)
  tmux('send-keys', '-t', 'v', 'Down')
  await sleep(500)
  tmux('send-keys', '-t', 'v', 'Enter')
}

// projectHints sends the proposals to the run's own project, not to ~/.claude.
const BAND_SETTINGS = '{"permissions":{"allow":["mcp__code-mode__add_hint","mcp__code-mode__remove_hint"]},"pluginConfigs":{"code-mode":{"options":{"projectHints":true}}}}'

async function band() {
  const [sub, a1, a2] = args
  if (sub === 'start') {
    const meta = newRun()
    meta.model = flags.model ?? 'haiku'
    settingsFile(meta, flags.settings ?? BAND_SETTINGS)
    saveMeta(meta)
    startClaude(meta)
    await acceptTrust()
    console.log(JSON.stringify({ dir: meta.dir, server: meta.server, ready: await waitFor('Claude Code v', 30) }))
  } else if (sub === 'send') {
    tmux('send-keys', '-t', 'v', '-l', fill(a2, loadMeta(a1)))
    await sleep(300)
    tmux('send-keys', '-t', 'v', 'Enter')
  } else if (sub === 'wait') {
    if (!(await waitFor(a1, Number(a2 ?? 60)))) die(`not seen in time: ${a1}`)
  } else if (sub === 'capture') {
    console.log(capture().replace(/\n{3,}/g, '\n\n'))
  } else if (sub === 'click') {
    click(a1)
  } else if (sub === 'files') {
    const root = path.join(loadMeta(a1).dir, 'cwd', '.claude')
    console.log(fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).join('\n') : '(no .claude folder)')
  } else if (sub === 'restart') {
    tmux('kill-server')
    startClaude(loadMeta(a1), ['--continue'])
  } else if (sub === 'stop') {
    const meta = loadMeta(a1)
    try { tmux('kill-server') } catch {}
    meta.sessions = fs.existsSync(projectDirOf(path.join(meta.dir, 'cwd')))
      ? fs.readdirSync(projectDirOf(path.join(meta.dir, 'cwd'))).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6))
      : []
    clean(meta)
  } else die('usage: drive.mjs band start|send|wait|capture|click|files|restart|stop')
}

if (cmd === 'run') await run()
else if (cmd === 'evidence') evidence(loadMeta(args[0]))
else if (cmd === 'clean') clean(loadMeta(args[0]))
else if (cmd === 'band') await band()
else die('usage: drive.mjs run|evidence|clean|band (see the top of this file)')
