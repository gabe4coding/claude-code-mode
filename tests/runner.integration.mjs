// Integration test for the real sandbox, under Node (the plugin test kit has
// no processes). Starts runtime/runner.mjs the way hooks/register.tsx does and
// answers its calls by writing reply files.
//
//   node tests/runner.integration.mjs

import { execFileSync, spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RUNNER = path.join(ROOT, 'runtime', 'runner.mjs')

// Copies of LAUNCH, NO_NETWORK and MKTEMP in hooks/register.tsx and of MARK in the
// runner and hooks/protocol.ts. The first case fails when a copy differs.
const NO_NETWORK = '(version 1)(allow default)(deny network*)'
const LAUNCH = [
  'ulimit -t "$1"',
  'if [ -x /usr/bin/sandbox-exec ]; then',
  '  exec /usr/bin/sandbox-exec -p "$2" "$3" --permission --allow-fs-read="$4" --allow-fs-read="$5" "$4" "$5"',
  'fi',
  'exec "$3" --permission --allow-fs-read="$4" --allow-fs-read="$5" "$4" "$5"',
].join('\n')
const MKTEMP = ['mktemp', '-d', '-t', 'code-mode.XXXXXX']
const MARK = '\u0001cm '

const echo = m => (m.tool.endsWith('fail') ? { ok: false, error: 'boom' } : { ok: true, value: { tool: m.tool, args: m.args } })

// `script` replaces the runner, to test what the launch allows the process.
const run = (code, { timeoutMs = 5000, cpuSeconds = 10, answer = echo, script = RUNNER, env = process.env } = {}) => {
  // The plugin's own command, so CI runs it on Linux and on macOS.
  const xdir = execFileSync(MKTEMP[0], MKTEMP.slice(1), { encoding: 'utf8' }).trim()
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', LAUNCH, 'code-mode', String(cpuSeconds), NO_NETWORK, process.execPath, script, xdir], { env })
    child.stdin.on('error', () => {}) // a probe exits without reading stdin
    child.stdin.end(JSON.stringify({ code, timeoutMs }))
    let buffer = ''
    let calls = 0
    let outcome
    child.stdout.on('data', d => {
      buffer += d
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        if (!line.startsWith(MARK)) continue
        const m = JSON.parse(line.slice(MARK.length))
        if (m.t !== 'call') outcome = m
        else {
          calls++
          setTimeout(() => fs.writeFileSync(path.join(xdir, `r${m.id}.json`), JSON.stringify(answer(m))), 10)
        }
      }
    })
    child.on('close', (exit, signal) => {
      fs.rmSync(xdir, { recursive: true, force: true })
      resolve({ exit, signal, calls, outcome })
    })
  })
}

// Runs in place of the runner, with the same launch: it tries what a program
// that got out of the vm context could do, and returns each error code.
const PROBE = String.raw`
import fs from 'node:fs'
import net from 'node:net'
import cp from 'node:child_process'
import { Worker } from 'node:worker_threads'
const xdir = process.argv[2]
const attempt = async f => { try { await f(); return 'allowed' } catch (e) { return e.code ?? e.message } }
const result = {
  write: await attempt(() => fs.writeFileSync(xdir + '/probe.txt', 'x')),
  read: await attempt(() => fs.readFileSync('/etc/hosts')),
  spawn: await attempt(() => cp.execFileSync('/bin/echo', ['x'])),
  worker: await attempt(() => new Worker('1', { eval: true }).terminate()),
  connect: await attempt(() => new Promise((resolve, reject) => {
    const socket = net.connect(Number(process.env.PROBE_PORT), '127.0.0.1', () => { socket.end(); resolve() })
    socket.on('error', reject)
  })),
}
process.stdout.write('\u0001cm ' + JSON.stringify({ t: 'done', value: JSON.stringify(result), logs: [] }) + '\n')
`

const probe = async () => {
  // The real path: on macOS the temp dir is under a link, and --allow-fs-read takes real paths.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-mode-probe-')))
  const server = net.createServer(socket => socket.end())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    fs.writeFileSync(path.join(dir, 'probe.mjs'), PROBE)
    const r = await run('', { script: path.join(dir, 'probe.mjs'), env: { ...process.env, PROBE_PORT: String(server.address().port) } })
    assert.equal(r.outcome?.t, 'done', `the probe did not finish: exit ${r.exit}`)
    return JSON.parse(r.outcome.value)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// The network block exists only where sandbox-exec does (macOS).
const HAS_SANDBOX_EXEC = fs.existsSync('/usr/bin/sandbox-exec')

const value = r => (r.outcome?.t === 'done' ? JSON.parse(r.outcome.value) : undefined)
const failure = r => (r.outcome?.t === 'error' ? r.outcome.message : undefined)

const cases = {
  'the copies match the plugin': () => {
    const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')
    const src = read('hooks/register.tsx')
    const block = src.match(/const LAUNCH = \[\n([\s\S]*?)\n\]\.join\('\\n'\)/)
    assert.ok(block, 'LAUNCH not found in hooks/register.tsx')
    assert.deepEqual(block[1].split('\n').map(l => l.trim().replace(/^'(.*)',?$/, '$1')), LAUNCH.split('\n'), 'LAUNCH differs')
    assert.ok(src.includes(`const NO_NETWORK = '${NO_NETWORK}'`), 'NO_NETWORK differs')
    assert.ok(src.includes(`const MKTEMP = ${JSON.stringify(MKTEMP).replaceAll('"', "'").replaceAll(',', ', ')}`), 'MKTEMP differs')
    assert.equal(MARK, '\u0001cm ')
    for (const file of ['runtime/runner.mjs', 'hooks/protocol.ts']) assert.match(read(file), /const MARK = '\\u0001cm '/, `MARK differs in ${file}`)
  },

  'returns a value': async () => assert.equal(value(await run('return 1 + 1')), 2),

  'parallel calls and console': async () => {
    const r = await run(`
      const [a, b] = await Promise.all([call("mcp__s__t", { n: 1 }), tools["a-b"].c({ n: 2 })])
      console.log("got", a.args.n + b.args.n)
      return [a.tool, b.tool]`)
    assert.deepEqual(value(r), ['mcp__s__t', 'mcp__a-b__c'])
    assert.deepEqual(r.outcome.logs, ['got 3'])
    assert.equal(r.calls, 2)
  },

  'failed call throws': async () =>
    assert.equal(value(await run('try { await call("mcp__s__fail") } catch (e) { return e.message }')), 'boom'),

  'no host globals': async () =>
    assert.deepEqual(value(await run('return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof __deliver]')), Array(5).fill('undefined')),

  'no escape through constructors': async () => {
    for (const code of [
      'return globalThis.constructor.constructor("return process")().pid',
      'return this.constructor.constructor("return process")().pid',
      'return call.constructor("return 1")()',
      'try { await call("mcp__s__fail") } catch (e) { return e.constructor.constructor("return process")().pid }',
      'return (await call("mcp__s__t")).constructor.constructor("return process")().pid',
    ]) assert.match(failure(await run(code)) ?? 'escaped', /EvalError/, code)
  },

  'wall-clock timeout': async () => assert.match(failure(await run('await new Promise(() => {})', { timeoutMs: 500 })), /timeout/),

  'cpu limit kills busy loops': async () => {
    const r = await run('while (true) {}', { cpuSeconds: 1, timeoutMs: 60_000 })
    assert.equal(r.outcome, undefined)
    assert.notEqual(r.exit, 0)
  },

  'syntax error': async () => assert.match(failure(await run('return )(')), /SyntaxError/),

  'the process cannot write, read other files, or start processes': async () => {
    const r = await probe()
    assert.deepEqual(
      { write: r.write, read: r.read, spawn: r.spawn, worker: r.worker },
      { write: 'ERR_ACCESS_DENIED', read: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED', worker: 'ERR_ACCESS_DENIED' },
    )
  },

  ...(HAS_SANDBOX_EXEC
    ? { 'the process has no network (sandbox-exec)': async () => assert.equal((await probe()).connect, 'EPERM') }
    : {}),
}

if (!HAS_SANDBOX_EXEC) console.log('skip  the process has no network: no sandbox-exec here')

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
console.log(failed === 0 ? 'all passed' : `${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
