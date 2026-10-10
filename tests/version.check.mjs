// Checks the version rule: a change to the plugin needs a higher version in
// .claude-plugin/plugin.json. Claude Code caches a plugin per version, so
// without one, users do not get the change. Compares with where the branch
// left the base, uncommitted changes included.
//
//   node tests/version.check.mjs [base ref, default origin/main]

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MANIFEST = '.claude-plugin/plugin.json'
const PLUGIN_PATHS = ['hooks/', 'runtime/', 'hints/', MANIFEST]

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const parts = version => version.split('.').map(Number)
const isHigher = (a, b) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

const base = git('merge-base', process.argv[2] ?? 'origin/main', 'HEAD')
const changed = git('diff', '--name-only', base).split('\n').filter(f => PLUGIN_PATHS.some(p => f === p || f.startsWith(p)))
const before = JSON.parse(git('show', `${base}:${MANIFEST}`)).version
const now = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST), 'utf8')).version

if (changed.length === 0) {
  console.log('pass  no plugin files changed')
} else if (isHigher(now, before)) {
  console.log(`pass  version ${before} -> ${now} for ${changed.length} changed plugin files`)
} else {
  console.log(`FAIL  ${changed.join(', ')} changed, but the version is still ${now}. Increase version in ${MANIFEST}.`)
  process.exit(1)
}
