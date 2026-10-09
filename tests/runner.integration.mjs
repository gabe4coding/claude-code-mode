// Integration test for the real sandbox, under Node (the plugin test kit has
// no processes). Starts runtime/runner.mjs the way hooks/register.ts does and
// answers its calls by writing reply files.
//
//   node tests/runner.integration.mjs

import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RUNNER = path.join(ROOT, 'runtime', 'runner.mjs')

// Keep in step with LAUNCH and NO_NETWORK in hooks/register.ts.
const NO_NETWORK = '(version 1)(allow default)(deny network*)'
const LAUNCH = [
  'ulimit -t "$1"',
  'if [ -x /usr/bin/sandbox-exec ]; then',
  '  exec /usr/bin/sandbox-exec -p "$2" "$3" --permission --allow-fs-read="$4" --allow-fs-read="$5" "$4" "$5"',
  'fi',
  'exec "$3" --permission --allow-fs-read="$4" --allow-fs-read="$5" "$4" "$5"',
].join('\n')
const MARK = '\u0001cm '

const echo = m => (m.tool.endsWith('fail') ? { ok: false, error: 'boom' } : { ok: true, value: { tool: m.tool, args: m.args } })

const run = (code, { timeoutMs = 5000, cpuSeconds = 10, answer = echo } = {}) => {
  const xdir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-mode-it-'))
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', LAUNCH, 'code-mode', String(cpuSeconds), NO_NETWORK, process.execPath, RUNNER, xdir])
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

const value = r => (r.outcome?.t === 'done' ? JSON.parse(r.outcome.value) : undefined)
const failure = r => (r.outcome?.t === 'error' ? r.outcome.message : undefined)

const cases = {
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
console.log(failed === 0 ? 'all passed' : `${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
