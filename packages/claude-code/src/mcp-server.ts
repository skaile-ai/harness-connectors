// First: checks the Node version before anything else loads.
import './node-version.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readSavedApiUrl } from './config.js'
import { startPlugin } from './plugin.js'
import { createTokenStore } from './token-store.js'

/**
 * The plugin's stdio MCP server. Claude Code starts one per session; once a tool needs it, it
 * holds the one connection to Skaile, serves the tools and pushes Skaile's questions and messages into the
 * session. stdout is the MCP channel, so logs go to stderr.
 */
async function main(): Promise<void> {
  const log = (message: string) => process.stderr.write(`[skaile] ${message}\n`)
  const plugin = await startPlugin({
    env: process.env,
    savedApiUrl: await readSavedApiUrl(),
    tokens: createTokenStore(),
    transport: new StdioServerTransport(),
    owner: process.ppid,
    cwd: process.cwd(),
    log,
  })
  const shutdown = () => {
    void plugin.shutdown().finally(() => process.exit(0))
  }
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error: unknown) => {
  process.stderr.write(`[skaile] failed to start: ${(error as Error).message}\n`)
  process.exit(1)
})
