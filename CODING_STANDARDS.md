# Coding standards

Rules for changing code, tests, model-facing text and docs in this repo. `[test: x]` marks a rule that a test
enforces; the others rely on discipline.

## Code
- Prettier formats code, JSON and YAML, not Markdown or MDX. Run it only through `scripts/format.sh`: the script
  holds the pinned version. Setup of the pre-commit hook: `docs/development.mdx`, Format.
  `[test: code.check.mjs]`
- `hooks/` is the hooks module that Claude Code loads (`hooks/hooks.json`). Pure helpers go in `hooks/protocol.ts`,
  `hooks/hints.ts`, `hooks/functions.ts`, `hooks/paths.ts` and `hooks/tools.ts`, with no `$`, so tests call them directly. Anything that uses `$` goes in
  `hooks/register.tsx`, in a function declared at the top of the file: the engine's loader follows `$` only there,
  never across an import, and a module that passes `$` to another file does not load.
  `[test: tsconfig.pure.json fails when a pure helper imports claude-code, register.tsx or a Node module]`
- Context for the model at session start goes in `hooks/session-start.sh`, a command hook in `hooks/hooks.json`.
  Claude Code's built-in security module skips a hooks module's `classic.SessionStart`, so a module handler never
  runs. A set option reaches the script as `CLAUDE_PLUGIN_OPTION_<KEY>`.
- Read the time with `await $.clock.now()`, never `Date.now()` or `new Date()`: a test sets the time with
  `mock.clock`. `[test: code.check.mjs]`
- Make each path into `.claude/code-mode` with a helper from `hooks/paths.ts`: `hintsFolder`, `functionsFolder` or
  `codeModePath`. The guard reads `guardedDirs` there, so the guard and the loaders name the same folders.
  `[test: code.check.mjs]` `[test: hints.test.ts guards each folder of guardedDirs]`
- Make a hint ref with `hintRef` or `bundledRef`, and read one with `refTarget` (all in `hooks/hints.ts`). Make the
  key of a hidden or removed hint with `hiddenKey`. The types `HintRef` and `HiddenKey` refuse a plain string: the
  full type check finds it in `register.tsx`, and `tsconfig.pure.json` in the pure helpers.
  `[test: code.check.mjs fails when a hook outside hints.ts types out the bundled: prefix]`
- Add or change a tool of this plugin in `TOOLS` in `hooks/tools.ts`: the registration, the full ids (`TOOL`) and the
  typed input (`parseInput`) come from there. In the hooks and the `.ts` tests, write `TOOL.run_code`, never the full
  id `mcp__code-mode__run_code`. `[test: code.check.mjs]`
- A hook's `.catch` writes `next.error` to the debug log (`debugLog`) before it answers. A deny that says "see the
  debug log" must have a line there. A `tool.call` hook ends with `.catch(failClosed)`: it denies the call when the
  hook fails. The engine takes only a function literal or a function name there, not a call that makes one. The
  one exception is the `blockDirectMcp` hook: it applies to every tool, so it fails open.
- `runtime/runner.mjs` runs inside the sandbox: Node built-ins only, no dependencies. It needs Node 22.13+, because
  `LAUNCH` passes `--permission` (stable from 22.13; Node 20 knew only `--experimental-permission`).
  `[test: runner.integration.mjs loads the runner with Node alone, so an import of a package fails]`
- `LAUNCH`, `NO_NETWORK` and `MKTEMP` exist twice: in `hooks/register.tsx` and in `tests/runner.integration.mjs`. `MARK`
  exists in `runtime/runner.mjs`, `hooks/protocol.ts` and the same test. Change all copies.
  `[test: runner.integration.mjs fails when a copy differs]`
- To add a kind of message that the runner sends, add it to `RunnerMessage` and `RUNNER_FIELDS` in
  `hooks/protocol.ts`, and give it a case in the message loop of `run_code`. The host drops a message of a kind
  that is not in `RUNNER_FIELDS`. `[test: runner.integration.mjs fails when the runner sends a kind that is not in RUNNER_FIELDS]`
- Never weaken a sandbox layer, the guard of hint and function files or the approval of proposals to make a test
  pass. Each one is a
  safety rule (see `docs/hints.mdx` and `docs/how-it-works.mdx`).
- Make changes to the approval logic (`approval`, `$.mcp.call` path) in manual mode: the auto mode classifier can
  refuse them, because they change what auto mode approves.

## Tests and commits
- Before every commit, do the verification loop in this order. If a step changes code, start again at step 1.
  1. `/simplify`: the built-in Claude Code skill. It cleans up the diff and applies the fixes. Run it first, so
     the checks test its edits too.
  2. `/code-review`: the built-in Claude Code skill. It reviews the diff for correctness bugs, which `/simplify`
     does not look for. Check each finding against the code, and fix the real ones.
  3. The checks below. After a change to `hooks/` or `tests/`, also run the type check.
  4. `/verify`: the built-in Claude Code skill. It drives the change end to end and observes the behavior. Run it
     after a change to `hooks/`, `runtime/` or `hints/`. Skip it when the diff touches only tests or docs: there is
     nothing to drive. It reads the project recipe in `.claude/skills/verify/` (`SKILL.md` and `drive.mjs`): real
     Claude Code with the plugin and the bench's fake server. If the recipe fails or misses a step, fix it.
- The checks. `[test: CI runs each one]`
  - `claude plugin test .`: the hooks against a fake host (`tests/*.test.ts`; the shared fakes are in `tests/fakes.ts`). The test kit has no processes.
  - `node tests/runner.integration.mjs`: the real sandbox under Node.
  - `node tests/docs.check.mjs`: the doc rules below.
  - `node tests/code.check.mjs`: the code rules marked `[test: code.check.mjs]`.
  - `npx -p typescript tsc -p tsconfig.pure.json`: the types of the pure helpers, with no Claude Code types.
  - `sh scripts/format.sh --check .`: the format of code, JSON and YAML.
- `node tests/smoke.e2e.mjs`: real `claude -p` with the plugin and the bench's fake server. It needs a login and
  costs API usage, so it is not one of the checks and CI does not run it. Run it after a change to `hooks/` or
  `runtime/`, before a release, and after you raise the pinned Claude Code version. Its checks read the transcript,
  the fake server's calls and the plugin's files, never the words of the model.
- CI (`.github/workflows/test.yml`) runs the sandbox test on Linux and on macOS, each with its network block
  (`unshare -rn` on Linux, `sandbox-exec` on macOS). `EXPECT_NETWORK_BLOCK` makes the test fail where neither works. CI pins the Claude Code version for `claude plugin test .`, and
  a weekly job runs the tests with the newest release.
- The full type check (`docs/development.mdx`) does not run in CI: its types come from a logged-in Claude Code session.
  Run it in step 3 of the loop. If `.claude-plugin/types/` is missing, start `claude --plugin-dir .` one time in
  this worktree (see `docs/troubleshooting.mdx`, Limits).
- Never put real MCP data, company names, ticket keys, user ids or tokens in tests, hints or docs: this repo is
  public. Use `fake`, `example.atlassian.net` and similar.

## Plugin
- When anything under `hooks/`, `runtime/`, `hints/` or `.claude-plugin/plugin.json` changes, bump `version` in
  `.claude-plugin/plugin.json`: Claude Code caches a plugin per version.
  `[test: CI runs tests/version.check.mjs on each pull request]`
- Run `claude plugin validate .` after a change to a manifest.

## Model-facing text
The text the model reads is part of the product: the input schemas in `TOOLS` in `hooks/tools.ts`,
`RUN_DESCRIPTION` and `SEARCH_DESCRIPTION` in `hooks/protocol.ts`, `ADD_HINT_DESCRIPTION`, `REMOVE_HINT_DESCRIPTION`, `EDIT_HINT_DESCRIPTION`, `TRANSFER_TEXT`, the transfer blocks and the hint
preamble in `hooks/hints.ts`, `SAVE_FUNCTION_DESCRIPTION`, the functions section and the fix note in `hooks/functions.ts`, the SessionStart text in `hooks/session-start.sh`, tool results and deny messages, and
the bundled hints in `hints/`.
- Every sentence must change what the model does. Remove facts the model cannot act on (how approval works for the
  person, UI layout, history). The person reads those in `docs/`.
- Progressive disclosure: put in a description only what the model needs to choose and call the tool. Show the rest
  where the model needs it: argument types and hints in the `search_tools` result, server hints after a failed call,
  the limit in the message of a cut result.
- `run_code` and `search_tools` load in every session (`isDeferred: false`), so each word costs tokens in every
  session. `[test: code-mode.test.ts fails when their registrations grow; raise the limit only for text that changes what the model does]`
  `add_hint` is deferred: the `run_code` description names it, and that is how the model finds it.
  `remove_hint` and `edit_hint` are deferred too: the hint preamble names them, so the model learns of them when it
  sees a hint.
  `save_function` is deferred: the `run_code` description names it.
  `[test: code-mode.test.ts fails when no front description or the hint preamble names a deferred tool]`
- One way to do a thing. The runner also accepts `tools.<server>.<tool>()`, but descriptions show only `call()`.
- A hint is one short, factual bullet about a server. No data, no instructions about other actions.

## Docs
User docs are `README.md` and `docs/*.mdx`. They are for humans first: a developer who installs the plugin,
writes hints or sets permissions. Out of this set: `AGENTS.md`, this file and the model-facing text above.
`tests/docs.check.mjs` checks the rules marked `[test]`.

### Content
- `README.md` stays a short landing page: pitch, quick start, one example, links. User docs live in `docs/*.mdx`.
  When behavior changes, change the matching page.
- The code is the source of truth. Check every default, limit and behavior in `hooks/` or `runtime/` before you
  write it.
- Lead with what the reader wants to do and a short example. Reference tables come after.
- Keep only facts that change what a user does or understands. Leave out function names unless the user types
  them, and history.

### Format
- Each `docs/*.mdx` starts with front matter (`title`, one-sentence `description`) and an H1 equal to the title.
  `[test]`
- Plain Markdown, no JSX, imports or comments, so GitHub renders them. Keep `<…>` and `{…}` inside backticks or
  code blocks: MDX reads them as JSX. `[test]`
- Relative links use the `.mdx` name and the GitHub heading slug. When you rename a heading, fix every link to it.
  `[test: every link and anchor must resolve]`

### Language: ASD-STE100 (Simplified Technical English)
Technical names are allowed: tool names, options, file and product names.
- Instructions: imperative, one instruction per sentence, at most 20 words, condition first ("If X, do Y").
- Descriptions: at most 25 words per sentence `[test]`, one topic per sentence, at most 6 sentences per paragraph.
- Active voice, simple present. "can" for possibility, "must" for a requirement, "do not" for a prohibition.
- No should/may/might/would/could, contractions, semicolons, e.g./i.e./etc., or filler words (just, simply,
  easily) `[test]`. No -ing forms where a plain verb works. Keep the articles.
- Vertical lists for three or more items, numbered lists when order matters. A warning starts with the
  instruction, then gives the reason.
- One word for one meaning, in all docs:

| Term | Meaning | Do not use |
| --- | --- | --- |
| plugin | code-mode as Claude Code installs it | mod, extension |
| program | The JavaScript that the model gives to `run_code` | script, snippet |
| MCP tool | A tool of an MCP server, named `mcp__<server>__<tool>` | function, endpoint |
| server | An MCP server. A claude.ai connector is one kind of server. | integration |
| nested call | An MCP call that a program makes | inner call, sub-call |
| sandbox | The Node process that runs one program | VM, container |
| hint | A usage hint: a note about one server, in a hint file | tip, rule, note |
| hint file | A markdown file with hints for one server | hint doc |
| proposal | A hint, a removal, a change or a function that a model tool wrote to `pending/`, not yet approved | draft, suggestion |
| band | The area above the prompt that lists proposals | banner, bar |
| allow rule | A `permissions.allow` entry in Claude Code settings | whitelist |
