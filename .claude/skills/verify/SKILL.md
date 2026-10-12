---
name: verify
description: Project recipe for /verify in code-mode. Drive the plugin in real Claude Code against the bench's fake MCP server with drive.mjs, headless or in tmux, then judge by the transcript and the server's call log. Use when you verify a change to hooks/, runtime/ or hints/.
---

# Verify code-mode

The surface is the agent: real Claude Code with this plugin loaded. The model calls `run_code` or `search_tools`,
the sandbox makes nested calls, and the fake server logs each call that reaches it. A docs-only or tests-only diff
has no surface: report SKIP.

`drive.mjs` (next to this file) does the setup, the evidence and the clean-up. The usage is at its top. Each run gets
its own folder, server name and session id. In a prompt or a tool name, `{srv}` is the server name.

## Pick the drive

- `node tests/smoke.e2e.mjs` covers the fixed flows in one run: allow rule, no rule, deny rule, sandbox globals,
  `saveFile`/`readFile`, `search_tools` after a run, a result that Claude Code saved to a file, and the SessionStart
  text. Run it first. Do not drive these flows again one by one.
- Then drive the changed code path with `drive.mjs run` and a prompt that makes it run. Put several probes in one
  prompt when they need the same flags.

## Headless

```bash
D=.claude/skills/verify/drive.mjs
node $D run 'Call mcp__code-mode__run_code with exactly this code: const r = await call("mcp__{srv}__list_issues", { project: "OPS" }); return r.total' --allow 'mcp__code-mode__run_code,mcp__{srv}__list_issues'
node $D clean <dir>          # after you read the evidence
```

`run` prints JSON: `reply`, `calls` (what reached the server), `toolUses`, `toolResults` (cut to 800 characters),
`hookContext` (the code-mode lines only), `savedResults`, `costUsd`. Judge by `calls` and `toolResults`, never by
`reply` alone. One run with Haiku costs less than $0.01.

Options: `--settings <json>` for plugin options and permission rules, `--max-output-tokens 5000` to make Claude Code
save a large result to a file, `--base <dir>` for the run folder.

Fake server tools: `search_messages` (pages), `list_issues`, `query_logs`, `create_ticket`, `get_deploys`. The data
is in `bench/data.mjs`.

## Auto mode

Run `--auto` two times:

1. No allow rule: the nested call is refused with `auto mode classifier gave no verdict`, and `calls` stays empty.
   This is the documented limit in `docs/permissions.mdx`. If the call reaches the server, Claude Code fixed
   anthropics/claude-code#100575: tell the person, because the docs must change.
2. `--settings '{"permissions":{"allow":["mcp__{srv}__list_issues"]}}'`: the call reaches the server.

## The band (TUI)

The band, the proposal cards and the `add_hint` row draw only in an interactive session. `band start` turns on
`projectHints`, so a proposal goes to the run's own project and not to `~/.claude`.

```bash
node $D band start                                      # prints dir and server; accepts the trust dialog of its own folder
node $D band send <dir> 'Load the tool mcp__code-mode__add_hint, then call it with server "{srv}", text "...", why "...", scope "project".'
node $D band wait 'Review'
node $D band capture                                    # evidence: the row, the band, any "hook skipped: threw" line
node $D band click '[ Review ]'                         # then '[ Approve ]' or '[ Discard ]'
node $D band files <dir>                                # the hint files of the run's project
node $D band stop <dir>                                 # stops tmux and cleans up
```

- After an edit to `hooks/`, the session reloads the plugin (`code-mode: reloaded`). To draw old rows again, use
  `band restart <dir>`.
- `band start` also writes `.claude-plugin/types/`, which the type check needs.

## Probes

- A long path: `--base` with a folder deeper than 200 characters. This found a `$.store` key over its limit.
- A tool name with a typo, a server that is not connected, a program that throws, a call that never answers.

## Gotchas

- User-level plugins and hooks still load with `--restricted`. Their text is in the transcript, but `hookContext`
  keeps only the code-mode lines.
- Without `blockDirectMcp`, the model can call `ToolSearch` to load the fake tools. That is not a direct MCP call:
  check `toolUses` for `mcp__{srv}__*`.
- The plugin denies Bash commands that name its hint folders or its function folder. Use `band files` or the Read
  tool. Never drive `add_hint` with scope `user`: it writes a real proposal to `~/.claude`.
