# code-mode

A Claude Code plugin: the model writes one JavaScript program that calls MCP tools in a sandbox, and only the return
value goes back into the context. The whole repo is the plugin (marketplace source `./`).

## Read first, by task
- Any change to code, tests, model-facing text or docs → `CODING_STANDARDS.md`.
- The tools, their results and the permission path → `hooks/register.tsx`. Pure helpers: `hooks/protocol.ts`
  (runner protocol, results, search), `hooks/hints.ts` (hint files and matching), `hooks/functions.ts` (saved
  functions), `hooks/paths.ts` (the folders in `.claude/code-mode` and the guarded ones), `hooks/tools.ts`
  (the table of the plugin's tools: schemas, ids, typed input).
- The sandbox → `runtime/runner.mjs`, then `docs/how-it-works.mdx`.
- Hints, proposals, the band, the hint-file guard → `docs/hints.mdx`. Saved functions → `docs/functions.mdx`.
- Permission modes, allow rules, the auto mode "no verdict" error → `docs/permissions.mdx`.
- The engine API (`$`, events, `claude-code/testing`) → `.claude-plugin/types/claude-code/index.d.ts`. Claude Code
  writes it when the plugin loads from a folder. It is not in git.

## Rules
- A user or project hint file and a saved function load only when the approval ledger in `$.store` has the hash of
  their text (`docs/hints.mdx`, "Files that you write or change"). Write, Edit and NotebookEdit on these folders
  are denied. A file written another way does not load until the person approves it in the band, so never write
  one to make a test or a run work: use the bundled `hints/`, or the fakes `fakeHome` and `approvedHome` in
  `tests/fakes.ts`.
- Before every commit, do the verification loop in `CODING_STANDARDS.md`: `/simplify`, `/code-review`, the
  checks, then `/verify`.
