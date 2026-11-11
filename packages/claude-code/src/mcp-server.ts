// First: checks the Node version before anything else loads.
import './node-version.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SkaileClient } from './client.js'
import { loadConfig, readSavedApiUrl } from './config.js'
import { Inbox } from './inbox.js'
import { clearInboxState, writeInboxState } from './inbox-state.js'
import { createMcpServer, pushToChannel } from './server.js'
import { createTokenStore } from './token-store.js'

/**
 * The plugin's stdio MCP server. Claude Code starts one per session; it holds the one
 * connection to Skaile, serves the tools and pushes Skaile's questions and messages into the
 * session. stdout is the MCP channel, so logs go to stderr.
 */
async function main(): Promise<void> {
  const log = (message: string) => process.stderr.write(`[skaile] ${message}\n`)
  let client: SkaileClient | null = null
  let server: Server | null = null
  let configError = ''
  const inbox = new Inbox({
    resolveName: async (sessionId) => {
      const known = client?.getLastPeers()?.peers.find((peer) => peer.sessionId === sessionId)
      const peer = known ?? (await client?.listPeers())?.find((candidate) => candidate.sessionId === sessionId)
      return peer?.agentName || peer?.name
    },
    deliver: (entry) => {
      if (server) {
        pushToChannel(server, entry, log)
      }
    },
    onChange: (counts) => writeInboxState(counts),
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

  const mcp = createMcpServer({ client, configError, inbox })
  server = mcp

  const shutdown = () => {
    client?.close()
    inbox.dispose()
    try {
      clearInboxState()
    } catch {
      // Best effort: the hook ignores a file whose process is gone.
    }
    void mcp.close().finally(() => process.exit(0))
  }
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await mcp.connect(new StdioServerTransport())
  client?.start()
}

main().catch((error: unknown) => {
  process.stderr.write(`[skaile] failed to start: ${(error as Error).message}\n`)
  process.exit(1)
})
