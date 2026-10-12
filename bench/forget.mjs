// Removes what runs against the fake server saved in ~/.claude/code-mode: the
// result shapes and argument names of the tools that `isRunTool` matches, and
// the files and metrics of the given sessions. The bench, the smoke test and
// the /verify drive script give each run its own server name, so a later run
// sees nothing of an earlier one.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = path.join(os.homedir(), '.claude', 'code-mode')

export const forgetRuns = (isRunTool, sessionIds = []) => {
  for (const file of ['shapes.json', 'args.json'].map(f => path.join(DIR, f)).filter(f => fs.existsSync(f))) {
    const learned = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, `${JSON.stringify(Object.fromEntries(Object.entries(learned).filter(([tool]) => !isRunTool(tool))), null, 2)}\n`)
  }
  for (const id of sessionIds) {
    fs.rmSync(path.join(DIR, 'files', id), { recursive: true, force: true })
    fs.rmSync(path.join(DIR, 'metrics', `${id}.jsonl`), { force: true })
  }
}
