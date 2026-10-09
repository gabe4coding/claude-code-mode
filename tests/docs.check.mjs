// The user docs (README.md and docs/*.mdx) follow the rules in
// CODING_STANDARDS.md, section "Docs".
//
// Checked here: front matter and H1, GitHub-safe MDX, the mechanical
// ASD-STE100 rules, and relative links and heading anchors (also the links
// from the files that point into the docs). Not checked: facts and word choice.
//
//   node tests/docs.check.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const docsIn = dir => fs.readdirSync(path.join(dir, 'docs')).filter(f => f.endsWith('.mdx')).sort().map(f => path.join(dir, 'docs', f))
const USER_DOCS = [path.join(ROOT, 'README.md'), ...docsIn(ROOT)]
// Not written to the STE rules, but their links into the docs must keep working.
const LINK_ONLY = ['AGENTS.md', 'CODING_STANDARDS.md'].map(f => path.join(ROOT, f))

const MAX_WORDS = 25
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/
const FENCE = /^\s*(```|~~~)/
const STE_RULES = [
  [/\b\w+n't\b|\b(it's|you're|we're|they're|that's|there's|let's)\b/i, 'contraction: write the full form ("do not")'],
  [/\b(should|may|might|would|could)\b/i, 'modal verb: use "can", "must" or an imperative'],
  [/\b(please|simply|just|easily|obviously|basically)\b/i, 'filler word'],
  [/;/, 'semicolon: write two sentences'],
  [/\b(e\.g\.|i\.e\.|etc\.)/, 'Latin abbreviation: write "for example" or "that is"'],
]

// [line number, text] of each prose line: no front matter, code blocks,
// tables, headings or HTML. Inline code becomes X and a link keeps only its
// text, so neither counts against the rules.
const proseLines = text => {
  const m = text.match(FRONT_MATTER)
  const offset = m ? m[0].split('\n').length - 1 : 0
  const body = m ? text.slice(m[0].length) : text
  const lines = []
  let fenced = false
  body.split('\n').forEach((raw, i) => {
    if (FENCE.test(raw)) {
      fenced = !fenced
      return
    }
    if (fenced || /^\s*(\||<|#)/.test(raw)) return
    const line = raw.replace(/`[^`]*`/g, 'X').replace(/\]\([^)]*\)/g, ']').replaceAll('**', '')
    lines.push([offset + i + 1, line])
  })
  return lines
}

// A sentence ends at . ! ? or : before a space, at a blank line or a list item.
const sentences = text =>
  proseLines(text)
    .map(([, line]) => line)
    .join('\n')
    .split(/(?<=[.!?:])\s+|\n\s*\n|\n\s*[-*]\s|\n\s*\d+\.\s/)

// The anchor GitHub gives a heading.
export const slug = heading =>
  heading
    .replaceAll('`', '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replaceAll(' ', '-')

const anchors = file => {
  const found = new Set()
  const seen = new Map()
  let fenced = false
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (FENCE.test(line)) fenced = !fenced
    const heading = !fenced && line.match(/^#{1,6}\s+(.*)$/)
    if (!heading) continue
    const base = slug(heading[1].trim())
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    found.add(count === 0 ? base : `${base}-${count}`)
  }
  return found
}

export const docProblems = (file, root = ROOT) => {
  const text = fs.readFileSync(file, 'utf8')
  const rel = path.relative(root, file)
  const problems = []
  if (file.endsWith('.mdx')) {
    const m = text.match(FRONT_MATTER)
    const meta = Object.fromEntries([...(m?.[1] ?? '').matchAll(/^(\w+):\s*(.+)$/gm)].map(x => [x[1], x[2]]))
    if (!meta.title || !meta.description) problems.push(`${rel}:1: the front matter needs a title and a description`)
    const h1 = (m ? text.slice(m[0].length) : text).match(/^# (.+)$/m)
    if (meta.title && (!h1 || h1[1] !== meta.title)) problems.push(`${rel}: the H1 must be the front matter title "${meta.title}"`)
  }

  let fenced = false
  text.split('\n').forEach((raw, i) => {
    if (FENCE.test(raw)) fenced = !fenced
    if (fenced) return
    const line = raw.replace(/`[^`]*`/g, '')
    const at = `${rel}:${i + 1}`
    if (/\{\/\*|<!--/.test(line)) problems.push(`${at}: a comment that GitHub shows as text`)
    if (/^(import|export)\s/.test(line)) problems.push(`${at}: import/export is not GitHub-safe`)
    if (/<[A-Z][A-Za-z]*[\s/>]/.test(line)) problems.push(`${at}: a JSX component is not GitHub-safe`)
    if (/<https?:/.test(line)) problems.push(`${at}: an autolink: write [text](url)`)
  })

  for (const [n, line] of proseLines(text)) {
    for (const [pattern, message] of STE_RULES) if (pattern.test(line)) problems.push(`${rel}:${n}: ${message}`)
  }
  for (const sentence of sentences(text)) {
    const words = sentence.split(/\s+/).filter(w => w !== '').length
    if (words > MAX_WORDS) problems.push(`${rel}: a sentence of ${words} words (max ${MAX_WORDS}): "${sentence.trim().slice(0, 70)}…"`)
  }
  return problems
}

const linkProblems = file => {
  const text = fs
    .readFileSync(file, 'utf8')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
  const rel = path.relative(ROOT, file)
  const problems = []
  for (const m of text.matchAll(/\]\(([^)\s]+)\)|(?:src|href)="([^"]+)"/g)) {
    const link = m[1] ?? m[2]
    if (/^[a-z]+:/.test(link)) continue
    const [targetPath, anchor] = link.split('#')
    const target = targetPath ? path.resolve(path.dirname(file), targetPath) : file
    if (!fs.existsSync(target)) problems.push(`${rel}: a link to a missing file: ${link}`)
    else if (anchor && /\.mdx?$/.test(target) && !anchors(target).has(anchor)) problems.push(`${rel}: a link to a missing heading: ${link}`)
  }
  return problems
}

const tests = {
  'slug matches GitHub': () => {
    assert.equal(slug('Every call fails in auto mode'), 'every-call-fails-in-auto-mode')
    assert.equal(slug('`run_code` and [hints](x.mdx)'), 'run_code-and-hints')
    assert.equal(slug('Speed, and results!'), 'speed-and-results')
  },
  'the checks catch each rule': () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-mode-docs-'))
    const doc = path.join(dir, 'x.mdx')
    const long = `${Array(26).fill('word').join(' ')}.`
    fs.writeFileSync(doc, `---\ntitle: X\ndescription: Y\n---\n\n# Z\n\nIt's here; you should just look, e.g. now.\n\n${long}\n\n\`code; should\` is fine.\n`)
    const found = docProblems(doc, dir).join('\n')
    for (const message of ['H1 must be', 'contraction', 'modal verb', 'filler word', 'semicolon', 'Latin', '26 words']) {
      assert.ok(found.includes(message), message)
    }
    assert.ok(!found.includes(':12:'))
  },
  'user docs follow the rules': () => {
    const problems = USER_DOCS.flatMap(f => docProblems(f))
    assert.deepEqual(problems, [], `${problems.join('\n')}\n\nThe rules are in CODING_STANDARDS.md, section "Docs".`)
  },
  'links and anchors resolve': () => {
    const problems = [...USER_DOCS, ...LINK_ONLY].flatMap(linkProblems)
    assert.deepEqual(problems, [], problems.join('\n'))
  },
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn()
    console.log(`pass  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n${err.message}`)
  }
}
console.log(failed === 0 ? 'all passed' : `${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
