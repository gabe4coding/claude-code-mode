// The code follows the rules in CODING_STANDARDS.md that no type and no test
// of the hooks can see.
//
// Checked here: the hooks read the time only through $.clock, so a test can
// set it with mock.clock.
//
//   node tests/code.check.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChecks } from './check.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const HOOKS = fs.readdirSync(path.join(ROOT, 'hooks')).filter(f => /\.tsx?$/.test(f)).sort().map(f => path.join(ROOT, 'hooks', f))

// Date.now(), Date() and new Date() read the time. new Date(ms) only formats it.
const RULES = [
  [/\bDate\.now\b|(?<!new\s+)\bDate\s*\(|\bnew Date\s*\(\s*\)/, 'reads the time without $.clock: use await $.clock.now()'],
]

// The problems of one file, as "file:line: message". Comments are skipped.
const codeProblems = (rel, text) =>
  text.split('\n').flatMap((raw, i) => {
    const code = raw.replace(/\/\*.*?\*\//g, '')
    const line = /^\s*\/?\*/.test(code) ? '' : code.replace(/(^|\s)\/\/.*$/, '')
    return RULES.filter(([pattern]) => pattern.test(line)).map(([, message]) => `${rel}:${i + 1}: ${message}`)
  })

const tests = {
  'the checks catch each rule': () => {
    const code = ['const a = Date.now()', 'const b = new Date()', 'const c = Date()', 'const d = new  Date(await $.clock.now())', '// Date.now()', ' * Date.now()', '/** Date.now() */', "const e = 'https://x' + Date.now()", '/* now */ const f = Date.now()']
    const found = codeProblems('x.ts', code.join('\n')).join('\n')
    assert.ok(found.includes('x.ts:1:'), 'Date.now()')
    assert.ok(found.includes('x.ts:2:'), 'new Date()')
    assert.ok(found.includes('x.ts:3:'), 'Date()')
    assert.ok(found.includes('x.ts:8:'), 'after a URL')
    assert.ok(found.includes('x.ts:9:'), 'after a block comment')
    for (const n of [4, 5, 6, 7]) assert.ok(!found.includes(`x.ts:${n}:`), code[n - 1])
  },
  'the hooks follow the rules': () => {
    const problems = HOOKS.flatMap(f => codeProblems(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')))
    assert.deepEqual(problems, [], `${problems.join('\n')}\n\nThe rules are in CODING_STANDARDS.md.`)
  },
}

runChecks(tests)
