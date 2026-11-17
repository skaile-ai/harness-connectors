// First: checks the Node version before anything else loads.
import './node-version.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SkaileClient } from './client.js'
import { loadConfig, readSavedApiUrl } from './config.js'
import { Inbox } from './inbox.js'
import { clearInboxState, writeInboxState } from './inbox-state.js'
import { createMcpServer, PeerNames, pushToChannel } from './server.js'
import { createTokenStore } from './token-store.js'

/**
 * The plugin's stdio MCP server. Claude Code starts one per session; it holds the one
 * connection to Skaile, serves the tools and pushes Skaile's questions and messages into the
 * session. stdout is the MCP channel, so logs go to stderr.
 */
async function main(): Promise<void> {
  const log = (message: string) => process.stderr.write(`[skaile] ${message}\n`)
  let client: SkaileClient | null = null
  let configError = ''
  // The Claude Code process that started this server; the hook finds the state file by it.
  const owner = process.ppid
  const names = new PeerNames(() => client)
  const mcp: { server?: ReturnType<typeof createMcpServer> } = {}
  const inbox = new Inbox({
    resolveName: (sessionId) => names.lookup(sessionId),
    deliver: (entry) => {
      if (mcp.server) {
        pushToChannel(mcp.server, entry, log)
      }
    },
    onChange: (counts) => writeInboxState(counts, owner),
    log,
  })
  try {
    client = new SkaileClient({
      config: loadConfig(process.env, await readSavedApiUrl()),
      tokens: createTokenStore(),
      log,
      onInbound: (event) => inbox.accept(event),
    })
  } catch (error) {
    // Serve the tools anyway, so the model can tell the user what is wrong.
    configError = (error as Error).message
    log(configError)
  }

  const server = createMcpServer({ client, configError, inbox })
  mcp.server = server

  const shutdown = () => {
    client?.close()
    inbox.dispose()
    try {
      clearInboxState(owner)
    } catch {
      // Best effort: the hook ignores a file whose process is gone.
    }
    void server.close().finally(() => process.exit(0))
  }
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await server.connect(new StdioServerTransport())
  client?.start()
}

main().catch((error: unknown) => {
  process.stderr.write(`[skaile] failed to start: ${(error as Error).message}\n`)
  process.exit(1)
})
