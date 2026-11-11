import { randomUUID } from 'node:crypto'
import type { HarnessChannelPeer } from '@skaile/harness-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { ASK_TIMEOUT_MS, SERVER_ASK_TIMEOUT_MS, type SkaileClient } from '../src/client.js'
import { SkaileError } from '../src/errors.js'
import { FakeServer } from './fake-server.js'
import { MemoryTokenStore, makeClient, OTHER_TOKEN, TOKEN } from './helpers.js'

const PEERS: HarnessChannelPeer[] = [
  { sessionId: 'sess-billing', name: 'Billing', online: true, agentName: 'Ada' },
  { sessionId: 'sess-ops', name: 'Ops', online: false },
]

let server: FakeServer
let clients: SkaileClient[] = []

async function setup(options: Partial<ConstructorParameters<typeof FakeServer>[0]> = {}) {
  server = await new FakeServer({
    agents: { [TOKEN]: { agentId: 'ra_1' }, [OTHER_TOKEN]: { agentId: 'ra_1' } },
    peers: PEERS,
    ...options,
  }).start()
  return server
}

function client(tokens = new MemoryTokenStore(TOKEN), options: Parameters<typeof makeClient>[2] = {}) {
  const c = makeClient(server.url, tokens, options)
  clients.push(c)
  return c
}

async function rejection(promise: Promise<unknown>): Promise<SkaileError> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(SkaileError)
  return error as SkaileError
}

afterEach(async () => {
  for (const c of clients) {
    c.close()
  }
  clients = []
  await server?.stop()
})

describe.each(['websocket', 'long-poll'] as const)('over %s', (transport) => {
  it('connects with the token in the Authorization header and a v1 hello', async () => {
    await setup()
    const c = client(new MemoryTokenStore(TOKEN), { transport })
    await c.ensureConnected()
    expect(c.getStatus()).toMatchObject({ state: 'connected', transport, remoteAgentId: 'ra_1' })
    const connection = server.connections[0]
    expect(connection?.kind).toBe(transport)
    expect(connection?.authorization).toBe(`Bearer ${TOKEN}`)
    expect(connection?.requestUrl).not.toContain('skr_')
    expect(connection?.received[0]).toMatchObject({
      type: 'hello',
      protocolVersion: '1.0',
      harnessKind: 'claude-code',
      clientVersion: '0.1.0',
    })
    expect(JSON.stringify(connection?.received)).not.toContain('skr_')
  })

  it('lists peers, sends, and asks with ack then answer', async () => {
    await setup()
    const c = client(new MemoryTokenStore(TOKEN), { transport })
    expect(await c.listPeers()).toEqual(PEERS)
    await c.send('sess-billing', 'FYI: deploy is done')
    expect(await c.ask('sess-billing', 'Which tests failed?')).toBe('echo: Which tests failed?')
    const connection = server.connections[0]
    // The answer was acknowledged under its exchange.
    await server.until(() => connection?.received.find((f) => f.type === 'ack'))
    const ask = connection?.received.find((f) => f.type === 'ask')
    const ack = connection?.received.find((f) => f.type === 'ack')
    expect(ack).toMatchObject({ exchangeId: (ask as { exchangeId: string }).exchangeId })
  })

  it('answers server pings, declines server asks with peer_offline, and acks server sends', async () => {
    await setup()
    const c = client(new MemoryTokenStore(TOKEN), { transport })
    await c.ensureConnected()
    const connection = server.live('ra_1')
    if (!connection) {
      throw new Error('no live connection')
    }
    connection.send({ type: 'ping', id: 'p1' })
    connection.send({ type: 'ask', id: 'a1', exchangeId: 'x-in', sessionId: 'sess-billing', text: 'hi?' })
    connection.send({ type: 'send', id: 's1', sessionId: 'sess-billing', text: 'note' })
    await server.until(() => connection.received.length >= 4)
    expect(connection.received).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'pong', replyTo: 'p1' }),
        expect.objectContaining({ type: 'error', replyTo: 'a1', exchangeId: 'x-in', code: 'peer_offline' }),
        expect.objectContaining({ type: 'ack', replyTo: 's1' }),
      ]),
    )
  })
})

describe('transport choice', () => {
  it('falls back to long-poll when the WebSocket is blocked, and stays on it', async () => {
    await setup({ blockWebSocket: true })
    const c = client()
    await c.ensureConnected()
    expect(c.getStatus()).toMatchObject({ state: 'connected', transport: 'long-poll' })
    expect(await c.ask('sess-billing', 'q')).toBe('echo: q')
    server.live('ra_1')?.close(1001, 'shutdown')
    await server.until(() => server.connectAttempts.length >= 3)
    // The reconnect went straight to long-poll.
    expect(server.connectAttempts.map((a) => a.kind)).toEqual(['websocket', 'long-poll', 'long-poll'])
  })

  it('does not fall back on a refused token', async () => {
    await setup()
    const c = client(new MemoryTokenStore(`skr_${'z'.repeat(43)}`))
    const error = await rejection(c.ensureConnected())
    expect(error.code).toBe('not_connected')
    expect(server.connectAttempts.map((a) => a.kind)).toEqual(['websocket'])
  })
})

describe('errors reach the model clearly', () => {
  it('not_linked for a session the agent is not linked to', async () => {
    await setup()
    const c = client()
    const ask = await rejection(c.ask('sess-unknown', 'hi'))
    expect(ask.code).toBe('not_linked')
    expect(ask.message).toMatch(/not linked to that Skaile session/)
    const send = await rejection(c.send('sess-unknown', 'hi'))
    expect(send.code).toBe('not_linked')
  })

  it('peer_offline and timeout from the server end the ask', async () => {
    await setup({
      onAsk: (frame, connection) => {
        connection.send({ type: 'ack', id: randomUUID(), replyTo: frame.id, exchangeId: frame.exchangeId })
        connection.send({
          type: 'error',
          id: randomUUID(),
          exchangeId: frame.exchangeId,
          code: frame.text === 'offline' ? 'peer_offline' : 'timeout',
          message: 'x',
        })
      },
    })
    const c = client()
    expect((await rejection(c.ask('sess-billing', 'offline'))).code).toBe('peer_offline')
    expect((await rejection(c.ask('sess-billing', 'slow'))).message).toMatch(/^timeout: /)
  })

  it('rate_limited carries when to retry', async () => {
    await setup({
      onAsk: (frame, connection) =>
        connection.send({
          type: 'error',
          id: randomUUID(),
          replyTo: frame.id,
          exchangeId: frame.exchangeId,
          code: 'rate_limited',
          message: 'slow down',
          retryAfterMs: 4_000,
        }),
    })
    const c = client()
    const error = await rejection(c.ask('sess-billing', 'q'))
    expect(error.code).toBe('rate_limited')
    expect(error.message).toMatch(/try again in 4 s/)
  })

  it('fails a waiting ask at once when the connection drops, then reconnects', async () => {
    await setup({ onAsk: (frame, connection) => connection.send({ type: 'ack', id: randomUUID(), replyTo: frame.id }) })
    const c = client()
    await c.ensureConnected()
    const started = Date.now()
    const pending = c.ask('sess-billing', 'q')
    await server.until(() => server.live('ra_1')?.received.some((f) => f.type === 'ask'))
    server.live('ra_1')?.close(1001, 'shutdown')
    const error = await rejection(pending)
    expect(error.code).toBe('peer_offline')
    expect(Date.now() - started).toBeLessThan(2_000)
    await server.until(() => server.connections.length === 2 && server.live('ra_1'))
  })

  it('waits longer for an answer than the server does', () => {
    expect(SERVER_ASK_TIMEOUT_MS).toBe(300_000)
    expect(ASK_TIMEOUT_MS).toBeGreaterThan(SERVER_ASK_TIMEOUT_MS)
  })
})

describe('reconnect rules', () => {
  it('does not reconnect after replaced, says so, and reconnects by hand', async () => {
    await setup()
    const first = client()
    await first.ensureConnected()
    const second = client()
    await second.ensureConnected()
    await server.until(() => first.getStatus().state === 'stopped')
    expect(first.getStatus()).toMatchObject({ state: 'stopped', reason: 'replaced' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(server.connections).toHaveLength(2)
    const error = await rejection(first.listPeers())
    expect(error.code).toBe('replaced')
    expect(error.message).toMatch(/another Claude Code session took over/)

    expect(await first.reconnect()).toMatchObject({ state: 'connected' })
    await server.until(() => second.getStatus().state === 'stopped')
    expect(await first.listPeers()).toEqual(PEERS)
  })

  it('does not reconnect after revoked, and picks up a new token without a restart', async () => {
    await setup()
    const tokens = new MemoryTokenStore(TOKEN)
    const c = client(tokens)
    await c.ensureConnected()
    const live = server.live('ra_1')
    live?.send({ type: 'error', id: randomUUID(), code: 'revoked', message: 'revoked' })
    live?.close(4403, 'revoked')
    await server.until(() => c.getStatus().state === 'stopped')
    expect(c.getStatus()).toMatchObject({ reason: 'revoked' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(server.connections).toHaveLength(1)
    expect((await rejection(c.listPeers())).code).toBe('revoked')

    // The terminal `connect` stores a new token; the next tool call reads it and connects.
    tokens.token = OTHER_TOKEN
    expect(await c.listPeers()).toEqual(PEERS)
    expect(server.connections[1]?.authorization).toBe(`Bearer ${OTHER_TOKEN}`)
  })

  it('stops on a token refused as revoked at connect', async () => {
    await setup()
    server.refuseNext.push({ status: 401, code: 'revoked' })
    const c = client()
    expect((await rejection(c.ensureConnected())).code).toBe('revoked')
    expect(c.getStatus()).toMatchObject({ state: 'stopped', reason: 'revoked' })
  })

  it('does not reconnect after unsupported_version', async () => {
    await setup()
    const c = client()
    await c.ensureConnected()
    const live = server.live('ra_1')
    live?.send({ type: 'error', id: randomUUID(), code: 'unsupported_version', message: 'no' })
    live?.close(4400, 'unsupported_version')
    await server.until(() => c.getStatus().state === 'stopped')
    expect(c.getStatus()).toMatchObject({ reason: 'unsupported_version' })
    expect((await rejection(c.listPeers())).message).toMatch(/update the Skaile Claude Code plugin/)
    expect(server.connections).toHaveLength(1)
  })

  it('after a 429 waits for retryAfterMs, even when a tool call asks', async () => {
    await setup()
    server.refuseNext.push({ status: 429, code: 'rate_limited', retryAfterMs: 400 })
    const c = client()
    c.start()
    await server.until(() => c.getStatus().state === 'retrying')
    const refused = await rejection(c.listPeers())
    expect(refused.code).toBe('rate_limited')
    await server.until(() => server.connectAttempts.length === 2, 3_000)
    const [first, second] = server.connectAttempts
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(390)
    await server.until(() => c.getStatus().state === 'connected')
  })

  it('reconnects with backoff after the server shuts down', async () => {
    await setup()
    const c = client()
    await c.ensureConnected()
    server.live('ra_1')?.close(1001, 'shutdown')
    await server.until(() => server.connections.length === 2 && c.getStatus().state === 'connected')
  })

  it('keeps retrying through a short unauthorized outage and connects once it ends', async () => {
    await setup()
    // More refusals than a count of three would allow, all within the give-up time.
    for (let i = 0; i < 4; i++) {
      server.refuseNext.push({ status: 401, code: 'unauthorized' })
    }
    const c = client(new MemoryTokenStore(TOKEN), { unauthorizedGiveUpMs: 10_000 })
    c.start()
    await server.until(() => c.getStatus().state === 'connected', 5_000)
    expect(server.connectAttempts).toHaveLength(5)
  })

  it('keeps retrying after a 4401 close behind a welcome, then reconnects', async () => {
    await setup()
    const c = client(new MemoryTokenStore(TOKEN), { unauthorizedGiveUpMs: 10_000 })
    await c.ensureConnected()
    server.refuseNext.push({ status: 401, code: 'unauthorized' }, { status: 401, code: 'unauthorized' })
    server.live('ra_1')?.close(4401, 'unauthorized')
    await server.until(() => server.connections.length === 2 && c.getStatus().state === 'connected', 5_000)
    expect(server.connectAttempts).toHaveLength(4)
  })

  it('stops once the token has been refused without a break for the give-up time, and connects nothing', async () => {
    await setup()
    const c = client(new MemoryTokenStore(`skr_${'z'.repeat(43)}`), { unauthorizedGiveUpMs: 150 })
    c.start()
    await server.until(() => {
      const status = c.getStatus()
      return status.state === 'stopped' && status.reason === 'unauthorized'
    }, 5_000)
    expect(server.connectAttempts.length).toBeGreaterThanOrEqual(3)
    expect(server.connections).toHaveLength(0)
    // The same token is not tried again by a tool call; only a new token or /skaile reconnect does.
    const attempts = server.connectAttempts.length
    const refused = await rejection(c.listPeers())
    expect(refused.code).toBe('unauthorized')
    expect(refused.message).toMatch(/\/skaile reconnect to try this one again/)
    expect(server.connectAttempts).toHaveLength(attempts)
  })

  it('grows the backoff when each connection dies right after the welcome', async () => {
    await setup()
    const c = client()
    await c.ensureConnected()
    for (let n = 1; n <= 5; n++) {
      await server.until(() => server.connections.length === n && server.live('ra_1'), 5_000)
      server.live('ra_1')?.close(1001, 'shutdown')
    }
    await server.until(() => server.connections.length === 6, 5_000)
    const at = server.connectAttempts.map((a) => a.at)
    // Attempt 5 waits at least half of min(200, 20 * 2^4) ms; without the growth it would be 10-20 ms.
    expect((at[5] ?? 0) - (at[4] ?? 0)).toBeGreaterThanOrEqual(95)
  })

  it('starts the backoff again after a connection that stayed up', async () => {
    await setup()
    const c = client(new MemoryTokenStore(TOKEN), { stableAfterMs: 50 })
    await c.ensureConnected()
    let closedAt = 0
    for (let n = 1; n <= 4; n++) {
      await server.until(() => server.connections.length === n && server.live('ra_1'), 5_000)
      await new Promise((resolve) => setTimeout(resolve, 70))
      closedAt = Date.now()
      server.live('ra_1')?.close(1001, 'shutdown')
    }
    await server.until(() => server.connections.length === 5, 5_000)
    // Each connection lived past stableAfterMs, so the reconnect waits the first delay (10-20 ms)
    // again; without the reset, attempt 4 would wait 80-160 ms.
    expect((server.connectAttempts[4]?.at ?? 0) - closedAt).toBeLessThan(75)
  })

  it('gives a new token its own refusal clock after a stop', async () => {
    await setup()
    const tokens = new MemoryTokenStore(`skr_${'z'.repeat(43)}`)
    const c = client(tokens, { unauthorizedGiveUpMs: 100 })
    c.start()
    await server.until(() => {
      const status = c.getStatus()
      return status.state === 'stopped' && status.reason === 'unauthorized'
    }, 5_000)
    // The new token is refused once (standing briefly unreadable); the client keeps trying it.
    tokens.token = TOKEN
    server.refuseNext.push({ status: 401, code: 'unauthorized' })
    await rejection(c.listPeers())
    expect(c.getStatus().state).toBe('retrying')
    await server.until(() => c.getStatus().state === 'connected', 5_000)
  })

  it('drops a silent connection after the heartbeat timeout and reconnects', async () => {
    await setup({ heartbeatIntervalMs: 50 })
    const c = client(new MemoryTokenStore(TOKEN), { heartbeatTimeoutMs: 300 })
    await c.ensureConnected()
    // The client pings while idle; the server's pongs keep it alive.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(server.connections).toHaveLength(1)
    expect(server.connections[0]?.received.some((f) => f.type === 'ping')).toBe(true)
    server.connections[0]?.vanish()
    await server.until(() => server.connections.length === 2 && c.getStatus().state === 'connected', 3_000)
  })

  it('without a token, says how to connect; a stored token is picked up on the next call', async () => {
    await setup()
    const tokens = new MemoryTokenStore(null)
    const c = client(tokens)
    const error = await rejection(c.listPeers())
    expect(error.code).toBe('no_token')
    expect(error.message).toMatch(/\/skaile connect/)
    tokens.token = TOKEN
    expect(await c.listPeers()).toEqual(PEERS)
  })
})
