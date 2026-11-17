import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  HARNESS_CHANNEL_CLOSE_CODES,
  HARNESS_CHANNEL_CONNECT_PATH,
  HARNESS_CHANNEL_POLL_PATH,
  type HarnessChannelAskFrame,
  type HarnessChannelErrorCode,
  type HarnessChannelFrame,
  type HarnessChannelPeer,
  negotiateHarnessChannelVersion,
  parseHarnessChannelFrame,
} from '@skaile/harness-protocol'
import { WebSocket, WebSocketServer } from 'ws'

/**
 * An in-process server that speaks harness channel protocol v1 over both transports
 * (`/harness/connect` WebSocket, `/harness/poll` long-poll), with the session behaviour the
 * client relies on: one live connection per agent (the newest replaces the older with 4409),
 * token refusal at connect, `peers`, `ask`/`send` routing and heartbeat pings.
 */

export type FakeAgent = { agentId: string; revoked?: boolean }

export type AskHandler = (frame: HarnessChannelAskFrame, connection: FakeConnection) => void

export type FakeServerOptions = {
  agents: Record<string, FakeAgent>
  peers?: HarnessChannelPeer[]
  /** Refuse the WebSocket upgrade the way a proxy would (HTTP 403), so the client falls back. */
  blockWebSocket?: boolean
  heartbeatIntervalMs?: number
  /** Server pings; off by default so tests control the traffic. */
  pingEveryMs?: number
  /** Default: ack, then answer `echo: <text>`. */
  onAsk?: AskHandler
  /** Long-poll `GET` wait. */
  pollWaitMs?: number
}

export class FakeConnection {
  readonly received: HarnessChannelFrame[] = []
  readonly sent: HarnessChannelFrame[] = []
  agent: FakeAgent | null = null
  welcomed = false
  closed: { code: number; reason: string } | null = null

  constructor(
    readonly kind: 'websocket' | 'long-poll',
    readonly authorization: string | undefined,
    readonly requestUrl: string,
    private readonly transmit: (json: string) => void,
    private readonly end: (code: number, reason: string) => void,
  ) {}

  send(frame: HarnessChannelFrame): void {
    if (this.closed) {
      return
    }
    this.sent.push(frame)
    this.transmit(JSON.stringify(frame))
  }

  close(code: number, reason: string): void {
    if (this.closed) {
      return
    }
    this.closed = { code, reason }
    this.end(code, reason)
  }

  /** Simulates a dead network: no close frame, nothing more is sent or read. */
  vanish(): void {
    this.closed = { code: 1006, reason: 'vanished' }
  }
}

type PollEntry = {
  connection: FakeConnection
  token: string
  outbox: string[]
  base: number
  closed: { code: number; reason: string } | null
  wake: (() => void) | null
}

export class FakeServer {
  readonly connections: FakeConnection[] = []
  /** Refusals at connect, in order: each next connect attempt takes one. */
  readonly refuseNext: { status: number; code: HarnessChannelErrorCode; retryAfterMs?: number }[] = []
  connectAttempts: { kind: 'websocket' | 'long-poll'; at: number }[] = []
  peers: HarnessChannelPeer[]
  /** Exchanges a Skaile session opened with an `ask` to the harness, still waiting for the answer. */
  readonly openExchanges = new Set<string>()
  private active = new Map<string, FakeConnection>()
  private readonly http: Server
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly polls = new Map<string, PollEntry>()
  private pinger: ReturnType<typeof setInterval> | null = null
  url = ''

  constructor(readonly options: FakeServerOptions) {
    this.peers = options.peers ?? []
    this.http = createServer((req, res) => void this.onHttp(req, res))
    this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket as import('node:net').Socket, head))
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`
    if (this.options.pingEveryMs) {
      this.pinger = setInterval(() => {
        for (const connection of this.active.values()) {
          connection.send({ type: 'ping', id: randomUUID() })
        }
      }, this.options.pingEveryMs)
    }
    return this
  }

  async stop(): Promise<void> {
    if (this.pinger) {
      clearInterval(this.pinger)
    }
    for (const client of this.wss.clients) {
      client.terminate()
    }
    for (const entry of this.polls.values()) {
      entry.wake?.()
    }
    this.http.closeAllConnections()
    await new Promise<void>((resolve) => this.http.close(() => resolve()))
  }

  /** The agent's live (welcomed, not closed) connection. */
  live(agentId: string): FakeConnection | undefined {
    const connection = this.active.get(agentId)
    return connection && !connection.closed ? connection : undefined
  }

  /** Waits until `predicate` holds, polling every 5 ms. */
  async until<T>(predicate: () => T | undefined | null | false, timeoutMs = 3_000): Promise<T> {
    const started = Date.now()
    for (;;) {
      const value = predicate()
      if (value) {
        return value
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error('condition not met in time')
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  // ── Authentication ─────────────────────────────────────────────────────────

  /** null when the connect may proceed; else the refusal to answer with. */
  private refusal(authorization: string | undefined): { status: number; body: string } | null {
    const queued = this.refuseNext.shift()
    if (queued) {
      return { status: queued.status, body: errorBody(queued.code, queued.retryAfterMs) }
    }
    const token = bearer(authorization)
    const agent = token ? this.options.agents[token] : undefined
    if (!agent) {
      return { status: 401, body: errorBody('unauthorized') }
    }
    if (agent.revoked) {
      return { status: 401, body: errorBody('revoked') }
    }
    return null
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  private onUpgrade(req: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void {
    if (!req.url?.startsWith(HARNESS_CHANNEL_CONNECT_PATH)) {
      socket.destroy()
      return
    }
    this.connectAttempts.push({ kind: 'websocket', at: Date.now() })
    if (this.options.blockWebSocket) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const refused = this.refusal(req.headers.authorization)
    if (refused) {
      socket.end(
        `HTTP/1.1 ${refused.status} Refused\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(refused.body)}\r\n\r\n${refused.body}`,
      )
      return
    }
    const token = bearer(req.headers.authorization) as string
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = new FakeConnection(
        'websocket',
        req.headers.authorization,
        req.url ?? '',
        (json) => ws.readyState === WebSocket.OPEN && ws.send(json),
        (code, reason) => ws.close(code, reason),
      )
      this.connections.push(connection)
      ws.on('message', (data) => {
        if (!connection.closed) {
          this.receive(connection, token, data.toString())
        }
      })
      ws.on('close', () => {
        connection.closed ??= { code: 1006, reason: 'client_gone' }
      })
    })
  }

  // ── Long-poll ──────────────────────────────────────────────────────────────

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname !== HARNESS_CHANNEL_POLL_PATH) {
      res.writeHead(404).end()
      return
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      const connectionId = url.searchParams.get('connection')
      if (connectionId === null) {
        this.connectAttempts.push({ kind: 'long-poll', at: Date.now() })
        const refused = this.refusal(req.headers.authorization)
        if (refused) {
          res.writeHead(refused.status, { 'Content-Type': 'application/json' }).end(refused.body)
          return
        }
        const token = bearer(req.headers.authorization) as string
        const id = randomUUID()
        const entry: PollEntry = {
          connection: null as unknown as FakeConnection,
          token,
          outbox: [],
          base: 0,
          closed: null,
          wake: null,
        }
        entry.connection = new FakeConnection(
          'long-poll',
          req.headers.authorization,
          req.url ?? '',
          (json) => {
            entry.outbox.push(json)
            entry.wake?.()
          },
          (code, reason) => {
            entry.closed = { code, reason }
            entry.wake?.()
          },
        )
        this.connections.push(entry.connection)
        this.polls.set(id, entry)
        for (const element of JSON.parse(body) as unknown[]) {
          this.receive(entry.connection, token, JSON.stringify(element))
        }
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ connectionId: id, cursor: `${id}.0` }))
        return
      }
      const entry = this.polls.get(connectionId)
      if (!entry || bearer(req.headers.authorization) !== entry.token) {
        res.writeHead(404).end()
        return
      }
      if (!entry.closed && !entry.connection.closed) {
        for (const element of JSON.parse(body) as unknown[]) {
          this.receive(entry.connection, entry.token, JSON.stringify(element))
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ connectionId }))
      return
    }
    if (req.method === 'GET') {
      const [connectionId, seqText] = (url.searchParams.get('cursor') ?? '').split('.')
      const entry = connectionId ? this.polls.get(connectionId) : undefined
      if (!entry || bearer(req.headers.authorization) !== entry.token) {
        res.writeHead(404).end()
        return
      }
      const seq = Number(seqText)
      entry.outbox.splice(0, seq - entry.base)
      entry.base = seq
      if (entry.outbox.length === 0 && !entry.closed && !entry.connection.closed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            entry.wake = null
            resolve()
          }, this.options.pollWaitMs ?? 200)
          entry.wake = () => {
            clearTimeout(timer)
            entry.wake = null
            resolve()
          }
        })
      }
      if (entry.connection.closed && !entry.closed && entry.connection.closed.reason === 'vanished') {
        // A vanished connection answers nothing until the client gives up.
        await new Promise((resolve) => setTimeout(resolve, 60_000).unref())
      }
      const frames = entry.outbox.slice()
      const closed = entry.closed ? `,"closed":${JSON.stringify(entry.closed)}` : ''
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(`{"frames":[${frames.join(',')}],"cursor":"${connectionId}.${entry.base + frames.length}"${closed}}`)
      return
    }
    res.writeHead(405).end()
  }

  // ── Session layer ──────────────────────────────────────────────────────────

  private receive(connection: FakeConnection, token: string, raw: string): void {
    const parsed = parseHarnessChannelFrame(raw)
    if (!parsed.ok) {
      connection.send({ type: 'error', id: randomUUID(), code: parsed.code, message: parsed.message })
      return
    }
    const frame = parsed.frame
    connection.received.push(frame)
    if (!connection.welcomed) {
      if (frame.type !== 'hello') {
        connection.send({
          type: 'error',
          id: randomUUID(),
          replyTo: frame.id,
          code: 'invalid_frame',
          message: 'hello first',
        })
        return
      }
      if (!negotiateHarnessChannelVersion(frame.protocolVersion).ok) {
        connection.send({
          type: 'error',
          id: randomUUID(),
          replyTo: frame.id,
          code: 'unsupported_version',
          message: 'unsupported',
        })
        connection.close(HARNESS_CHANNEL_CLOSE_CODES.unsupported_version, 'unsupported_version')
        return
      }
      const agent = this.options.agents[token] as FakeAgent
      connection.agent = agent
      connection.welcomed = true
      const previous = this.active.get(agent.agentId)
      this.active.set(agent.agentId, connection)
      previous?.close(HARNESS_CHANNEL_CLOSE_CODES.replaced, 'replaced')
      connection.send({
        type: 'welcome',
        id: randomUUID(),
        replyTo: frame.id,
        protocolVersion: '1.0',
        remoteAgentId: agent.agentId,
        heartbeatIntervalMs: this.options.heartbeatIntervalMs ?? 30_000,
        maxFrameBytes: 262_144,
      })
      return
    }
    switch (frame.type) {
      case 'ping':
        connection.send({ type: 'pong', id: randomUUID(), replyTo: frame.id })
        return
      case 'peers':
        connection.send({ type: 'peers_result', id: randomUUID(), replyTo: frame.id, peers: this.peers })
        return
      case 'ask':
        if (!this.peers.some((peer) => peer.sessionId === frame.sessionId)) {
          connection.send({
            type: 'error',
            id: randomUUID(),
            replyTo: frame.id,
            exchangeId: frame.exchangeId,
            code: 'not_linked',
            message: 'Not linked',
          })
          return
        }
        ;(this.options.onAsk ?? echoAsk)(frame, connection)
        return
      case 'send':
        if (!this.peers.some((peer) => peer.sessionId === frame.sessionId)) {
          connection.send({
            type: 'error',
            id: randomUUID(),
            replyTo: frame.id,
            code: 'not_linked',
            message: 'Not linked',
          })
          return
        }
        connection.send({ type: 'ack', id: randomUUID(), replyTo: frame.id })
        return
      case 'answer':
        if (!this.openExchanges.delete(frame.exchangeId)) {
          connection.send({
            type: 'error',
            id: randomUUID(),
            replyTo: frame.id,
            exchangeId: frame.exchangeId,
            code: 'invalid_frame',
            message: 'No session is waiting for an answer to this exchange',
          })
          return
        }
        connection.send({ type: 'ack', id: randomUUID(), replyTo: frame.id, exchangeId: frame.exchangeId })
        return
      case 'error':
        if (frame.exchangeId) {
          this.openExchanges.delete(frame.exchangeId)
        }
        return
      default:
        return
    }
  }

  /** A Skaile session asks the harness: `ask` with a fresh exchangeId. */
  askHarness(connection: FakeConnection, sessionId: string, text: string): { id: string; exchangeId: string } {
    const frame = { type: 'ask' as const, id: randomUUID(), exchangeId: randomUUID(), sessionId, text }
    this.openExchanges.add(frame.exchangeId)
    connection.send(frame)
    return frame
  }

  /** A Skaile session sends the harness a message that needs no answer. */
  sendHarness(connection: FakeConnection, sessionId: string, text: string): string {
    const id = randomUUID()
    connection.send({ type: 'send', id, sessionId, text })
    return id
  }

  /** The server ends an exchange it opened: `error` `timeout` after the late-answer window. */
  timeOutExchange(connection: FakeConnection, exchangeId: string): void {
    this.openExchanges.delete(exchangeId)
    connection.send({ type: 'error', id: randomUUID(), exchangeId, code: 'timeout', message: 'timeout' })
  }
}

export const echoAsk: AskHandler = (frame, connection) => {
  connection.send({ type: 'ack', id: randomUUID(), replyTo: frame.id, exchangeId: frame.exchangeId })
  setTimeout(() => {
    connection.send({ type: 'answer', id: randomUUID(), exchangeId: frame.exchangeId, text: `echo: ${frame.text}` })
  }, 10)
}

function bearer(header: string | undefined): string | null {
  return header?.match(/^Bearer (\S+)$/)?.[1] ?? null
}

function errorBody(code: HarnessChannelErrorCode, retryAfterMs?: number): string {
  return JSON.stringify({
    type: 'error',
    id: randomUUID(),
    code,
    message: code,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => resolve(body || '[]'))
    req.on('error', reject)
  })
}
