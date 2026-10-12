---
name: verify
description: Project recipe for /verify in code-mode. Drive the plugin in real headless Claude Code against the bench's fake MCP server, then read the transcript and the server's call log. Use when you verify a change to hooks/, runtime/ or hints/.
---

# Verify code-mode

The surface is the agent: real `claude -p` with this plugin loaded. The model calls `run_code` or `search_tools`, the
sandbox makes nested calls, and the fake server logs each call that reaches it. A docs-only or tests-only diff has no
surface: report SKIP.

`tests/smoke.e2e.mjs` is a fixed regression test, not a verification. Use its `argv` as the reference for flags, but
write a prompt that makes the changed code run.

## Drive

Run from the repo root. Each run gets its own server name, so it sees no shapes or argument names of earlier runs.

```bash
ROOT=$PWD; OUT=$(mktemp -d); mkdir $OUT/cwd
SRV=verify_$(uuidgen | cut -c1-8 | tr A-Z a-z); SID=$(uuidgen | tr A-Z a-z)
printf '{"mcpServers":{"%s":{"command":"node","args":["%s/bench/fake-server.mjs"],"env":{"BENCH_LOG":"%s/calls.jsonl"}}}}' $SRV $ROOT $OUT > $OUT/mcp.json
PROMPT="Use mcp__code-mode__run_code to count the issues of project OPS with mcp__${SRV}__list_issues ... Then reply DONE."
cd $OUT/cwd && claude -p "$PROMPT" --restricted --strict-mcp-config --mcp-config $OUT/mcp.json --plugin-dir $ROOT \
  --allowedTools "mcp__code-mode__run_code,mcp__code-mode__search_tools,mcp__${SRV}__list_issues" \
  --output-format json --session-id $SID --max-budget-usd 0.5 --model haiku > $OUT/out.json 2> $OUT/stderr.txt
```

- Plugin options and permission rules go in `--settings`, for example
  `'{"permissions":{"deny":["mcp__<srv>__get_deploys"]},"pluginConfigs":{"code-mode":{"options":{"blockDirectMcp":true,"metrics":true}}}}'`.
- Fake server tools: `search_messages` (pages, results over 20,000 characters), `list_issues`, `query_logs`,
  `create_ticket`, `get_deploys`. Data is in `bench/data.mjs`.
- One run with Haiku costs less than $0.01.

## Evidence

```bash
jq -r '.result, .is_error, .total_cost_usd' $OUT/out.json        # reply of the model
cat $OUT/calls.jsonl                                              # nested calls that reached the server
T=~/.claude/projects/$(cd $OUT/cwd && pwd -P | sed 's/[^a-zA-Z0-9]/-/g')/$SID.jsonl
jq -c 'select(.message.content|type=="array")|.message.content[]|select(.type=="tool_use")|{name,input}' $T
jq -c 'select(.message.content|type=="array")|.message.content[]|select(.type=="tool_result")' $T
jq -r 'select(.attachment.type=="hook_additional_context")|.attachment.content[]' $T   # SessionStart text
```

Judge by the transcript and `calls.jsonl`, never by the words of the model.

## Flows worth driving

- Permission path: a nested call with an allow rule reaches the server. A call with no rule is refused, because
  `claude -p` cannot ask (`refused: Claude requested permissions ...`). A call with a deny rule is stopped before
  the run.
- Sandbox: `typeof process` and `typeof require` are `"undefined"`. `saveFile` then `readFile` round-trips.
- `search_tools` after a run shows `names from earlier calls` and `returns (earlier call)`.
- Large results: `search_messages` with `limit: 100` on `#release`.
- SessionStart text and `blockDirectMcp`: set the option in `--settings` and read the hook context.

## Clean up

The run writes outside `$OUT`. Remove it after each run:

```bash
SRV=$SRV node -e '
const fs=require("fs"),p=require("path"),H=p.join(require("os").homedir(),".claude","code-mode");
for (const f of ["shapes.json","args.json"].map(f=>p.join(H,f)).filter(fs.existsSync)) {
  const o=JSON.parse(fs.readFileSync(f,"utf8"));
  fs.writeFileSync(f, JSON.stringify(Object.fromEntries(Object.entries(o).filter(([t])=>!t.startsWith(`mcp__${process.env.SRV}__`))),null,2)+"\n") }'
rm -rf ~/.claude/code-mode/files/$SID ~/.claude/code-mode/metrics/$SID.jsonl "$(dirname $T)"
```

## Gotchas

- User-level plugins and hooks still load with `--restricted`. The SessionStart context can hold text from other
  plugins. Look only for the code-mode line.
- Without `blockDirectMcp`, the model can call `ToolSearch` to load the server's tools directly. That is not a direct
  MCP call. Check `tool_use` names for `mcp__<srv>__*`.
- macOS has no `timeout`. Use `--max-budget-usd` to cap the run.
- The plugin denies Bash commands that name its hint folders or the function folder in `~/.claude`. To check a
  proposal from `add_hint`, use the Read tool. Do not drive `add_hint` against the real `~/.claude` without a reason:
  it writes a real proposal.
