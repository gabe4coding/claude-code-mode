# Coding standards

Rules for changing code, tests, model-facing text and docs in this repo. `[test: x]` marks a rule that a test
enforces; the others rely on discipline.

## Code
- `hooks/` is the hooks module that Claude Code loads (`hooks/hooks.json`). Pure helpers go in `hooks/protocol.ts`
  and `hooks/hints.ts`, with no `$`, so tests call them directly. Anything that uses `$` goes in
  `hooks/register.tsx`, in a function declared at the top of the file: the engine's loader follows `$` only there,
  never across an import, and a module that passes `$` to another file does not load.
- A hook's `.catch` writes `next.error` to the debug log (`debugLog`) before it answers. A deny that says "see the
  debug log" must have a line there.
- `runtime/runner.mjs` runs inside the sandbox: Node built-ins only, no dependencies. It needs Node 22.13+, because
  `LAUNCH` passes `--permission` (stable from 22.13; Node 20 knew only `--experimental-permission`).
- `LAUNCH`, `NO_NETWORK` and `MKTEMP` exist twice: in `hooks/register.tsx` and in `tests/runner.integration.mjs`. `MARK`
  exists in `runtime/runner.mjs`, `hooks/protocol.ts` and the same test. Change all copies.
  `[test: runner.integration.mjs fails when a copy differs]`
- Never weaken a sandbox layer, the hint-file guard or the approval of proposals to make a test pass. Each one is a
  safety rule (see `docs/hints.mdx` and `docs/how-it-works.mdx`).
- Make changes to the approval logic (`approval`, `$.mcp.call` path) in manual mode: the auto mode classifier can
  refuse them, because they change what auto mode approves.

## Tests and commits
- Before every commit, run all three checks. `[test: CI runs all three]`
  - `claude plugin test .`: the hooks against a fake host (`tests/*.test.ts`). The test kit has no processes.
  - `node tests/runner.integration.mjs`: the real sandbox under Node.
  - `node tests/docs.check.mjs`: the doc rules below.
- CI (`.github/workflows/test.yml`) runs the sandbox test on Linux and on macOS. Only macOS has `sandbox-exec`,
  so only the macOS job tests the network block. CI pins the Claude Code version for `claude plugin test .`, and
  a weekly job runs the tests with the newest release.
- The type check (`docs/development.mdx`) does not run in CI: its types come from a logged-in Claude Code session.
  Run it after a change to types or to the engine API that the hooks use.
- Never put real MCP data, company names, ticket keys, user ids or tokens in tests, hints or docs: this repo is
  public. Use `fake`, `example.atlassian.net` and similar.

## Plugin
- When anything under `hooks/`, `runtime/`, `hints/` or `.claude-plugin/plugin.json` changes, bump `version` in
  `.claude-plugin/plugin.json`: Claude Code caches a plugin per version.
  `[test: CI runs tests/version.check.mjs on each pull request]`
- Run `claude plugin validate .` after a change to a manifest.

## Model-facing text
The text the model reads is part of the product: tool descriptions and input schemas in `hooks/register.tsx`,
`RUN_DESCRIPTION` and `SEARCH_DESCRIPTION` in `hooks/protocol.ts`, `ADD_HINT_DESCRIPTION`, `REMOVE_HINT_DESCRIPTION` and the hint
preamble in `hooks/hints.ts`, tool results and deny messages, and the bundled hints in `hints/`.
- Every sentence must change what the model does. Remove facts the model cannot act on (how approval works for the
  person, UI layout, history). The person reads those in `docs/`.
- Progressive disclosure: put in a description only what the model needs to choose and call the tool. Show the rest
  where the model needs it: argument types and hints in the `search_tools` result, server hints after a failed call,
  the limit in the message of a cut result.
- `run_code` and `search_tools` load in every session (`isDeferred: false`), so each word costs tokens in every
  session. `add_hint` is deferred: the `run_code` description names it, and that is how the model finds it.
  `remove_hint` is deferred too: the hint preamble names it, so the model learns of it when it sees a hint.
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
| proposal | A hint or a removal that `add_hint` or `remove_hint` wrote to `pending/`, not yet approved | draft, suggestion |
| band | The area above the prompt that lists proposals | banner, bar |
| allow rule | A `permissions.allow` entry in Claude Code settings | whitelist |
