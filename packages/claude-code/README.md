# Skaile for Claude Code

A Claude Code plugin that links Claude Code to your Skaile agents. Once connected, Claude can
ask a linked Skaile session a question and wait for the answer, send it a message, and list the
sessions it can reach.

## Connect

1. In Skaile, create a remote agent and copy its token (it starts with `skr_`). Link the agent
   to the sessions it may talk to.
2. In a terminal, store the token. `/skaile connect` in Claude Code prints this command with
   the plugin's path filled in:

   ```
   node "<plugin>/dist/cli.cjs" connect
   ```

   Paste the token when it asks (the input is hidden). The token never enters the Claude Code
   conversation, its transcript or a model request, and it is not a process argument.
   `/skaile` does not take a token: anything typed after `/skaile connect` is not stored, and
   the command shows the terminal path instead. `/skaile` hands what you type to the model only,
   never to a shell or a process argument. (The model can run the `/skaile` command line during
   its turn, so a command that stored or removed a token would let a prompt-injected model swap
   or drop it.)

   The token is stored in the OS keychain (macOS Keychain, or the Secret Service keyring on
   Linux through `secret-tool`). Where no keychain works, it goes to `~/.config/skaile/token`
   with mode 0600. It is never stored in the project directory.

   On macOS the plugin stores the token with the `security` tool, so the keychain item lets
   `security` read it without asking. Any process running as you can therefore read the token,
   which in practice protects it about as well as the 0600 file. The plugin does not use a
   native keychain library (so it has no native build), and this is the cost.
3. In Claude Code, run `/skaile reconnect`. `/skaile status` then shows whether Claude Code is
   connected, the remote agent and the linked sessions.

| Command              | What it does                                                              |
| -------------------- | ------------------------------------------------------------------------- |
| `/skaile connect`    | Show the terminal command that stores a token                             |
| `/skaile status`     | Connection, agent and linked sessions                                     |
| `/skaile reconnect`  | Connect again, taking the connection over from another Claude Code window |
| `/skaile disconnect` | Show the terminal command that removes the stored token                   |

## Tools

| Tool                         |                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask_skaile(peer, message)`  | Ask a linked session and wait for the answer. Skaile gives a session 5 minutes once it is awake; waking a hibernated one can take a few minutes more |
| `send_skaile(peer, message)` | Send a message without waiting for an answer                                                                                                         |
| `list_skaile_peers()`        | The linked sessions, with sessionId, name and whether they are online                                                                                |
| `skaile_status()`            | Used by `/skaile status`                                                                                                                             |
| `skaile_reconnect()`         | Used by `/skaile reconnect`                                                                                                                          |

`peer` is a session's sessionId, or a display name or agent name that only one linked session
has. A name two sessions share is refused with both listed.

Errors come back to Claude as one clear sentence that starts with its code: `not_linked`,
`peer_offline`, `revoked`, `unsupported_version`, `unauthorized`, `rate_limited`, `timeout`,
`replaced` and `not_connected`.

## One connection per agent

Skaile keeps one live connection per remote agent: the newest. Every Claude Code window starts
its own copy of the plugin's MCP server, so a second window takes the connection over and the
first one reports `replaced`. The plugin never takes it back on its own (two windows would
take turns forever): run `/skaile reconnect` in the window that should have it.

The plugin also stops reconnecting after `revoked` (create a new token) and
`unsupported_version` (update the plugin). Skaile can refuse a valid token for a short while,
so after `unauthorized` it keeps retrying and stops only once the token has been refused
without a break for 5 minutes: then store a current token, or run `/skaile reconnect` to try
the same one again. Otherwise it reconnects with capped exponential backoff (starting again
from the first delay only after a connection has stayed up for a minute), waits as long as
Skaile says after too many connection attempts, and drops a connection that has been silent
for 90 seconds.

## Configuration

| Variable           | Default                          |                                                                                                                                |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `SKAILE_API_URL`   | `https://platform-api.skaile.ai` | The Skaile API, origin only (no path). Without a saved URL: `platform-api.skaile.ai` or `staging-platform-api.skaile.ai` only. |
| `SKAILE_TRANSPORT` | `auto`                           | `auto` uses the WebSocket and falls back to long-poll when a proxy blocks it; `websocket` or `long-poll` forces one.           |

The token goes to the API host on every connect, and a project's settings can set environment
variables, so `SKAILE_API_URL` alone can name only Skaile's own API hosts. Any other host, a
self-hosted Skaile or a local one (`http://` is allowed for localhost only), must first be
saved in a terminal:

```
node "<plugin>/dist/cli.cjs" set-api-url https://skaile.example.com   # --clear to undo
```

### What this does and does not protect

The plugin keeps a project's settings from naming the host the token is sent to. It cannot
keep a project from running code in the plugin's `node` process: project settings can set
`NODE_OPTIONS` (load a script), `NODE_EXTRA_CA_CERTS` (trust a proxy that reads the TLS
traffic) or `PATH` (run another `node`), and each of those can read the token. Hooks and MCP
servers a project adds can do the same. Open only projects you trust while a token is
stored, or remove it first with `node "<plugin>/dist/cli.cjs" disconnect` in a terminal.

The plugin needs Node.js 20.3 or newer as the first `node` on `PATH`; an older one fails at
start with a message that says so.

## Not yet

Questions and messages _from_ Skaile sessions to Claude Code arrive in a later version. Until
then the plugin declines a question from Skaile at once (`peer_offline`) and acknowledges a
message without showing it.
