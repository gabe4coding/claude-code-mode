// Sandbox runner for code-mode. Runs one script the model wrote.
//
// argv:   runner.mjs <exchange dir>
// stdin:  {"code": "...", "timeoutMs": 60000, "lib": {"<name>": "<async function expression>"}}
// stdout: one line per message, each "\u0001cm " + JSON:
//           {"t":"call","id":1,"tool":"mcp__x__y","args":{...}}
//           {"t":"recall","id":2,"ref":4}
//           {"t":"save","id":3,"name":"issues.csv","data":<json>}
//           {"t":"read","id":4,"path":"ids.txt"}
//           {"t":"resources","id":5,"server":"docs"}
//           {"t":"resource","id":6,"server":"docs","uri":"file:///a.md"}
//           {"t":"done","value":"<json>","logs":[...]}
//           {"t":"error","message":"...","logs":[...]}
// The host answers each message with an <id> by writing <exchange dir>/r<id>.json:
//           {"ok":true,"value":...} or {"ok":false,"error":"..."}
// sleep(ms) never reaches the host: this process answers it with its own timer.
//
// The script runs in a vm context with no require, process, fetch or timers.
// Only strings cross between host and context, so no host object (and no host
// Function constructor) is reachable from the script. The host process is
// also started with --permission (read-only access to this file and the
// exchange dir) and, on macOS, under sandbox-exec with no network.

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const MARK = '\u0001cm '
const POLL_MS = 5
const xdir = process.argv[2]
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
const timeoutMs = Number(input.timeoutMs) || 60_000

const emit = msg => process.stdout.write(MARK + JSON.stringify(msg) + '\n')

let finished = false
const finish = msg => {
  if (finished) return
  finished = true
  emit(msg)
  process.exit(0)
}

// Host side of the bridge: the context calls post(kind, a, b, c) with strings.
// `deliver` is the context's answer function, set after the bootstrap runs.
const waiting = new Set()
let deliver
const post = (kind, a, b, c) => {
  try {
    if (kind === 'call') {
      const id = Number(a)
      emit({ t: 'call', id, tool: String(b), args: JSON.parse(String(c)) })
      waiting.add(id)
    } else if (kind === 'recall') {
      const id = Number(a)
      emit({ t: 'recall', id, ref: Number(b) })
      waiting.add(id)
    } else if (kind === 'save') {
      const id = Number(a)
      emit({ t: 'save', id, name: String(b), data: JSON.parse(String(c)) })
      waiting.add(id)
    } else if (kind === 'read') {
      const id = Number(a)
      emit({ t: 'read', id, path: String(b) })
      waiting.add(id)
    } else if (kind === 'resources') {
      const id = Number(a)
      emit({ t: 'resources', id, ...(b === '' ? {} : { server: String(b) }) })
      waiting.add(id)
    } else if (kind === 'resource') {
      const id = Number(a)
      emit({ t: 'resource', id, server: String(b), uri: String(c) })
      waiting.add(id)
    } else if (kind === 'sleep') {
      // No longer than the run can last: the wall-clock timer ends it first.
      const id = Number(a)
      setTimeout(() => deliver(id, '{"ok":true,"value":null}'), Math.min(Number(b), timeoutMs))
    } else if (kind === 'done') {
      finish({ t: 'done', value: String(a), logs: JSON.parse(String(b)) })
    } else if (kind === 'error') {
      finish({ t: 'error', message: String(a), logs: JSON.parse(String(b)) })
    }
  } catch (err) {
    finish({ t: 'error', message: `bridge: ${err?.message ?? err}`, logs: [] })
  }
  return undefined
}

// A null-prototype sandbox: with a plain object, globalThis.constructor would
// be the host's Object, and its constructor the host's Function.
const sandbox = Object.create(null)
sandbox.__post = post
const context = vm.createContext(sandbox, {
  codeGeneration: { strings: false, wasm: false },
})

// Context side of the bridge, compiled inside the context so every object
// the script can reach (promises, errors, functions) is the context's own.
const BOOTSTRAP = String.raw`
(() => {
  const post = globalThis.__post
  delete globalThis.__post
  const waiting = new Map()
  let nextId = 0
  const logs = []
  const fmt = v => {
    if (typeof v === 'string') return v
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  const log = (...a) => { logs.push(a.map(fmt).join(' ')) }
  globalThis.console = { log, info: log, warn: log, error: log, debug: log }

  const call = (tool, args) => new Promise((resolve, reject) => {
    if (typeof tool !== 'string') throw new TypeError('call(tool, args): tool must be a string')
    const id = ++nextId
    waiting.set(id, { resolve, reject })
    post('call', String(id), tool, JSON.stringify(args ?? {}))
  })
  // tools.<server>.<tool>(args) is call("mcp__<server>__<tool>", args)
  const tools = new Proxy({}, {
    get: (_, server) => typeof server !== 'string' ? undefined : new Proxy({}, {
      get: (_, tool) => typeof tool !== 'string' ? undefined
        : args => call('mcp__' + server + '__' + tool, args),
    }),
  })
  // recall(n): the result of call #n from this session again, with no new call
  const recall = ref => new Promise((resolve, reject) => {
    if (!Number.isInteger(ref)) throw new TypeError('recall(n): n must be the number of a result')
    const id = ++nextId
    waiting.set(id, { resolve, reject })
    post('recall', String(id), String(ref))
  })
  // sleep(ms): waits, for programs that poll; no timers reach the context
  const sleep = ms => new Promise((resolve, reject) => {
    if (typeof ms !== 'number' || !(ms >= 0)) throw new TypeError('sleep(ms): ms must be a number of milliseconds, 0 or more')
    const id = ++nextId
    waiting.set(id, { resolve, reject })
    post('sleep', String(id), String(ms))
  })
  // saveFile(name, data) and readFile(path): the host writes and reads the
  // files; this process has no file system access of its own
  const ask = (kind, a, b) => new Promise((resolve, reject) => {
    const id = ++nextId
    waiting.set(id, { resolve, reject })
    post(kind, String(id), a, b)
  })
  const saveFile = (name, data) => {
    if (typeof name !== 'string') throw new TypeError('saveFile(name, data): name must be a string')
    const json = JSON.stringify(data)
    if (json === undefined) throw new TypeError('saveFile(name, data): data must be text or JSON')
    return ask('save', name, json)
  }
  const readFile = path => {
    if (typeof path !== 'string') throw new TypeError('readFile(path): path must be a string')
    return ask('read', path)
  }
  // resources(server?) and readResource(server, uri): the MCP resources
  const resources = server => {
    if (server !== undefined && typeof server !== 'string') throw new TypeError('resources(server): server must be a string')
    return ask('resources', server ?? '')
  }
  const readResource = (server, uri) => {
    if (typeof server !== 'string' || typeof uri !== 'string') throw new TypeError('readResource(server, uri): server and uri must be strings')
    return ask('resource', server, uri)
  }
  // lib.<name>(args): the saved functions the host loads below. A name that
  // is not there throws at once, with the place to look.
  const saved = Object.create(null)
  const lib = new Proxy(saved, {
    get: (target, name) => {
      if (typeof name !== 'string' || name === 'then' || name === 'toJSON' || name in target) return target[name]
      throw new TypeError('lib.' + name + ' is not a saved function: search_tools lists them')
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  })
  globalThis.__lib = saved
  globalThis.call = call
  globalThis.recall = recall
  globalThis.sleep = sleep
  globalThis.saveFile = saveFile
  globalThis.readFile = readFile
  globalThis.resources = resources
  globalThis.readResource = readResource
  globalThis.lib = lib
  globalThis.tools = tools

  globalThis.__deliver = (id, text) => {
    const w = waiting.get(id)
    if (!w) return
    waiting.delete(id)
    const r = JSON.parse(text)
    if (r.ok) w.resolve(r.value)
    else w.reject(new Error(r.error))
  }

  // The error and the script's own frames, not the bridge's.
  const describe = e => {
    if (!(e instanceof Error)) return String(e)
    const frames = String(e.stack || '').split('\n').filter(l => l.includes('code.js') || l.includes('lib/'))
    return [e.name + ': ' + e.message, ...frames].join('\n')
  }

  globalThis.__start = main => {
    Promise.resolve().then(main).then(
      v => {
        let out
        try { out = v === undefined ? 'null' : JSON.stringify(v) } catch (e) { out = JSON.stringify(String(v)) }
        post('done', out ?? 'null', JSON.stringify(logs))
      },
      e => post('error', describe(e), JSON.stringify(logs)),
    )
  }
})()
`

const runSync = (src, filename) => new vm.Script(src, { filename }).runInContext(context, { timeout: timeoutMs })

try {
  runSync(BOOTSTRAP, 'code-mode-bootstrap.js')
  // Keep the bootstrap's helpers away from the script.
  deliver = runSync('globalThis.__deliver', 'x.js')
  const start = runSync('globalThis.__start', 'x.js')
  runSync('delete globalThis.__deliver; delete globalThis.__start', 'x.js')

  // The saved functions, each compiled in the context as its own file. One
  // that does not compile throws its error when the program calls it, and its
  // toString still gives its code, so the model can read the code to fix it.
  for (const [name, src] of Object.entries(input.lib ?? {})) {
    if (!/^[A-Za-z_$][\w$]{0,39}$/.test(name)) continue
    const key = JSON.stringify(name)
    try {
      runSync(`globalThis.__lib[${key}] = (${src}\n)`, `lib/${name}.js`)
    } catch (err) {
      const message = JSON.stringify(`lib.${name} does not compile: ${err?.message ?? err}`)
      const code = JSON.stringify(String(src))
      runSync(
        `globalThis.__lib[${key}] = Object.defineProperty(async () => { throw new SyntaxError(${message}) }, 'toString', { value: () => ${code} })`,
        'x.js',
      )
    }
  }
  runSync('delete globalThis.__lib', 'x.js')

  const main = runSync(`(async () => {\n${input.code}\n})`, 'code.js')
  start(main)

  // Answer delivery: poll the exchange dir for the host's result files.
  const timer = setInterval(() => {
    for (const id of waiting) {
      const file = path.join(xdir, `r${id}.json`)
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      try {
        JSON.parse(text)
      } catch {
        continue
      } // still being written
      waiting.delete(id)
      deliver(id, text)
    }
    if (finished) clearInterval(timer)
  }, POLL_MS)

  setTimeout(() => finish({ t: 'error', message: `timeout after ${timeoutMs} ms`, logs: [] }), timeoutMs)
} catch (err) {
  finish({ t: 'error', message: String(err?.stack ?? err), logs: [] })
}
