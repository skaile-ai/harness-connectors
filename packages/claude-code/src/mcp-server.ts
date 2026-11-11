// First: checks the Node version before anything else loads.
import './node-version.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { SkaileClient } from './client.js'
import { loadConfig, readSavedApiUrl } from './config.js'
import { createTokenStore } from './token-store.js'
import { callTool, TOOL_DEFINITIONS } from './tools.js'
import { CLIENT_VERSION } from './version.js'

/**
 * The plugin's stdio MCP server. Claude Code starts one per session; it holds the one
 * connection to Skaile and serves the tools. stdout is the MCP channel, so logs go to stderr.
 */
async function main(): Promise<void> {
  const log = (message: string) => process.stderr.write(`[skaile] ${message}\n`)
  let client: SkaileClient | null = null
  let configError = ''
  try {
    client = new SkaileClient({
      config: loadConfig(process.env, await readSavedApiUrl()),
      tokens: createTokenStore(),
      log,
    })
  } catch (error) {
    // Serve the tools anyway, so the model can tell the user what is wrong.
    configError = (error as Error).message
    log(configError)
  }

  const server = new Server({ name: 'skaile', version: CLIENT_VERSION }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }))
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    client
      ? callTool(client, request.params.name, request.params.arguments)
      : { content: [{ type: 'text', text: `not_connected: ${configError}` }], isError: true },
  )

  const shutdown = () => {
    client?.close()
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
