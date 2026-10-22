// Writes the bundled list: the SHA-256 of each bundled hint file, by file
// name. A bundled hint loads only when the list has the hash of its text
// (BUNDLED_LIST in hooks/hints.ts). Run it after each change to a bundled
// hint; tests/docs.check.mjs fails when the list is out of date.
//
//   node scripts/bundled-hints.mjs          write the list
//   node scripts/bundled-hints.mjs --check  exit 1 when the list is out of date

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIR = path.join(ROOT, 'hints')
const LIST = path.join(DIR, 'sha256.json')

/** The text the list must have now. */
export const bundledListText = () => {
  const hashes = Object.fromEntries(
    fs
      .readdirSync(DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
      .map(f => [
        f,
        createHash('sha256')
          .update(fs.readFileSync(path.join(DIR, f), 'utf8'))
          .digest('hex'),
      ]),
  )
  return `${JSON.stringify(hashes, null, 2)}\n`
}

/** The text of the list on disk, or '' when there is none. */
export const bundledListOnDisk = () => (fs.existsSync(LIST) ? fs.readFileSync(LIST, 'utf8') : '')

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    if (bundledListText() !== bundledListOnDisk()) {
      console.error('hints/sha256.json is out of date: run node scripts/bundled-hints.mjs')
      process.exit(1)
    }
  } else {
    fs.writeFileSync(LIST, bundledListText())
    console.log(`wrote ${path.relative(ROOT, LIST)}`)
  }
}
