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
const MKTEMP = ['mktemp', '-d', '-t', 'code-mode.XXXXXX']
const MARK = '\u0001cm '

const echo = m =>
  m.t === 'resources'
    ? { ok: true, value: [{ uri: 'file:///a.md', server: m.server ?? 'any' }] }
    : m.t === 'resource'
      ? { ok: true, value: [{ uri: m.uri, text: `text of ${m.server} ${m.uri}` }] }
      : m.t === 'save'
        ? { ok: true, value: { saved: m.name, data: m.data } }
        : m.t === 'read'
          ? { ok: true, value: `text of ${m.path}` }
          : m.t === 'recall'
            ? m.ref === 4
              ? { ok: true, value: { recalled: m.ref } }
              : { ok: false, error: `no result #${m.ref}` }
            : m.tool.endsWith('fail')
              ? { ok: false, error: 'boom' }
              : { ok: true, value: { tool: m.tool, args: m.args } }

// `script` replaces the runner, to test what the launch allows the process.
// `node` is the option of the same name: a name on PATH or a path.
// An `answer` that returns undefined writes no reply: a call that never finishes.
const run = (
  code,
  {
    timeoutMs = 5000,
    cpuSeconds = 10,
    answer = echo,
    script = RUNNER,
    env = process.env,
    node = process.execPath,
    lib,
  } = {},
) => {
  // The plugin's own command, so CI runs it on Linux and on macOS.
  const xdir = execFileSync(MKTEMP[0], MKTEMP.slice(1), { encoding: 'utf8' }).trim()
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', LAUNCH, 'code-mode', String(cpuSeconds), NO_NETWORK, node, script, xdir], {
      env,
    })
    child.stdin.on('error', () => {}) // a launch that ends early does not read stdin
    child.stdin.end(JSON.stringify({ code, timeoutMs, lib }))
    let buffer = ''
    let stderr = ''
    let calls = 0
    let outcome
    child.stderr.on('data', d => (stderr += d))
    child.stdout.on('data', d => {
      buffer += d
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        if (!line.startsWith(MARK)) continue
        const m = JSON.parse(line.slice(MARK.length))
        if (m.t === 'done' || m.t === 'error') outcome = m
        else {
          calls++
          const reply = answer(m)
          if (reply !== undefined)
            setTimeout(() => fs.writeFileSync(path.join(xdir, `r${m.id}.json`), JSON.stringify(reply)), 10)
        }
      }
    })
    child.on('close', (exit, signal) => {
      fs.rmSync(xdir, { recursive: true, force: true })
      resolve({ exit, signal, calls, outcome, stderr })
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
// The port comes in place of the program: the process has no environment variables.
const port = Number(JSON.parse(fs.readFileSync(0, 'utf8')).code)
const attempt = async f => { try { await f(); return 'allowed' } catch (e) { return e.code ?? e.message } }
const result = {
  write: await attempt(() => fs.writeFileSync(xdir + '/probe.txt', 'x')),
  read: await attempt(() => fs.readFileSync('/etc/hosts')),
  spawn: await attempt(() => cp.execFileSync('/bin/echo', ['x'])),
  worker: await attempt(() => new Worker('1', { eval: true }).terminate()),
  connect: await attempt(() => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve() })
    socket.on('error', reject)
  })),
  env: Object.keys(process.env),
}
process.stdout.write('\u0001cm ' + JSON.stringify({ t: 'done', value: JSON.stringify(result), logs: [] }) + '\n')
`

const runProbe = async () => {
  // The real path: on macOS the temp dir is under a link, and --allow-fs-read takes real paths.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-mode-probe-')))
  const server = net.createServer(socket => socket.end())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    fs.writeFileSync(path.join(dir, 'probe.mjs'), PROBE)
    const r = await run(String(server.address().port), {
      script: path.join(dir, 'probe.mjs'),
      env: { ...process.env, CODE_MODE_SECRET: 'fake' },
    })
    assert.equal(r.outcome?.t, 'done', `the probe did not finish: exit ${r.exit}`)
    return JSON.parse(r.outcome.value)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// One launch answers every probe case.
let probed
const probe = () => (probed ??= runProbe())

// The network block exists where sandbox-exec does (macOS), and on Linux
// where unshare can make a user and network namespace. CI sets
// EXPECT_NETWORK_BLOCK, so a runner with neither fails instead of skipping.
const HAS_SANDBOX_EXEC = fs.existsSync('/usr/bin/sandbox-exec')
const HAS_UNSHARE = (() => {
  try {
    execFileSync('unshare', ['-rn', 'true'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const HAS_NETWORK_BLOCK = HAS_SANDBOX_EXEC || HAS_UNSHARE

/** A file of the repo, as text. */
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')
const value = r => (r.outcome?.t === 'done' ? JSON.parse(r.outcome.value) : undefined)
const failure = r => (r.outcome?.t === 'error' ? r.outcome.message : undefined)

const cases = {
  'the copies match the plugin': () => {
    const src = read('hooks/register.tsx')
    const block = src.match(/const LAUNCH = \[\n([\s\S]*?)\n\]\.join\('\\n'\)/)
    assert.ok(block, 'LAUNCH not found in hooks/register.tsx')
    assert.deepEqual(
      block[1].split('\n').map(l => l.trim().replace(/^'(.*)',?$/, '$1')),
      LAUNCH.split('\n'),
      'LAUNCH differs',
    )
    assert.ok(src.includes(`const NO_NETWORK = '${NO_NETWORK}'`), 'NO_NETWORK differs')
    assert.ok(
      src.includes(`const MKTEMP = ${JSON.stringify(MKTEMP).replaceAll('"', "'").replaceAll(',', ', ')}`),
      'MKTEMP differs',
    )
    assert.equal(MARK, '\u0001cm ')
    for (const file of ['runtime/runner.mjs', 'hooks/protocol.ts'])
      assert.match(read(file), /const MARK = '\\u0001cm '/, `MARK differs in ${file}`)
  },

  // The host reads only the kinds in RUNNER_FIELDS (hooks/protocol.ts) and drops any other.
  'the runner sends the kinds the host reads': () => {
    const table = read('hooks/protocol.ts').match(/const RUNNER_FIELDS = \{\n([\s\S]*?)\n\}/)
    assert.ok(table, 'RUNNER_FIELDS not found in hooks/protocol.ts')
    const known = table[1].split('\n').map(l => l.match(/^\s+(\w+):/)?.[1])
    const sent = [...read('runtime/runner.mjs').matchAll(/\bt: '(\w+)'/g)].map(m => m[1])
    assert.deepEqual([...new Set(sent)].sort(), [...known].sort())
  },

  // Claude Code skips a hooks module's classic.SessionStart, so the context is a command hook.
  'the SessionStart hook tells the model to use run_code': () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'))
    assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /hooks\/session-start\.sh/)
    const context = env => {
      const out = execFileSync('/bin/sh', [path.join(ROOT, 'hooks', 'session-start.sh')], {
        env: { PATH: process.env.PATH, ...env },
      })
      const parsed = JSON.parse(String(out))
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart')
      return parsed.hookSpecificOutput.additionalContext
    }
    const byDefault = context({})
    assert.match(byDefault, /use run_code for MCP tool calls/)
    assert.match(byDefault, /directly only when run_code fails/)
    const blocked = context({ CLAUDE_PLUGIN_OPTION_BLOCKDIRECTMCP: 'true' })
    assert.match(blocked, /call MCP tools only from run_code/)
    assert.doesNotMatch(blocked, /directly only when/)
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

  'recall reads a kept result through the same bridge': async () => {
    const r = await run(`
      const kept = await recall(4)
      const gone = await recall(5).catch(e => e.message)
      const bad = await Promise.resolve().then(() => recall("4")).catch(e => e.name)
      return [kept, gone, bad]`)
    assert.deepEqual(value(r), [{ recalled: 4 }, 'no result #5', 'TypeError'])
  },

  'sleep waits, so a program can poll': async () => {
    const r = await run(`
      const t = Date.now()
      let polls = 0
      while ((await call("mcp__s__t", { n: polls })).args.n < 2) { polls++; await sleep(100) }
      return [polls, Date.now() - t >= 200]`)
    assert.deepEqual(value(r), [2, true])
    assert.equal(r.calls, 3)
  },

  'sleep refuses a wrong argument': async () => {
    const r = await run(`
      const bad = []
      for (const ms of ["100", -1, NaN, undefined]) bad.push(await Promise.resolve().then(() => sleep(ms)).catch(e => e.name))
      return bad`)
    assert.deepEqual(value(r), Array(4).fill('TypeError'))
  },

  'sleep cannot outlast the wall-clock limit': async () =>
    assert.match(failure(await run('await sleep(Infinity)', { timeoutMs: 500 })), /timeout/),

  'saveFile and readFile go through the host': async () => {
    const r = await run(`
      const saved = await saveFile("rows.csv", [{ a: 1 }])
      const text = await readFile("ids.txt")
      const bad = []
      for (const f of [() => saveFile(1, "x"), () => saveFile("a.json", undefined), () => readFile({})]) bad.push(await Promise.resolve().then(f).catch(e => e.name))
      return [saved, text, bad]`)
    assert.deepEqual(value(r), [
      { saved: 'rows.csv', data: [{ a: 1 }] },
      'text of ids.txt',
      ['TypeError', 'TypeError', 'TypeError'],
    ])
  },

  'resources and readResource go through the host': async () => {
    const r = await run(`
      const [list, all, contents] = await Promise.all([resources("docs"), resources(), readResource("docs", "file:///a.md")])
      const bad = []
      for (const f of [() => resources(1), () => readResource("docs")]) bad.push(await Promise.resolve().then(f).catch(e => e.name))
      return [list[0].server, all[0].server, contents[0].text, bad]`)
    assert.deepEqual(value(r), ['docs', 'any', 'text of docs file:///a.md', ['TypeError', 'TypeError']])
  },

  'lib runs the saved functions it gets, and nothing else': async () => {
    const lib = {
      twice: 'async ({ n }) => { const r = await call("mcp__s__t", { n }); return r.args.n * 2 }',
      viaOther: 'async ({ n }) => (await lib.twice({ n })) + 1',
      broken: 'async () => {',
      'bad name': 'async () => 1',
    }
    const r = await run(
      `
      const missing = await Promise.resolve().then(() => lib.nope()).catch(e => e.message)
      const broken = await lib.broken().catch(e => e.name + ": " + e.message)
      try { lib.twice = 1 } catch {}
      const written = typeof lib.twice === "function" ? "refused" : "written"
      const escape = await Promise.resolve().then(() => lib.twice.constructor("return process")()).catch(e => e.name)
      return [await lib.twice({ n: 2 }), await lib.viaOther({ n: 3 }), missing, broken.startsWith("SyntaxError: lib.broken does not compile"), lib.broken.toString(), lib.twice.toString() === ${JSON.stringify(lib.twice)}, written, escape, typeof globalThis.__lib, Object.keys(lib)]`,
      { lib },
    )
    assert.deepEqual(value(r), [
      4,
      7,
      'lib.nope is not a saved function: search_tools lists them',
      true,
      'async () => {',
      true,
      'refused',
      'EvalError',
      'undefined',
      ['twice', 'viaOther', 'broken'],
    ])
  },

  'an error in a saved function shows its frame': async () => {
    const r = await run('return await lib.boom()', { lib: { boom: 'async () => {\n  null.x\n}' } })
    assert.match(failure(r), /TypeError[\s\S]*lib\/boom\.js:2/)
  },

  'failed call throws': async () =>
    assert.equal(value(await run('try { await call("mcp__s__fail") } catch (e) { return e.message }')), 'boom'),

  'no host globals': async () =>
    assert.deepEqual(
      value(await run('return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof __deliver]')),
      Array(5).fill('undefined'),
    ),

  'no escape through constructors': async () => {
    for (const code of [
      'return globalThis.constructor.constructor("return process")().pid',
      'return this.constructor.constructor("return process")().pid',
      'return call.constructor("return 1")()',
      'return recall.constructor("return 1")()',
      'return sleep.constructor("return 1")()',
      'return saveFile.constructor("return 1")()',
      'return readFile.constructor("return 1")()',
      'return resources.constructor("return 1")()',
      'try { await call("mcp__s__fail") } catch (e) { return e.constructor.constructor("return process")().pid }',
      'return (await call("mcp__s__t")).constructor.constructor("return process")().pid',
    ])
      assert.match(failure(await run(code)) ?? 'escaped', /EvalError/, code)
  },

  'wall-clock timeout': async () =>
    assert.match(failure(await run('await new Promise(() => {})', { timeoutMs: 500 })), /timeout/),

  'a call with no reply ends at the time limit, and try/catch does not hide it': async () => {
    const answer = m => (m.tool === 'mcp__s__hang' ? undefined : echo(m))
    const code = 'await call("mcp__s__a"); try { await call("mcp__s__hang") } catch { return "caught" }'
    const r = await run(code, { timeoutMs: 500, answer })
    assert.equal(failure(r), 'timeout after 500 ms')
    assert.equal(r.calls, 2)
  },

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
      {
        write: 'ERR_ACCESS_DENIED',
        read: 'ERR_ACCESS_DENIED',
        spawn: 'ERR_ACCESS_DENIED',
        worker: 'ERR_ACCESS_DENIED',
      },
    )
  },

  'the process gets no environment variables': async () => assert.deepEqual((await probe()).env, []),

  ...(HAS_SANDBOX_EXEC
    ? { 'the process has no network (sandbox-exec)': async () => assert.equal((await probe()).connect, 'EPERM') }
    : {}),

  // Where unshare cannot make the namespaces (Ubuntu 24.04 by default), the
  // launch goes on without the network block.
  'a failing unshare does not stop the program': async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-mode-path-'))
    try {
      fs.writeFileSync(path.join(dir, 'unshare'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      const r = await run('return 1 + 1', { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } })
      assert.equal(value(r), 2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  },

  'the launch finds node on PATH, also behind a version-manager shim': async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-mode-shim-'))
    try {
      // Like an asdf shim: it finds the real node only through the environment.
      fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\nexec "$REAL_NODE" "$@"\n', { mode: 0o755 })
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, REAL_NODE: process.execPath }
      assert.equal(value(await run('return 1 + 1', { node: 'node', env })), 2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  },

  'the launch says when it cannot find node': async () => {
    const r = await run('return 1', { node: 'code-mode-no-such-node' })
    assert.equal(r.exit, 127)
    assert.match(r.stderr, /code-mode-no-such-node: not found/)
  },

  ...(!HAS_SANDBOX_EXEC && HAS_UNSHARE
    ? { 'the process has no network (unshare)': async () => assert.equal((await probe()).connect, 'ENETUNREACH') }
    : {}),

  ...(process.env.EXPECT_NETWORK_BLOCK && !HAS_NETWORK_BLOCK
    ? {
        'this machine has a network block': () =>
          assert.fail('EXPECT_NETWORK_BLOCK is set, but neither sandbox-exec nor unshare -rn works here'),
      }
    : {}),
}

if (!HAS_NETWORK_BLOCK) console.log('skip  the process has no network: no sandbox-exec or unshare -rn here')

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
