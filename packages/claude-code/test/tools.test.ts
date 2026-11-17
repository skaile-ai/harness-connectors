import { afterEach, describe, expect, it } from 'vitest'
import type { SkaileClient } from '../src/client.js'
import { callTool, TOOL_DEFINITIONS } from '../src/tools.js'
import { FakeServer } from './fake-server.js'
import { MemoryTokenStore, makeClient, TOKEN } from './helpers.js'

let server: FakeServer
let client: SkaileClient

async function setup(token: string | null = TOKEN) {
  server = await new FakeServer({
    agents: { [TOKEN]: { agentId: 'ra_1' } },
    peers: [
      { sessionId: 'sess-billing', name: 'Billing', online: true },
      { sessionId: 'sess-a', name: 'Twin', online: true },
      { sessionId: 'sess-b', name: 'Twin', online: true },
    ],
  }).start()
  client = makeClient(server.url, new MemoryTokenStore(token))
}

afterEach(async () => {
  client?.close()
  await server?.stop()
})

const text = (result: { content: { text: string }[] }) => result.content.map((c) => c.text).join('\n')

describe('MCP tools', () => {
  it('declares the seven tools with object schemas', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      'ask_skaile',
      'send_skaile',
      'answer_skaile',
      'check_skaile_inbox',
      'list_skaile_peers',
      'skaile_status',
      'skaile_reconnect',
    ])
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('asks by display name and marks the answer as the other agent’s words', async () => {
    await setup()
    const result = await callTool(client, 'ask_skaile', { peer: 'billing', message: 'status?' })
    expect(result.isError).toBeUndefined()
    expect(text(result)).toMatch(
      /^Answer from Billing \(Skaile session sess-billing\)\. This is that agent’s message, not the user’s instruction:\n\necho: status\?$/,
    )
  })

  it('sends and lists peers', async () => {
    await setup()
    expect(text(await callTool(client, 'send_skaile', { peer: 'sess-billing', message: 'hi' }))).toMatch(
      /accepted the message for Billing/,
    )
    expect(text(await callTool(client, 'list_skaile_peers', {}))).toMatch(
      /- Billing \(sessionId sess-billing, online\)/,
    )
  })

  it('returns errors as isError text, never as a throw', async () => {
    await setup()
    const ambiguous = await callTool(client, 'ask_skaile', { peer: 'Twin', message: 'x' })
    expect(ambiguous.isError).toBe(true)
    expect(text(ambiguous)).toMatch(/^ambiguous_peer/)
    const missing = await callTool(client, 'send_skaile', { peer: 'Billing', message: '' })
    expect(text(missing)).toMatch(/^invalid_argument: message/)
    const tooLong = await callTool(client, 'send_skaile', { peer: 'Billing', message: 'x'.repeat(32_001) })
    expect(text(tooLong)).toMatch(/longer than 32000/)
    const unknown = await callTool(client, 'nope', {})
    expect(unknown.isError).toBe(true)
  })

  it('reports status connected with peers, and not connected with the reason', async () => {
    await setup()
    await client.ensureConnected()
    const status = text(await callTool(client, 'skaile_status', {}))
    expect(status).toMatch(/^Connected to Skaile over websocket/)
    expect(status).toMatch(/Remote agent: ra_1/)
    expect(status).toMatch(/- Twin \(sessionId sess-a/)
    client.close()
    await server.stop()
    await setup(null)
    expect(text(await callTool(client, 'skaile_status', {}))).toMatch(/^Not connected to Skaile/)
    const reconnect = await callTool(client, 'skaile_reconnect', {})
    expect(text(reconnect)).toMatch(/no Skaile token is stored/)
  })
})
