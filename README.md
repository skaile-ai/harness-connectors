# Skaile harness connectors

Connectors that let an agent harness on your own machine, such as Claude Code, talk to your
[Skaile](https://skaile.ai) agents. A connector holds one connection to Skaile as a _remote
agent_; your Skaile sessions that you linked it to can then be asked, told and listed.

| Package                                        | What it is                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`packages/claude-code`](packages/claude-code) | Claude Code plugin: an MCP server with `ask_skaile`, `send_skaile` and `list_skaile_peers`, and the `/skaile` command |
| [`packages/protocol`](packages/protocol)       | Zod schemas of the harness channel wire protocol, v1.0, copied from the Skaile platform                               |

The wire protocol is specified in the Skaile platform repository:
`docs/protocol/harness-channel-v1.md`.

## Development

Node 22 or later.

```sh
npm install
npm run lint        # Biome
npm run typecheck   # tsc, per package
npm test            # vitest, per package
npm run build       # bundles packages/claude-code into dist/ (committed)
```

The Claude Code plugin installs from git without a build step, so `packages/claude-code/dist/`
is committed. Run `npm run build` after changing its source; CI fails when `dist/` is stale.

## Licence

[Apache-2.0](LICENSE).
