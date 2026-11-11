import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { HarnessChannelPeer } from '@skaile/harness-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkaileClient } from '../src/client.js'
import { INBOUND_ASK_TTL_MS, Inbox, MAX_OPEN_ASKS } from '../src/inbox.js'
import { clearInboxState, inboxReminder, readInboxState, writeInboxState } from '../src/inbox-state.js'
import { CHANNEL_NOTIFICATION, createMcpServer, pushToChannel } from '../src/server.js'
import { FakeServer } from './fake-server.js'
import { MemoryTokenStore, makeClient, TOKEN } from './helpers.js'

const PEERS: HarnessChannelPeer[] = [
  { sessionId: 'sess-billing', name: 'Billing', online: true, agentName: 'Ada' },
  { sessionId: 'sess-ops', name: 'Ops', online: true },
]

type ChannelEvent = { content: string; meta: Record<string, string> }

let server: FakeServer
let skaile: SkaileClient
let inbox: Inbox
let mcpClient: Client
let stateDir: string
const cleanups: (() => Promise<void> | void)[] = []

/**
 * The plugin end to end, minus stdio: the fake Skaile server, the client, the inbox and the MCP
 * server, with an MCP client in place of Claude Code that records channel events.
 */
async function setup(transport: 'websocket' | 'long-poll', askTtlMs?: number) {
  server = await new FakeServer({ agents: { [TOKEN]: { agentId: 'ra_1' } }, peers: PEERS }).start()
  stateDir = mkdtempSync(join(tmpdir(), 'skaile-inbox-'))
  const events: ChannelEvent[] = []
  const mcp = { server: null as ReturnType<typeof createMcpServer> | null }
  inbox = new Inbox({
    resolveName: async (sessionId) => {
      const peer = (await skaile.listPeers()).find((candidate) => candidate.sessionId === sessionId)
      return peer?.agentName || peer?.name
    },
    deliver: (entry) => mcp.server && pushToChannel(mcp.server, entry),
    onChange: (counts) => writeInboxState(counts, stateDir),
    ...(askTtlMs ? { askTtlMs } : {}),
  })
  skaile = makeClient(server.url, new MemoryTokenStore(TOKEN), { transport, onInbound: (e) => inbox.accept(e) })
  mcp.server = createMcpServer({ client: skaile, inbox })
  mcpClient = new Client({ name: 'claude-code-stand-in', version: '1.0.0' })
  mcpClient.fallbackNotificationHandler = async (notification) => {
    if (notification.method === CHANNEL_NOTIFICATION) {
      events.push(notification.params as ChannelEvent)
    }
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.server.connect(serverSide)
  await mcpClient.connect(clientSide)
  await skaile.ensureConnected()
  const connection = server.live('ra_1')
  if (!connection) {
    throw new Error('no live connection')
  }
  cleanups.push(async () => {
    skaile.close()
    inbox.dispose()
    await mcpClient.close()
    await server.stop()
    rmSync(stateDir, { recursive: true, force: true })
  })
  return { connection, events }
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await mcpClient.callTool({ name, arguments: args })) as {
    content: { text: string }[]
    isError?: boolean
  }
  return { text: result.content.map((c) => c.text).join('\n'), isError: result.isError === true }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

describe.each(['websocket', 'long-poll'] as const)('inbound over %s', (transport) => {
  it('pushes an ask into the session as a channel event, and answer_skaile sends the answer frame', async () => {
    const { connection, events } = await setup(transport)
    expect(mcpClient.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {} })

    const ask = server.askHarness(connection, 'sess-billing', 'Which invoices are overdue?')
    await server.until(() => events.length === 1)
    expect(connection.received).toContainEqual(
      expect.objectContaining({ type: 'ack', replyTo: ask.id, exchangeId: ask.exchangeId }),
    )
    const [event] = events
    expect(event?.meta).toEqual({
      from: 'Ada (Skaile)',
      kind: 'ask',
      session_id: 'sess-billing',
      exchange_id: ask.exchangeId,
    })
    expect(event?.content).toContain('Question from Ada (Skaile)')
    expect(event?.content).toContain(`answer_skaile, exchangeId "${ask.exchangeId}"`)
    expect(event?.content).toContain('untrusted input')
    expect(event?.content).toContain('Which invoices are overdue?')
    expect(readInboxState(stateDir)).toMatchObject({ questions: 1, messages: 0, pid: process.pid })

    const answered = await call('answer_skaile', { exchangeId: ask.exchangeId, text: 'Two, both in billing.' })
    expect(answered).toEqual({
      text: expect.stringContaining('Skaile accepted the answer for Ada (Skaile)'),
      isError: false,
    })
    expect(connection.received).toContainEqual(
      expect.objectContaining({ type: 'answer', exchangeId: ask.exchangeId, text: 'Two, both in billing.' }),
    )
    expect(server.openExchanges.has(ask.exchangeId)).toBe(false)
    // Answered: closed here, so a second answer is refused before it reaches Skaile.
    const again = await call('answer_skaile', { exchangeId: ask.exchangeId, text: 'again' })
    expect(again.isError).toBe(true)
    expect(again.text).toMatch(/^invalid_argument: no open question/)
    expect(connection.received.filter((frame) => frame.type === 'answer')).toHaveLength(1)
    expect(readInboxState(stateDir)).toBeNull()
  })

  it('pushes a send as a message, and the inbox shows it once', async () => {
    const { connection, events } = await setup(transport)
    const id = server.sendHarness(connection, 'sess-ops', 'Deploy finished.')
    await server.until(() => events.length === 1)
    expect(connection.received).toContainEqual(expect.objectContaining({ type: 'ack', replyTo: id }))
    expect(events[0]?.meta).toEqual({ from: 'Ops (Skaile)', kind: 'message', session_id: 'sess-ops' })

    const first = await call('check_skaile_inbox')
    expect(first.text).toContain('Unread messages (1):')
    expect(first.text).toContain('Message from Ops (Skaile)')
    expect(first.text).toContain('Deploy finished.')
    expect((await call('check_skaile_inbox')).text).toBe('No questions or messages from Skaile agents are waiting.')
  })

  it('closes a question when the server times it out, and refuses a late answer', async () => {
    const { connection, events } = await setup(transport)
    const ask = server.askHarness(connection, 'sess-billing', 'Still there?')
    await server.until(() => events.length === 1)
    expect((await call('check_skaile_inbox')).text).toContain('Open questions (1):')

    server.timeOutExchange(connection, ask.exchangeId)
    await server.until(() => inbox.question(ask.exchangeId) === undefined)
    const late = await call('answer_skaile', { exchangeId: ask.exchangeId, text: 'Yes' })
    expect(late.isError).toBe(true)
    expect(connection.received.some((frame) => frame.type === 'answer')).toBe(false)
  })

  it('reports an answer the server refuses as closed, and drops the question', async () => {
    const { connection, events } = await setup(transport)
    const ask = server.askHarness(connection, 'sess-billing', 'Quick one?')
    await server.until(() => events.length === 1)
    // The server ended the exchange, but its `timeout` error never arrived.
    server.openExchanges.delete(ask.exchangeId)
    const result = await call('answer_skaile', { exchangeId: ask.exchangeId, text: 'Late' })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/^invalid_frame: Skaile no longer takes an answer/)
    expect(inbox.question(ask.exchangeId)).toBeUndefined()
  })
})

describe('inbox limits', () => {
  it('expires an unanswered question after its time-to-live', async () => {
    const { connection, events } = await setup('websocket', 50)
    const ask = server.askHarness(connection, 'sess-billing', 'Anyone?')
    await server.until(() => events.length === 1)
    await server.until(() => inbox.question(ask.exchangeId) === undefined)
    expect((await call('check_skaile_inbox')).text).toBe('No questions or messages from Skaile agents are waiting.')
  })

  it('declines a question beyond the open-question cap at once, with peer_offline', async () => {
    const { connection } = await setup('websocket')
    const asks = Array.from({ length: MAX_OPEN_ASKS + 1 }, (_, i) => server.askHarness(connection, 'sess-ops', `q${i}`))
    const last = asks[MAX_OPEN_ASKS]
    await server.until(() => connection.received.some((frame) => 'replyTo' in frame && frame.replyTo === last?.id))
    expect(connection.received).toContainEqual(
      expect.objectContaining({ type: 'error', replyTo: last?.id, exchangeId: last?.exchangeId, code: 'peer_offline' }),
    )
    expect(inbox.counts().questions).toBe(MAX_OPEN_ASKS)
  })

  it('keeps a question open for the server’s 5 minutes plus its 30-minute late window', () => {
    expect(INBOUND_ASK_TTL_MS).toBe(35 * 60_000)
  })
})

describe('the UserPromptSubmit hook state', () => {
  it('announces waiting counts only, and only while the writing process runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skaile-state-'))
    try {
      writeInboxState({ questions: 1, messages: 2 }, dir, 4242)
      expect(statSync(join(dir, 'inbox.json')).mode & 0o777).toBe(0o600)
      const state = readInboxState(dir)
      expect(inboxReminder(state, () => true)).toMatch(
        /^Skaile: 1 unanswered question and 2 unread messages from Skaile agents are waiting\. Call check_skaile_inbox/,
      )
      expect(inboxReminder(state, () => false)).toBe('')
      // Another process's file is left alone; the writer's own is removed.
      clearInboxState(dir, 1)
      expect(readInboxState(dir)).not.toBeNull()
      clearInboxState(dir, 4242)
      expect(readInboxState(dir)).toBeNull()
      expect(inboxReminder(null)).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
