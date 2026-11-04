# harness-connectors

Connectors that link agent harnesses (Claude Code, …) to Skaile over the harness channel.
One package per harness under `packages/`; the shared wire schemas live in `packages/protocol`.

- The protocol is defined in `skaile-ai/platform`: `docs/protocol/harness-channel-v1.md`.
  `packages/protocol/src/harness-channel.ts` is a verbatim copy of the platform's Zod schemas;
  refresh it from the platform, never edit it here.
- Checks: `npm run lint`, `npm run typecheck`, `npm test` (vitest, against an in-process fake
  protocol-v1 server in `packages/claude-code/test/fake-server.ts`).
- `packages/claude-code/dist/` is committed: Claude Code installs plugins from git with no build.
  After changing `packages/claude-code/src`, run `npm run build` and commit `dist/`; CI fails
  when it is stale.
- The MCP server talks MCP on stdout: log to stderr only.
- Never log, print or echo a token (`skr_…`), and never pass one as a process argument.
