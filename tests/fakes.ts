// Fakes that more than one test file uses: HOME, a fake file system and
// session beneath the plugin, and the text of a tool result.

import type { On } from 'claude-code'
import { approvalKey, isApprovalKey } from '../hooks/hints'

export const HOME = '/home/test'
/** The folder that mktemp gives. */
export const TMP = '/tmp/cm-test'

export type FakeHomeOptions = {
  /** Called after each write the plugin makes. */
  onWrite?: (path: string, text: string) => void
  /** Awaited before each write the plugin makes: a test can run other work in the gap. */
  beforeWrite?: (path: string) => Promise<void>

  /** The id that session.id gives. Default: no session.id hook. */
  sessionId?: string
  /** The MCP tools that tool.list gives. Default: the tools of `serverOf`. */
  tools?: { name: string; description: string }[]
}

// `files` maps absolute paths to text; `written` records each write the
// plugin makes. `serverOf` maps an MCP tool to its /mcp server name. `env`
// sets a variable; any other variable reads as HOME.
export const fakeHome = (
  on: On,
  files: Record<string, string>,
  serverOf: Record<string, string> = {},
  options: FakeHomeOptions = {},
) => {
  const written: Record<string, string> = {}
  const removed: string[] = []
  const checked: string[] = []
  const env: Record<string, string> = {}
  const all = () => ({ ...files, ...written })
  on('env.get', ($, e) => ({ value: env[e.name] ?? HOME }))
  if (options.sessionId !== undefined) on('session.id', () => ({ value: options.sessionId! }))
  on(
    'fs.exists',
    ($, e) => (
      checked.push(e.path),
      { value: Object.keys(all()).some(p => p === e.path || p.startsWith(`${e.path}/`)) }
    ),
  )
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const names = new Set<string>()
    const dirs = new Set<string>()
    for (const p of Object.keys(all())) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      if (rest.includes('/')) dirs.add(rest.split('/')[0]!)
      else names.add(rest)
    }
    const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
    return { value: [...[...names].map(n => entry(n, 'file')), ...[...dirs].map(n => entry(n, 'dir'))] }
  })
  on('fs.read', ($, e) => {
    const text = all()[e.path]
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', async ($, e) => {
    await options.beforeWrite?.(e.path)
    written[e.path] = e.text
    options.onWrite?.(e.path, e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: {
      context: {
        breakdown: {
          mcpTools: Object.entries(serverOf).map(([name, serverName]) => ({
            name,
            serverName,
            tokens: 0,
            isLoaded: true,
          })),
        },
      },
    } as never,
  }))
  const tools = options.tools ?? Object.keys(serverOf).map(name => ({ name, description: `Tool ${name}` }))
  on('tool.list', () => ({ value: tools.map(t => ({ ...t, mcp: true })) }))
  // rm removes a file; mktemp gives TMP.
  on('process.run', ($, e) => {
    if (e.argv[0] === 'rm') {
      const path = String(e.argv.at(-1))
      removed.push(path)
      delete files[path]
      delete written[path]
    }
    return {
      value: {
        exitCode: 0,
        stdout: e.argv[0] === 'mktemp' ? `${TMP}\n` : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  return { written, removed, checked, env }
}

/** SHA-256 of a text as hex, from the platform's digest: the expected value does not come from the plugin. */
export const sha256 = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

/**
 * $.store in memory, like mock.store, but the test can read what the plugin
 * set. `refuseSet` gives the reason a set of that key fails, or undefined.
 */
export const fakeStore = (
  on: On,
  entries: Record<string, unknown> = {},
  refuseSet: (key: string) => string | undefined = () => undefined,
): Map<string, unknown> => {
  const store = new Map(Object.entries(entries))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    const reason = refuseSet(e.key)
    if (reason !== undefined) return { deny: reason }
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  return store
}

/** Ledger entries that approve each file at its text now, for fakeStore. */
export const ledger = async (files: Record<string, string>): Promise<Record<string, unknown>> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([path, text]) => [
        approvalKey(await sha256(path)),
        { path, sha256: await sha256(text) },
      ]),
    ),
  )

/** fakeHome with a store whose ledger approves each file in `files` at its text now. */
export const approvedHome = async (
  on: On,
  files: Record<string, string>,
  serverOf: Record<string, string> = {},
  options: FakeHomeOptions = {},
) => ({ store: fakeStore(on, await ledger(files)), ...fakeHome(on, files, serverOf, options) })

/** The approval ledger in a fake store: file path -> SHA-256 of the text an Approve wrote. */
export const approvals = (store: Map<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    [...store]
      .filter(([k]) => isApprovalKey(k))
      .map(([, v]) => [(v as { path: string }).path, (v as { sha256: string }).sha256]),
  )

/** The text of a tool result, or "DENY <reason>". */
export const textOf = (r: { result?: unknown; deny?: string; text?: string }): string =>
  r.deny !== undefined
    ? `DENY ${r.deny}`
    : typeof r.result === 'string'
      ? r.result
      : (r.text ?? JSON.stringify(r.result))
