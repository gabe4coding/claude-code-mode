# code-mode

Code mode for MCP tools in Claude Code. The model writes one JavaScript program that calls MCP tools. The program runs in a sandbox. Only the value that the program returns goes back into the context. Intermediate results do not.

## Install

Type this at the prompt of a Claude Code terminal session:

```
/plugin install code-mode --marketplace gabe4coding/claude-code-mode
```

Answer `y` to add the marketplace, then select a scope. The repository is private, so you need read access to it.

You need Node.js 20 or later. To run the mod from a local folder instead:

```bash
claude --plugin-dir /path/to/claude-code-mode
```

## Tools for the model

| Tool | What it does |
|---|---|
| `mcp__code-mode__search_tools` | Finds MCP tools by keywords. Gives the name, a one-line description and, when known, the argument types and the [usage hints](#usage-hints) for the servers. |
| `mcp__code-mode__run_code` | Runs the body of an async JavaScript function. In the body, `await call("mcp__<server>__<tool>", args)` or `await tools["<server>"]["<tool>"](args)` calls a tool. `console.log` output comes back after the result. When a call fails, the usage hints for that server come after the result. |
| `mcp__code-mode__add_hint` | Proposes a usage hint for a server. A proposal has no effect until you approve it in the band above the prompt. |

Example program:

```js
const [resources, user] = await Promise.all([
  call("mcp__claude_ai_Jira__getAccessibleAtlassianResources", {}),
  call("mcp__claude_ai_Jira__atlassianUserInfo", {}),
])
return { resourceCount: resources.length, hasAccountId: Boolean(user.account_id) }
```

## Usage hints

Each MCP server has its own result formats, required arguments and limits. Usage hints tell the model about them. Hints are markdown files with a short frontmatter:

```markdown
---
servers: [Datadog]
identify: [analyze_datadog_logs]
tools: [analyze_datadog_*]
---
- Results are TSV text inside <TSV_DATA> tags, not JSON.
- DDSQL has no substr and no INTERVAL.
```

A hint applies to a server when `servers` or `identify` finds it:

- `servers` matches the server name as `/mcp` lists it, or the `<server>` part of `mcp__<server>__<tool>`. A name with no `*` also matches the end of the name, so `Datadog` matches `claude.ai Datadog`, `claude_ai_Datadog` and `plugin:engineering:datadog`.
- `identify` finds the server by a tool that it offers. Use it always: in the desktop app, claude.ai connectors have UUID names (`mcp__fcef2cd1-…__getJiraIssue`), so `servers` cannot find them, but a server that offers `getJiraIssue` is Jira in every session. Pick a tool name that only that server has.
- `tools` is optional. It limits the hint to some tools of the server. `*` is a wildcard in all three fields.
- `search_tools` shows the hints of the servers it returns. `run_code` shows the hints of the servers whose calls failed.

### Where hints come from

| Source | Folder | Loads |
|---|---|---|
| Bundled | `hints/` in this plugin | Always |
| Your own | `~/.claude/code-mode/hints/` | Always |
| The project | `<project>/.claude/code-mode/hints/` | Only when the option `projectHints` is on |

To add a hint for an MCP server that you use, write a file in `~/.claude/code-mode/hints/`, for example `gmail.md`. One file per server is easiest. `search_tools` shows the tool names to use in `identify`.

### Hints from the model need your approval

The model can propose a hint with `add_hint` when it learns something about a server. Each proposal is one file in a `pending/` folder, and it has no effect.

While proposals wait, a band above the prompt shows "● N proposed hints for code mode" and a **Review** button. **Review** opens one card for each proposal, with the server, the tools and the hint text, and two buttons:

- **Approve** adds the proposal to the active hint file of that server (for example `~/.claude/code-mode/hints/gmail.md`) and removes it from `pending/`.
- **Discard** removes the proposal.

When no proposal waits, the band does not show. The band reads `pending/` in every interactive session, so it also shows proposals from headless runs (`claude -p`) and from sessions that are closed. The model cannot press the buttons, and a guard stops it from writing hint files directly (see below).

Where a surface lets plugins draw tool results, the `add_hint` row also shows the proposal with the same two buttons. The desktop app does not, so there only the band shows it. (The terminal is not tested yet.)

To approve a proposal by hand, move its lines into the server's hint file. To discard it, delete the file.

### Why the safety rules

The model follows hints, as it follows a CLAUDE.md file. So whoever can write a hint can steer what the model does with your MCP tools:

- **Project hints are off by default.** Anyone who can commit to a project could put a hint there. Turn on `projectHints` only for projects that you trust. Claude Code uses the same rule for `autoMode`, which it does not read from project settings.
- **Proposals from the model need your approval.** A tool result, for example a Slack message or a Jira ticket, can contain text that tells the model to save a hint. Because a proposal has no effect until you approve it, such text cannot plant a standing instruction.
- **The model cannot write hint files with its own tools.** An active hint is only a file, so the model could otherwise skip the approval. A guard in the mod denies Write, Edit and NotebookEdit on files in `~/.claude/code-mode/hints/` and `<project>/.claude/code-mode/hints/`. It checks the path as written, after `~` and `..`, and its real path through symbolic links. It also denies Bash commands that name a hint folder, read-only ones too, because a text check cannot tell reading from writing; use the Read tool to read hints. The Bash check is best effort: a shell command can build a path in ways that a text check does not see. Your own editor is not a Claude tool, so you can still edit hint files by hand.
- **Each hint shows its source file**, so you can find and fix it.

These rules make a bad hint less likely. They are not a hard security boundary: another plugin, a settings hook, or a command that you run yourself can still write to the hint folders. For a stronger rule against Claude's file tools, also add a deny rule to `~/.claude/settings.json`, for example `"permissions": { "deny": ["Edit(~/.claude/code-mode/hints/**)"] }`.

## How it works

1. At `session.start`, the mod registers its three tools. `ui.render` hooks draw the band above the prompt and the `add_hint` row.
2. `run_code` starts `runtime/runner.mjs` in a new Node process.
3. When the program calls a tool, the runner writes a request line to stdout.
4. The mod checks the call with `$.tool.check` and then does it (see [Permissions](#permissions)). Then the mod writes the result to a reply file in a temporary folder.
5. The runner reads the reply file and continues the program.
6. When the program returns, the mod sends the value (20,000 characters at most), the console lines and the number of calls to the model.

The reply goes through a file because `$.process.spawn` writes stdin only one time in this build.

## Sandbox

There are four layers:

- **vm context.** There is no `require`, `process`, `fetch`, timers or file system. Code generation from strings is off. The sandbox global has a null prototype, so `constructor.constructor` cannot get to the host `Function`. Only strings go between the host and the context.
- **Node `--permission`.** The process can only read the runner file and its temporary folder. It cannot write files, start child processes or start workers.
- **`sandbox-exec` (macOS only).** The process has no network access.
- **`ulimit -t`.** A CPU limit stops busy loops. The runner also has a wall-clock timeout.

Note: the Node `vm` module is not a security boundary by itself. The other three layers make the risk smaller. On Linux there is no network block.

## Permissions

The `run_code` call gets the normal permission check. In manual mode you see the full program in the prompt. In auto mode the classifier sees it. Then each MCP call inside the program gets `$.tool.check`:

| Verdict for the nested call | What the mod does |
|---|---|
| `deny` (a deny rule) | Denies the call. The program gets an error. |
| `allow` (an allow rule) | Runs the call with `$.tool.call`, as a direct call. |
| `ask` (no rule), `approval: program` | Runs the call with `$.mcp.call`. The approval of the program covers it. |
| `ask` (no rule), `approval: per-call` | Runs the call with `$.tool.call`, so the normal decider asks. |
| Organization ceiling set | Runs the call with `$.tool.call`, so the normal decider asks. |

### Results by permission mode

| Mode | Nested call with an allow rule | Nested call with no rule |
|---|---|---|
| Manual (default) | Runs. | `program`: runs, covered by your approval of `run_code`. `per-call`: you get a prompt for each call. |
| Auto | Runs. | Denied. |

In auto mode, the engine sends every MCP call that a plugin starts to the classifier, with `$.tool.call` and with `$.mcp.call`. The classifier only judges actions that the model asked for, so it gives no verdict and the call is denied:

```
The server-side auto mode classifier gave no verdict for mcp__…: the request that produced this action did not ask for one.
```

The `approval` option cannot change this. It is an engine limit, and the mod does not try to get around it.

### Related Claude Code issues

Both issues were open, with no fix, on 2026-10-09:

| Issue | What it reports | Relation to this mod |
|---|---|---|
| [anthropics/claude-code#100575](https://github.com/anthropics/claude-code/issues/100575) | Auto mode refuses a plugin's `$.tool.call` with "no verdict" unless an allow rule matches it (Claude Code 2.1.294). It proposes three fixes: judge the nested call with the plugin's tool call as context, let nested calls inherit the plugin tool's verdict, or show the permission mode to plugins. | The same problem. Allow rules work here too, because the mod uses `$.tool.call` when a rule allows the tool. |
| [anthropics/claude-code#99214](https://github.com/anthropics/claude-code/issues/99214) | Auto mode refuses a mod's `$.mcp.call` with the same "no verdict" error (Claude Code 2.1.286). The reporter says an allow rule in the project's `.claude/settings.json` did not help. | The same refusal for `$.mcp.call`, the path that `approval: program` uses for calls with no rule. |

When one of these issues is fixed, test the mod again in auto mode without allow rules.

### Auto mode: add allow rules

In auto mode, add an allow rule for each MCP tool that you use from `run_code`, in `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__claude_ai_Jira__getJiraIssue", "mcp__claude_ai_Jira__searchJiraIssuesUsingJql"] } }
```

- A rule for a full server (`"mcp__claude_ai_Jira"`) also allows its write tools, for example create, update and delete. Allow single read-only tools when you can.
- Allow rules apply to every call of the tool, also to direct calls from the model and in other sessions.
- The same server can have different names. In the desktop app, claude.ai connectors can have UUID names (`mcp__fcef2cd1-…__getJiraIssue`). In terminal and headless sessions they have `claude_ai_` names (`mcp__claude_ai_Jira__getJiraIssue`). A rule matches only the name that it uses, so add both names.
- `search_tools` shows the exact name for the current session.

Note: in auto mode, the classifier may refuse to let Claude edit this approval logic, because the change goes around auto mode. Make such edits in manual mode.

## Options

Set the options in `/config` or in `pluginConfigs["code-mode"].options` in settings:

| Option | Default | What it does |
|---|---|---|
| `node` | `node` | The Node.js executable (Node 20 or later). |
| `timeoutSeconds` | `120` | The wall-clock and CPU limit for one program. |
| `blockDirectMcp` | `false` | Denies direct MCP calls from the model, so that it must use `run_code`. Calls from `run_code` are not blocked. |
| `projectHints` | `false` | Also loads usage hints from `.claude/code-mode/hints/` in the project. See [Usage hints](#usage-hints). |
| `approval` | `program` | `program`: approving `run_code` approves the nested MCP calls that no rule decides. `per-call`: each nested call has its own check. In auto mode, both values need allow rules (see [Permissions](#permissions)). |

## Limits

- `search_tools` gets argument types from `.claude-plugin/types/claude-code-mcp/index.d.ts`. The engine writes that file only when the mod loads in an interactive session with hot reload, or from a `--plugin-dir` folder. In one desktop session it was 1.3 MB, with types for 544 of 645 tools. Headless `claude -p` runs do not write it. It is not known yet if the engine writes it for a plugin that is installed from a marketplace. If the file is not there, the model must use ToolSearch to see a schema. ToolSearch loads the full tool definition into the context, so part of the saving is lost.
- A tool argument called `tool` collides with the tool name in `$.tool.call`.
- Only MCP tools can be called, not built-in tools like `Bash` or `Read`.

## Tests

```bash
claude plugin test .
```

```bash
node tests/runner.integration.mjs
```

The first command tests the hooks with a fake host, because the test kit has no processes. The second command tests the real sandbox with Node.
