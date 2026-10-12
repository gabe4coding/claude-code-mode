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
- The plugin guards the hint folders in `~/.claude` and in the project, and the function folder in `~/.claude`:
  Write, Edit, and Bash commands that name them are denied. To change code or tests that name these folders, use
  the Edit tool: the guard checks its file path, while a Bash command that names a folder is denied. To test a hint, use the bundled `hints/` or the fake host in `tests/hints.test.ts`.
- Before every commit, do the verification loop in `CODING_STANDARDS.md`: `/simplify`, `/code-review`, the
  checks, then `/verify`.
