# code-mode

A Claude Code plugin: the model writes one JavaScript program that calls MCP tools in a sandbox, and only the return
value goes back into the context. The whole repo is the plugin (marketplace source `./`).

## Read first, by task
- Any change to code, tests, model-facing text or docs → `CODING_STANDARDS.md`.
- The tools, their results and the permission path → `hooks/register.tsx`. Pure helpers: `hooks/protocol.ts`
  (runner protocol, results, search), `hooks/hints.ts` (hint files and matching).
- The sandbox → `runtime/runner.mjs`, then `docs/how-it-works.mdx`.
- Hints, proposals, the band, the hint-file guard → `docs/hints.mdx`.
- Permission modes, allow rules, the auto mode "no verdict" error → `docs/permissions.mdx`.
- The engine API (`$`, events, `claude-code/testing`) → `.claude-plugin/types/claude-code/index.d.ts`. Claude Code
  writes it when the plugin loads from a folder. It is not in git.

## Rules
- The plugin guards the hint folders in `~/.claude` and in the project: Write, Edit, and Bash commands that name
  them are denied. To test a hint, use the bundled `hints/` or the fake host in `tests/hints.test.ts`.
- Run the three checks in `CODING_STANDARDS.md` before every commit.
