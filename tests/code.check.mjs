// The code follows the rules in CODING_STANDARDS.md that no type and no test
// of the hooks can see.
//
// Checked here: the hooks read the time only through $.clock, so a test can
// set it with mock.clock. Only hooks/paths.ts types out a path into
// .claude/code-mode, so the loaders and the hint-file guard name the same
// folders. Only hooks/tools.ts types out the full id of a tool of this
// plugin, in the hooks and in the tests that the engine runs. Only
// hooks/hints.ts types out the `bundled:` prefix of a hint ref. The .mjs tests
// run in plain Node, which cannot import hooks/tools.ts, so they are not
// scanned: smoke.e2e.mjs fails at once when an id changes. Only
// scripts/format.sh names a Prettier version, so the hook and CI format alike.
//
//   node tests/code.check.mjs

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChecks } from './check.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const filesIn = (dir, pattern) =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter(f => pattern.test(f))
    .sort()
    .map(f => `${dir}/${f}`)
const FILES = [...filesIn('hooks', /\.tsx?$/), ...filesIn('tests', /\.ts$/)]

const inHooks = rel => rel.startsWith('hooks/')

// Each rule and the files it applies to. Date.now(), Date() and new Date()
// read the time. new Date(ms) only formats it.
const RULES = [
  {
    pattern: /\bDate\.now\b|(?<!new\s+)\bDate\s*\(|\bnew Date\s*\(\s*\)/,
    message: 'reads the time without $.clock: use await $.clock.now()',
    applies: inHooks,
  },
  {
    pattern: /code-mode\\?\/|codeModePath\(.*['"`](hints|functions)['"`]/,
    message: 'types out a path into .claude/code-mode: use a helper from hooks/paths.ts',
    applies: rel => inHooks(rel) && rel !== 'hooks/paths.ts',
  },
  {
    pattern: /mcp__code-mode__/,
    message: 'types out the id of a code-mode tool: use TOOL from hooks/tools.ts',
    applies: rel => rel !== 'hooks/tools.ts',
  },
  {
    pattern: /['"`]bundled:/,
    message: 'reads or makes a hint ref by hand: use hintRef, bundledRef or refTarget from hooks/hints.ts',
    applies: rel => inHooks(rel) && rel !== 'hooks/hints.ts',
  },
]

// The problems of one file, as "file:line: message". Comments are skipped.
const codeProblems = (rel, text) => {
  const rules = RULES.filter(r => r.applies(rel))
  return text.split('\n').flatMap((raw, i) => {
    const code = raw.replace(/\/\*.*?\*\//g, '')
    const line = /^\s*\/?\*/.test(code) ? '' : code.replace(/(^|\s)\/\/.*$/, '')
    return rules.filter(r => r.pattern.test(line)).map(r => `${rel}:${i + 1}: ${r.message}`)
  })
}

// The line numbers in `code` (1-based) that `rel` reports.
const flagged = (rel, code) => codeProblems(rel, code.join('\n')).map(p => Number(p.split(':')[1]))

const tests = {
  'the clock rule': () => {
    const code = [
      'const a = Date.now()',
      'const b = new Date()',
      'const c = Date()',
      "const e = 'https://x' + Date.now()",
      '/* now */ const f = Date.now()',
      'const d = new  Date(await $.clock.now())',
      '// Date.now()',
      ' * Date.now()',
      '/** Date.now() */',
    ]
    assert.deepEqual(flagged('hooks/x.ts', code), [1, 2, 3, 4, 5])
    assert.deepEqual(flagged('tests/x.test.ts', code), [], 'tests may read the time')
  },
  'only hooks/paths.ts types out a code-mode path': () => {
    const code = [
      'const d = `${home}/.claude/code-mode/hints`',
      '/code-mode\\/+(hints)/.test(c)',
      "codeModePath(await $.session.root(), 'hints')",
      '// ~/.claude/code-mode/metrics',
      "codeModePath(home, 'metrics')",
    ]
    assert.deepEqual(flagged('hooks/x.ts', code), [1, 2, 3])
    assert.deepEqual(flagged('hooks/paths.ts', code), [])
    assert.deepEqual(flagged('tests/x.test.ts', code), [], 'tests name the guarded folders')
  },
  'only hooks/tools.ts types out a tool id': () => {
    const code = [
      "on('tool.call', { tool: 'mcp__code-mode__run_code' })",
      'const t = `mcp__code-mode__${name}`',
      "const s = 'mcp__fake__echo'",
      '// mcp__code-mode__run_code',
    ]
    assert.deepEqual(flagged('hooks/x.ts', code), [1, 2])
    assert.deepEqual(flagged('tests/x.test.ts', code), [1, 2])
    assert.deepEqual(flagged('hooks/tools.ts', code), [])
  },
  'only hooks/hints.ts types out a bundled hint ref': () => {
    const code = [
      "if (ref.startsWith('bundled:')) {",
      'const r = `bundled:${file}`',
      "if (hint.scope === 'bundled') {",
      '// bundled:<name>',
    ]
    assert.deepEqual(flagged('hooks/x.ts', code), [1, 2])
    assert.deepEqual(flagged('hooks/hints.ts', code), [])
    assert.deepEqual(flagged('tests/x.test.ts', code), [], 'tests check the refs')
  },
  // TOOL in hooks/tools.ts types out the plugin name; Claude Code takes it from the manifest.
  'hooks/tools.ts builds the ids with the name in plugin.json': () => {
    const { name } = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8'))
    assert.ok(
      fs.readFileSync(path.join(ROOT, 'hooks/tools.ts'), 'utf8').includes(`\`mcp__${name}__\${name}\``),
      `TOOL must build mcp__${name}__<tool>`,
    )
  },
  'only scripts/format.sh names a Prettier version': () => {
    // New files too, so the check works before git add.
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(rel => rel && fs.existsSync(path.join(ROOT, rel)))
    const pinned = files.filter(rel => /prettier@\d/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')))
    assert.deepEqual(pinned, ['scripts/format.sh'], 'call Prettier through scripts/format.sh')
  },
  'the hooks and tests follow the rules': () => {
    const problems = FILES.flatMap(rel => codeProblems(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')))
    assert.deepEqual(problems, [], `${problems.join('\n')}\n\nThe rules are in CODING_STANDARDS.md.`)
  },
}

runChecks(tests)
