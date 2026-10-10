// Compares run_code runs with output projection on and off, from the metrics
// files that the option `metrics` writes (one JSON line per run).
//
//   node scripts/projection-report.mjs                      all sessions
//   node scripts/projection-report.mjs --since 2026-10-10   runs from that day on
//   node scripts/projection-report.mjs --dir /other/metrics
//
// A repeat is a call equal to an earlier call that worked in the same session
// (same tool, same arguments). A filter that is too aggressive makes the model
// repeat calls; with projection on, it can use recall(n) instead.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const arg = name => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const dir = arg('--dir') ?? path.join(os.homedir(), '.claude', 'code-mode', 'metrics')
const since = arg('--since')

if (!fs.existsSync(dir)) {
  console.log(`no metrics in ${dir}: set the code-mode option "metrics" to true`)
  process.exit(0)
}

const runs = []
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
  const session = file.replace(/\.jsonl$/, '')
  for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const run = JSON.parse(line)
      if (since === undefined || run.ts >= since) runs.push({ ...run, session })
    } catch {
      // a line cut by a crash: skip it
    }
  }
}

const sum = (xs, f) => xs.reduce((n, x) => n + (Number(f(x)) || 0), 0)
const pct = (n, d) => (d === 0 ? '-' : `${((100 * n) / d).toFixed(1)}%`)
const median = xs => {
  if (xs.length === 0) return '-'
  const s = [...xs].sort((a, b) => a - b)
  return String(s[Math.floor(s.length / 2)])
}

const report = arm => {
  const rs = runs.filter(r => r.projection === arm)
  const calls = sum(rs, r => r.calls)
  return {
    sessions: new Set(rs.map(r => r.session)).size,
    runs: rs.length,
    calls,
    'repeats per 100 calls': calls === 0 ? '-' : ((100 * sum(rs, r => r.repeats)) / calls).toFixed(1),
    'runs with a repeat': pct(rs.filter(r => r.repeats > 0).length, rs.length),
    'recalls per run': rs.length === 0 ? '-' : (sum(rs, r => r.recalls) / rs.length).toFixed(2),
    'recalls of a lost result': sum(rs, r => r.recallMisses),
    'runs that failed': pct(rs.filter(r => !r.ok).length, rs.length),
    'runs with a cut result': pct(rs.filter(r => r.cut).length, rs.length),
    'runs with an empty result': pct(rs.filter(r => r.empty).length, rs.length),
    'median characters out': median(rs.map(r => r.outChars)),
    'characters in per character out': sum(rs, r => r.outChars) === 0 ? '-' : (sum(rs, r => r.inChars) / sum(rs, r => r.outChars)).toFixed(1),
  }
}

const off = report(false)
const on = report(true)
const width = Math.max(...Object.keys(off).map(k => k.length))
console.log(`${''.padEnd(width)}  ${'off'.padStart(10)}  ${'on'.padStart(10)}`)
for (const key of Object.keys(off)) console.log(`${key.padEnd(width)}  ${String(off[key]).padStart(10)}  ${String(on[key]).padStart(10)}`)
