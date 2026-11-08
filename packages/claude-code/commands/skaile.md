---

description: Connect Claude Code to Skaile, or show and manage the connection
argument-hint: connect | status | reconnect | disconnect
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.cjs" command:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.cjs" command $ARGUMENTS`

The output above comes from the Skaile plugin's CLI. Do what its NEXT line says, using the Skaile
MCP tools (`skaile_status`, `skaile_reconnect`), and report the result to the user in a few lines.
Never repeat a token (anything starting with `skr_`) in your reply or in a tool call.
