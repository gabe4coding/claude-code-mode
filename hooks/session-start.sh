#!/bin/sh
# SessionStart command hook: the model reads this at the start of the session
# and after /clear or a compaction. MCP calls go through run_code, direct calls
# only as a fallback.
#
# A command hook, not the hooks module: Claude Code's built-in security module
# skips a module's classic.SessionStart (debug log: "classic.SessionStart
# bypassed by cc-plugin-sec-default"). A set plugin option arrives as
# CLAUDE_PLUGIN_OPTION_<KEY>; an option left at its default is absent.

if [ "$CLAUDE_PLUGIN_OPTION_BLOCKDIRECTMCP" = "true" ]; then
  text='code-mode: call MCP tools only from run_code, and find them with search_tools. Direct MCP tool calls are denied.'
else
  text='code-mode: use run_code for MCP tool calls, and find tools with search_tools. Call an MCP tool directly only when run_code fails with an error that a changed program cannot fix.'
fi
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$text"
