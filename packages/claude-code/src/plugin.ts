// SPDX-License-Identifier: Apache-2.0
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { clientLabelFor, SkaileClient } from './client.js'
import { loadConfig } from './config.js'
import { Inbox } from './inbox.js'
import { clearInboxState, writeInboxState } from './inbox-state.js'
import { createMcpServer, PeerNames, pushToChannel } from './server.js'
import type { TokenStore } from './token-store.js'

export type PluginOptions = {
  env: NodeJS.ProcessEnv
  savedApiUrl: string | null
  tokens: TokenStore
  /** The MCP channel to Claude Code (stdio in production). */
  transport: Transport
  /** The Claude Code process that started this server; the hook finds the state file by it. */
  owner: number
  cwd: string
  log: (message: string) => void
}

export type Plugin = {
  client: SkaileClient | null
  /** Closes the Skaile connection, the inbox and the MCP server. */
  shutdown: () => Promise<void>
}

/**
 * Wires the plugin's MCP server: the Skaile client, the inbox and the tools. It does not connect:
 * the first Skaile tool call does, so a session that never uses Skaile never displaces the
 * connection of one that does.
 */
export async function startPlugin(options: PluginOptions): Promise<Plugin> {
  const { log, owner } = options
  let client: SkaileClient | null = null
  let configError = ''
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
      config: loadConfig(options.env, options.savedApiUrl),
      tokens: options.tokens,
      log,
      onInbound: (event) => inbox.accept(event),
      clientLabel: clientLabelFor(options.cwd, owner),
    })
  } catch (error) {
    // Serve the tools anyway, so the model can tell the user what is wrong.
    configError = (error as Error).message
    log(configError)
  }

  const server = createMcpServer({ client, configError, inbox })
  mcp.server = server
  await server.connect(options.transport)

  return {
    client,
    shutdown: async () => {
      client?.close()
      inbox.dispose()
      try {
        clearInboxState(owner)
      } catch {
        // Best effort: the hook ignores a file whose process is gone.
      }
      await server.close()
    },
  }
}
