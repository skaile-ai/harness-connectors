import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  HARNESS_CHANNEL_CLOSE_CODES,
  HARNESS_CHANNEL_HEARTBEAT_INTERVAL_MS,
  HARNESS_CHANNEL_HEARTBEAT_TIMEOUT_MS,
  HARNESS_CHANNEL_MAX_CLIENT_LABEL_LENGTH,
  HARNESS_CHANNEL_MAX_FRAME_BYTES,
  HARNESS_CHANNEL_PROTOCOL_VERSION,
  type HarnessChannelAnswerFrame,
  type HarnessChannelErrorCode,
  type HarnessChannelErrorFrame,
  type HarnessChannelFrame,
  type HarnessChannelPeer,
  type HarnessChannelPeersResultFrame,
  parseHarnessChannelFrame,
} from '@skaile/harness-protocol'
import type { Config } from './config.js'
import { describeError, SkaileError } from './errors.js'
import type { TokenStore } from './token-store.js'
import { CLOSE_CONNECTION_LOST, openLongPoll } from './transport/long-poll.js'
import { OpenError, type OpenTransport, type Transport, type TransportKind } from './transport/types.js'
import { openWebSocket } from './transport/websocket.js'
import { CLIENT_VERSION, HARNESS_KIND } from './version.js'

/** The server ends an unanswered ask after A2A_ASK_TIMEOUT_MS (5 min) with `timeout`. */
export const SERVER_ASK_TIMEOUT_MS = 300_000
/**
 * The server starts its 5 minutes only once the session is awake, and waking a hibernated session
 * can take minutes. The server always ends an exchange (`answer`, `error` `timeout`, or the close
 * of the connection, which this client notices at once or by the heartbeat), so this cap is a
 * safety net that must not fire first: the server's timeout, 30 s of slack, and 10 min for a wake.
 */
export const ASK_WAKE_ALLOWANCE_MS = 600_000
export const ASK_TIMEOUT_MS = SERVER_ASK_TIMEOUT_MS + 30_000 + ASK_WAKE_ALLOWANCE_MS
/** After WebSocket was unreachable and long-poll worked, reconnects use long-poll for this long. */
const PREFER_LONG_POLL_MS = 3_600_000

/**
 * Why the client stopped and will not reconnect on its own. `idle`: it has not connected yet (it
 * connects on the first tool call). `in_use`: another connection of the agent is live and this one
 * did not ask to take over; the next tool call tries again.
 */
export type StopReason =
  | 'idle'
  | 'in_use'
  | 'replaced'
  | 'revoked'
  | 'unsupported_version'
  | 'unauthorized'
  | 'no_token'
  | 'closed'

/** The status before the first connect. */
export const IDLE_MESSAGE =
  'Not connected yet: the plugin connects on the first Skaile tool call that talks to Skaile (asking, sending, answering or listing peers), so a session that never uses Skaile leaves the connection to the one that does. Until then it receives no questions or messages from Skaile agents.'

export type ConnectionStatus =
  | { state: 'connecting'; attempt: number }
  | { state: 'connected'; transport: TransportKind; remoteAgentId: string; since: Date }
  | { state: 'retrying'; retryAt: Date; lastError: string }
  | { state: 'stopped'; reason: StopReason; message: string }

/**
 * What a Skaile session sends this harness. `closed` means the server ended an exchange it opened
 * (`error` with its `exchangeId`, e.g. `timeout`): an answer would now be refused.
 */
export type InboundEvent =
  | { type: 'ask'; exchangeId: string; sessionId: string; text: string }
  | { type: 'send'; sessionId: string; text: string; exchangeId?: string }
  | { type: 'closed'; exchangeId: string; code: HarnessChannelErrorCode }

export type ClientOptions = {
  config: Config
  /**
   * Takes questions and messages from Skaile sessions. Returns false to decline an `ask` (the
   * inbox is full). Without it, the client declines every question and drops every message.
   */
  onInbound?: (event: InboundEvent) => boolean
  tokens: TokenStore
  /** Replaced in tests. */
  openWebSocket?: OpenTransport
  openLongPoll?: OpenTransport
  /** Defaults to the protocol's 90 s; shortened in tests. */
  heartbeatTimeoutMs?: number
  /** How long to wait for an `ack`, `welcome` or `peers_result`. */
  requestTimeoutMs?: number
  askTimeoutMs?: number
  /** Reconnect backoff: first delay and cap. */
  backoffBaseMs?: number
  backoffMaxMs?: number
  /** How long the token must be refused without a break before the client stops; shortened in tests. */
  unauthorizedGiveUpMs?: number
  /** How long a connection must stay up before the backoff starts again from the first delay. */
  stableAfterMs?: number
  /** Names this client to a newcomer the server refuses with `in_use` (see clientLabelFor). */
  clientLabel?: string
  log?: (message: string) => void
}

type Pending = {
  resolve(frame: HarnessChannelFrame): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type Live = {
  transport: Transport
  token: string
  remoteAgentId: string
  heartbeatIntervalMs: number
  maxFrameBytes: number
  lastReceivedAt: number
  lastSentAt: number
  since: Date
  heartbeat: ReturnType<typeof setInterval> | null
  /** Replies sent to server frames in the current minute window, and when that window began. */
  replies: number
  replyWindowStart: number
}

/** A server's `retryAfterMs` is honoured up to this; a larger (or corrupt) value would overflow the timer. */
export const MAX_RETRY_AFTER_MS = 3_600_000
/** Frames kept from before the `welcome` was processed; a server has no reason to send more. */
const MAX_EARLY_FRAMES = 100
/**
 * Replies (`pong`, `ack`, `error`) one connection sends to server frames per minute before it is
 * dropped. A server that asks for more is broken or hostile: one long-poll answer can carry ~2M
 * tiny elements, and replying to each would turn one bounded response into ~20k `POST`s. Legitimate
 * traffic stays far below: the server allows 30 `ask`/`send` a minute per sender, plus its pings.
 */
export const MAX_REPLIES_PER_MINUTE = 600
const REPLY_WINDOW_MS = 60_000

/**
 * How long the token must be refused without a break before it counts as one to replace. The
 * server refuses a valid token for a while when it cannot read its owner's standing, so a short
 * outage must not stop the client.
 */
export const UNAUTHORIZED_GIVE_UP_MS = 5 * 60_000
/** And at least this many refusals, so a sleep or a network outage between two cannot stop the client. */
const MIN_UNAUTHORIZED_REFUSALS = 3
/** A connection that stayed up this long resets the backoff; a shorter one keeps it growing. */
export const STABLE_CONNECTION_MS = 60_000

/** How a person tells this Claude Code session apart: the folder it runs in and its process id. */
export function clientLabelFor(cwd: string, pid: number): string {
  // The server refuses control, format, bidi and line-separator characters in the label.
  const folder = basename(cwd).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '') || cwd.slice(0, 1)
  return `Claude Code in ${folder} (pid ${pid})`.slice(0, HARNESS_CHANNEL_MAX_CLIENT_LABEL_LENGTH)
}

/**
 * One connection to Skaile over the harness channel (protocol v1.1). Keeps it alive (heartbeat,
 * dead-peer drop), reconnects with capped exponential backoff, and correlates requests with
 * their answers. It connects only when asked (a tool call or `reconnect()`), and only
 * `reconnect()` (the `/skaile:skaile reconnect` command) takes the connection over from another
 * session: any other connect is refused with `in_use` while one is live. It does NOT reconnect by
 * itself after `in_use`, `replaced`, `revoked` or `unsupported_version`: two copies of the plugin
 * would otherwise take turns forever, and a revoked or outdated client cannot succeed.
 * `reconnect()` and a newly stored token lift that.
 */
export class SkaileClient {
  private readonly config: Config
  private readonly tokens: TokenStore
  private readonly openWs: OpenTransport
  private readonly openPoll: OpenTransport
  private readonly heartbeatTimeoutMs: number
  private readonly requestTimeoutMs: number
  readonly askTimeoutMs: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly unauthorizedGiveUpMs: number
  private readonly stableAfterMs: number
  private readonly log: (message: string) => void
  private readonly onInbound: ((event: InboundEvent) => boolean) | undefined
  private readonly clientLabel: string | undefined

  private status: ConnectionStatus = { state: 'stopped', reason: 'idle', message: IDLE_MESSAGE }
  /**
   * Set by reconnect(): its attempts, retries included, ask to take the connection over until one
   * is welcomed or the client stops. No other connect takes it over.
   */
  private takeoverPending = false
  /** When (epoch ms) this client's own connection last dropped; the server may still count it live. */
  private droppedAt: number | null = null
  private live: Live | null = null
  /** Incremented per connection, so callbacks of an old one are ignored. */
  private generation = 0
  private attempt = 0
  /** When (epoch ms) the current run of unauthorized refusals began; null when none. */
  private unauthorizedSince: number | null = null
  private unauthorizedCount = 0
  /** When (epoch ms) the last unauthorized refusal of the current run came; null when none. */
  private unauthorizedLastAt: number | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** Not before this (epoch ms): a 429's `retryAfterMs`, which even a tool call respects. */
  private notBefore = 0
  private connecting: Promise<void> | null = null
  private closed = false
  /** The token a stop was about: a different stored token lifts `revoked`/`unauthorized`. */
  private stoppedToken: string | null = null
  /** Until then (epoch ms) reconnects start with long-poll: WebSocket was unreachable and long-poll worked. */
  private preferLongPollUntil = 0
  private lastPeers: { peers: HarnessChannelPeer[]; at: Date } | null = null
  private readonly pendingReplies = new Map<string, Pending>()
  private readonly pendingAsks = new Map<string, Pending>()

  constructor(options: ClientOptions) {
    this.config = options.config
    this.tokens = options.tokens
    this.openWs = options.openWebSocket ?? openWebSocket
    this.openPoll = options.openLongPoll ?? openLongPoll
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HARNESS_CHANNEL_HEARTBEAT_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.askTimeoutMs = options.askTimeoutMs ?? ASK_TIMEOUT_MS
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000
    this.backoffMaxMs = options.backoffMaxMs ?? 60_000
    this.unauthorizedGiveUpMs = options.unauthorizedGiveUpMs ?? UNAUTHORIZED_GIVE_UP_MS
    this.stableAfterMs = options.stableAfterMs ?? STABLE_CONNECTION_MS
    this.log = options.log ?? (() => undefined)
    this.onInbound = options.onInbound
    this.clientLabel = options.clientLabel
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  /** The peers from the last `peers_result`, if any. */
  getLastPeers(): { peers: HarnessChannelPeer[]; at: Date } | null {
    return this.lastPeers
  }

  /**
   * Starts connecting in the background, without taking over. Never throws. The plugin itself
   * does not call it: it connects on the first Skaile tool call.
   */
  start(): void {
    void this.connect().catch(() => undefined)
  }

  /**
   * Resolves once connected, or throws a SkaileError that says why not. A tool call goes through
   * here: it re-reads the token when not connected, so a token stored in a terminal (`cli.cjs connect`) is used
   * without restarting the server, and it skips a running backoff (but not a 429's wait).
   */
  async ensureConnected(): Promise<Live> {
    if (this.live && this.status.state === 'connected') {
      return this.live
    }
    if (this.status.state === 'stopped') {
      const { reason } = this.status
      if (reason === 'replaced' || reason === 'unsupported_version' || reason === 'closed') {
        throw new SkaileError(reason === 'closed' ? 'not_connected' : reason)
      }
      const token = await this.tokens.read()
      if (!token) {
        throw new SkaileError('no_token')
      }
      // revoked, unauthorized, no_token: only a different token can help. idle, in_use: try again
      // (the holder may be gone), still without taking over.
      if (reason !== 'idle' && reason !== 'in_use' && token === this.stoppedToken) {
        throw new SkaileError(reason === 'no_token' ? 'no_token' : reason)
      }
    }
    if (Date.now() < this.notBefore) {
      throw new SkaileError('rate_limited', undefined, this.notBefore - Date.now())
    }
    await this.connect()
    if (this.live && this.status.state === 'connected') {
      return this.live
    }
    throw this.notConnectedError()
  }

  /**
   * `/skaile:skaile reconnect`: drops the current connection (if any), re-reads the token and
   * connects with `takeover`, which replaces another session's live connection.
   */
  async reconnect(): Promise<ConnectionStatus> {
    if (this.closed) {
      return this.status
    }
    // Let an attempt in flight finish first; it would otherwise be the one this call joins.
    await this.connecting?.catch(() => undefined)
    this.dropLive(new SkaileError('not_connected', describeError('not_connected', 'reconnecting')))
    this.clearRetry()
    this.status = { state: 'connecting', attempt: 0 }
    this.attempt = 0
    this.resetUnauthorized()
    this.stoppedToken = null
    this.droppedAt = null
    this.takeoverPending = true
    await this.connect().catch(() => undefined)
    return this.status
  }

  /** Stops for good (MCP server shutdown). */
  close(): void {
    this.closed = true
    this.takeoverPending = false
    this.clearRetry()
    this.dropLive(new SkaileError('not_connected', describeError('not_connected', 'shutting down')))
    this.status = { state: 'stopped', reason: 'closed', message: 'closed' }
  }

  async listPeers(): Promise<HarnessChannelPeer[]> {
    const reply = await this.request({ type: 'peers', id: randomUUID() })
    if (reply.type !== 'peers_result') {
      throw new SkaileError('invalid_frame', describeError('invalid_frame', `unexpected ${reply.type} for peers`))
    }
    this.lastPeers = { peers: (reply as HarnessChannelPeersResultFrame).peers, at: new Date() }
    return this.lastPeers.peers
  }

  async send(sessionId: string, text: string): Promise<void> {
    const reply = await this.request({ type: 'send', id: randomUUID(), sessionId, text })
    if (reply.type !== 'ack') {
      throw new SkaileError('invalid_frame', describeError('invalid_frame', `unexpected ${reply.type} for send`))
    }
  }

  /** Asks a session and waits for its answer: `ack` first, then `answer` (or `error`) for the exchange. */
  async ask(sessionId: string, text: string): Promise<string> {
    const live = await this.ensureConnected()
    const exchangeId = randomUUID()
    const id = randomUUID()
    // Registered before sending: the answer may arrive right behind the ack.
    const answer = this.wait(this.pendingAsks, exchangeId, this.askTimeoutMs)
    answer.catch(() => undefined)
    try {
      const ack = await this.requestOn(live, { type: 'ask', id, exchangeId, sessionId, text })
      if (ack.type !== 'ack') {
        throw new SkaileError('invalid_frame', describeError('invalid_frame', `unexpected ${ack.type} for ask`))
      }
    } catch (error) {
      this.settle(this.pendingAsks, exchangeId)?.reject(error as Error)
      throw error
    }
    const frame = await answer
    if (frame.type === 'answer') {
      return (frame as HarnessChannelAnswerFrame).text
    }
    throw errorFromFrame(frame as HarnessChannelErrorFrame)
  }

  /**
   * Answers a question a Skaile session asked (`answer` under its `exchangeId`) and waits for the
   * server's `ack`. The server refuses an answer to an exchange that is over with `invalid_frame`.
   */
  async answer(exchangeId: string, text: string): Promise<void> {
    const reply = await this.request({ type: 'answer', id: randomUUID(), exchangeId, text })
    if (reply.type !== 'ack') {
      throw new SkaileError('invalid_frame', describeError('invalid_frame', `unexpected ${reply.type} for answer`))
    }
  }

  // ── Requests ────────────────────────────────────────────────────────────────

  private async request(frame: HarnessChannelFrame): Promise<HarnessChannelFrame> {
    const live = await this.ensureConnected()
    return this.requestOn(live, frame)
  }

  /** Sends a frame and waits for the frame that answers it (`replyTo` = its id); an `error` rejects. */
  private async requestOn(live: Live, frame: HarnessChannelFrame): Promise<HarnessChannelFrame> {
    const reply = this.wait(this.pendingReplies, frame.id, this.requestTimeoutMs)
    this.sendFrame(live, frame)
    const answer = await reply
    if (answer.type === 'error') {
      throw errorFromFrame(answer as HarnessChannelErrorFrame)
    }
    return answer
  }

  private wait(map: Map<string, Pending>, key: string, timeoutMs: number): Promise<HarnessChannelFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        map.delete(key)
        reject(
          map === this.pendingAsks
            ? new SkaileError('timeout')
            : new SkaileError('not_connected', describeError('not_connected', 'Skaile did not answer in time')),
        )
      }, timeoutMs)
      map.set(key, { resolve, reject, timer })
    })
  }

  private settle(map: Map<string, Pending>, key: string): Pending | undefined {
    const pending = map.get(key)
    if (pending) {
      clearTimeout(pending.timer)
      map.delete(key)
    }
    return pending
  }

  private sendFrame(live: Live, frame: HarnessChannelFrame): void {
    live.lastSentAt = Date.now()
    live.transport.send(frame)
  }

  /**
   * Sends a reply to a server frame, within the connection's reply budget. Over it, the server is
   * not one to answer: the connection is dropped (and reconnects with backoff) instead.
   */
  private reply(live: Live, frame: HarnessChannelFrame): void {
    if (this.live !== live) {
      return
    }
    const now = Date.now()
    if (now - live.replyWindowStart >= REPLY_WINDOW_MS) {
      live.replyWindowStart = now
      live.replies = 0
    }
    live.replies += 1
    if (live.replies > MAX_REPLIES_PER_MINUTE) {
      this.log(`Skaile asked for more than ${MAX_REPLIES_PER_MINUTE} replies in a minute; dropping the connection`)
      this.endLive(live, CLOSE_CONNECTION_LOST, 'connection_lost')
      // Over long-poll the server still counts the dropped connection live for up to 60 s, and it
      // is this client's own: the next attempts replace it instead of meeting it as `in_use`. A
      // WebSocket close is seen at once, so there a takeover could only displace another session.
      if (live.transport.kind === 'long-poll' && this.status.state === 'retrying') {
        this.takeoverPending = true
      }
      return
    }
    this.sendFrame(live, frame)
  }

  // ── Connecting ──────────────────────────────────────────────────────────────

  /** One connect attempt; concurrent callers share it. */
  private connect(): Promise<void> {
    if (this.closed) {
      return Promise.resolve()
    }
    if (!this.connecting) {
      this.clearRetry()
      this.connecting = this.connectOnce().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async connectOnce(): Promise<void> {
    let token: string | null
    try {
      token = await this.tokens.read()
    } catch (error) {
      // A takeover asked for by a reconnect that never reached the server must not fire later.
      this.takeoverPending = false
      throw error
    }
    if (this.closed) {
      return
    }
    if (!token) {
      this.stop('no_token', describeError('no_token'), null)
      return
    }
    const takeover = this.takeoverPending
    this.attempt += 1
    this.status = { state: 'connecting', attempt: this.attempt }
    const generation = ++this.generation
    const hello: HarnessChannelFrame = {
      type: 'hello',
      id: randomUUID(),
      protocolVersion: HARNESS_CHANNEL_PROTOCOL_VERSION,
      harnessKind: HARNESS_KIND,
      clientVersion: CLIENT_VERSION,
      ...(takeover ? { takeover: true } : {}),
      ...(this.clientLabel ? { clientLabel: this.clientLabel } : {}),
    }
    /** Frames that came behind the `welcome` before the connection was set up; replayed after. */
    const early: string[] = []
    /** A close that came after the `welcome` but before the connection was set up. */
    let earlyClose: { code: number; reason: string } | null = null
    let welcomed: (frame: HarnessChannelFrame) => void = () => undefined
    let lost: (code: number, reason: string) => void = () => undefined
    const handshake = new Promise<HarnessChannelFrame | { closed: number; reason: string }>((resolve) => {
      welcomed = resolve
      lost = (code, reason) => resolve({ closed: code, reason })
    })
    const events = {
      onFrame: (raw: string) => {
        if (generation !== this.generation) {
          return
        }
        if (!this.live) {
          // Before `welcome`: only the answer to the hello matters.
          const parsed = parseHarnessChannelFrame(raw)
          if (parsed.ok && 'replyTo' in parsed.frame && parsed.frame.replyTo === hello.id) {
            welcomed(parsed.frame)
          } else if (parsed.ok && parsed.frame.type === 'error' && !parsed.frame.replyTo) {
            welcomed(parsed.frame)
          } else if (early.length < MAX_EARLY_FRAMES) {
            early.push(raw)
          }
          return
        }
        this.onFrame(this.live, raw)
      },
      onClose: (code: number, reason: string) => {
        if (generation !== this.generation) {
          return
        }
        if (!this.live) {
          // Settles the handshake when it is still waiting; otherwise kept for after the setup.
          earlyClose = { code, reason }
          lost(code, reason)
          return
        }
        this.onClose(code, reason)
      },
    }

    let transport: Transport
    try {
      transport = await this.open(token, hello, events)
    } catch (error) {
      if (generation === this.generation && !this.closed) {
        this.onOpenFailed(error, token)
      }
      return
    }
    if (generation !== this.generation) {
      transport.close()
      return
    }

    const timeout = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), this.requestTimeoutMs)
      handshake.finally(() => clearTimeout(timer))
    })
    const first = await Promise.race([handshake, timeout])
    if (generation !== this.generation) {
      transport.close()
      return
    }
    if (first === 'timeout') {
      transport.close()
      this.scheduleRetry('no welcome from Skaile')
      return
    }
    if ('closed' in first) {
      this.afterClose(first.closed, first.reason, token)
      return
    }
    if (first.type === 'error') {
      transport.close()
      this.afterError(first as HarnessChannelErrorFrame, token)
      return
    }
    if (first.type !== 'welcome') {
      transport.close()
      this.scheduleRetry(`unexpected ${first.type} instead of welcome`)
      return
    }

    const now = Date.now()
    this.live = {
      transport,
      token,
      remoteAgentId: first.remoteAgentId,
      heartbeatIntervalMs: first.heartbeatIntervalMs || HARNESS_CHANNEL_HEARTBEAT_INTERVAL_MS,
      maxFrameBytes: first.maxFrameBytes || HARNESS_CHANNEL_MAX_FRAME_BYTES,
      lastReceivedAt: now,
      lastSentAt: now,
      since: new Date(now),
      heartbeat: null,
      replies: 0,
      replyWindowStart: now,
    }
    this.startHeartbeat(this.live)
    // The token was accepted. The backoff resets only once the connection has stayed up (endLive).
    this.resetUnauthorized()
    this.stoppedToken = null
    this.droppedAt = null
    this.takeoverPending = false
    this.status = {
      state: 'connected',
      transport: transport.kind,
      remoteAgentId: first.remoteAgentId,
      since: this.live.since,
    }
    this.log(`connected to Skaile over ${transport.kind} as ${first.remoteAgentId}`)
    for (const raw of early) {
      if (this.live) {
        this.onFrame(this.live, raw)
      }
    }
    const closedMeanwhile = earlyClose as { code: number; reason: string } | null
    if (closedMeanwhile && this.live) {
      this.endLive(this.live, closedMeanwhile.code, closedMeanwhile.reason)
    }
  }

  /** WebSocket first, long-poll when the WebSocket cannot be reached (a proxy, a firewall). */
  private async open(token: string, hello: HarnessChannelFrame, events: Parameters<OpenTransport>[0]['events']) {
    const options = { apiUrl: this.config.apiUrl, token, firstFrame: hello, events }
    const mode = this.config.transport
    if (mode === 'long-poll' || (mode === 'auto' && Date.now() < this.preferLongPollUntil)) {
      return this.openPoll(options)
    }
    try {
      return await this.openWs(options)
    } catch (error) {
      if (mode === 'websocket' || !(error instanceof OpenError) || error.kind === 'refused') {
        throw error
      }
      this.log(`WebSocket unreachable (${error.message}); trying long-poll`)
      const transport = await this.openPoll(options)
      this.preferLongPollUntil = Date.now() + PREFER_LONG_POLL_MS
      return transport
    }
  }

  private onOpenFailed(error: unknown, token: string): void {
    if (error instanceof OpenError && error.kind === 'refused') {
      if (error.code === 'rate_limited') {
        this.scheduleRetry('too many connections', error.retryAfterMs)
        return
      }
      if (error.code === 'revoked') {
        this.stop('revoked', describeError('revoked'), token)
        return
      }
      this.onUnauthorized(token)
      return
    }
    this.scheduleRetry((error as Error).message)
  }

  /**
   * The server may refuse a valid token for a while (account standing unreadable); keep retrying
   * with backoff, and give up only once it has been refused without a break (no other failure, no
   * long gap such as a sleep) for unauthorizedGiveUpMs and at least MIN_UNAUTHORIZED_REFUSALS times.
   */
  private onUnauthorized(token: string): void {
    const now = Date.now()
    // A gap far longer than any retry delay (a laptop sleep: timers do not run) breaks the run,
    // so refusals before and after it do not add up to the give-up time.
    if (this.unauthorizedLastAt !== null && now - this.unauthorizedLastAt > this.unauthorizedMaxGapMs()) {
      this.resetUnauthorized()
    }
    this.unauthorizedLastAt = now
    this.unauthorizedSince ??= now
    this.unauthorizedCount += 1
    if (
      this.unauthorizedCount >= MIN_UNAUTHORIZED_REFUSALS &&
      now - this.unauthorizedSince >= this.unauthorizedGiveUpMs
    ) {
      this.stop('unauthorized', describeError('unauthorized'), token)
      return
    }
    this.scheduleRetry('Skaile refused the token; retrying, as the refusal may be temporary', undefined, true)
  }

  private afterError(frame: HarnessChannelErrorFrame, token: string): void {
    switch (frame.code) {
      case 'unsupported_version':
        this.stop('unsupported_version', describeError('unsupported_version'), token)
        return
      case 'revoked':
        this.stop('revoked', describeError('revoked'), token)
        return
      case 'unauthorized':
        this.onUnauthorized(token)
        return
      case 'rate_limited':
        this.scheduleRetry('rate limited', frame.retryAfterMs)
        return
      case 'in_use':
        this.onInUse(frame.message, token)
        return
      default:
        this.scheduleRetry(`${frame.code}: ${frame.message}`)
    }
  }

  /** What to do after the server (or the network) ended a connection. */
  private afterClose(code: number, reason: string, token: string): void {
    switch (code) {
      case HARNESS_CHANNEL_CLOSE_CODES.replaced:
        this.stop('replaced', describeError('replaced'), token)
        return
      case HARNESS_CHANNEL_CLOSE_CODES.revoked:
        this.stop('revoked', describeError('revoked'), token)
        return
      case HARNESS_CHANNEL_CLOSE_CODES.unsupported_version:
        this.stop('unsupported_version', describeError('unsupported_version'), token)
        return
      case HARNESS_CHANNEL_CLOSE_CODES.unauthorized:
        this.onUnauthorized(token)
        return
      case HARNESS_CHANNEL_CLOSE_CODES.in_use:
        this.onInUse(undefined, token)
        return
      default:
        this.scheduleRetry(`connection closed (${code}${reason ? ` ${reason}` : ''})`)
    }
  }

  /**
   * Another connection of the agent is live. Right after this client's own connection dropped,
   * that may be its own dead one the server has not noticed yet: keep retrying, as before 1.1.
   * Otherwise stop and say who holds it; only /skaile:skaile reconnect takes it over.
   */
  private onInUse(detail: string | undefined, token: string): void {
    if (this.droppedAt !== null && Date.now() - this.droppedAt < 2 * this.heartbeatTimeoutMs) {
      this.scheduleRetry(`in use (${detail ?? 'another connection is live'}); it may be this session's dropped one`)
      return
    }
    this.stop('in_use', describeError('in_use', detail), token)
  }

  private resetUnauthorized(): void {
    this.unauthorizedSince = null
    this.unauthorizedCount = 0
    this.unauthorizedLastAt = null
  }

  /**
   * Longer than any gap between two refusals while awake: twice the longest retry delay, plus the
   * slowest refused attempt (the open, up to 30 s for a long-poll POST, then the wait for the
   * welcome), plus a margin. A slower attempt times out, which already breaks the run.
   */
  private unauthorizedMaxGapMs(): number {
    return 2 * this.backoffMaxMs + this.requestTimeoutMs + 45_000
  }

  private stop(reason: StopReason, message: string, token: string | null): void {
    this.clearRetry()
    // A new token (or /skaile:skaile reconnect) starts afresh: its own refusal clock and the first delay.
    this.resetUnauthorized()
    this.attempt = 0
    this.droppedAt = null
    this.takeoverPending = false
    this.stoppedToken = token
    this.status = { state: 'stopped', reason, message }
    this.log(`stopped: ${message}`)
  }

  /**
   * `unauthorized` keeps the refusal clock running; any other failure (the network, a 429, a
   * close) breaks the run of refusals, so the clock starts again at the next one.
   */
  private scheduleRetry(lastError: string, serverRetryAfterMs?: number, unauthorized = false): void {
    if (!unauthorized) {
      this.resetUnauthorized()
    }
    this.clearRetry()
    if (this.closed) {
      return
    }
    const retryAfterMs = serverRetryAfterMs === undefined ? undefined : Math.min(serverRetryAfterMs, MAX_RETRY_AFTER_MS)
    const backoff = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.max(0, this.attempt - 1))
    // Jitter, so many clients that lost the same server do not come back in step.
    const jittered = Math.round(backoff / 2 + Math.random() * (backoff / 2))
    const delay = retryAfterMs !== undefined ? Math.max(retryAfterMs, jittered) : jittered
    if (retryAfterMs !== undefined) {
      this.notBefore = Date.now() + retryAfterMs
    }
    this.status = { state: 'retrying', retryAt: new Date(Date.now() + delay), lastError }
    this.log(`reconnecting in ${delay} ms: ${lastError}`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect().catch(() => undefined)
    }, delay)
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private notConnectedError(): SkaileError {
    const status = this.status
    if (status.state === 'stopped') {
      if (status.reason === 'in_use') {
        return new SkaileError('in_use', status.message)
      }
      return new SkaileError(status.reason === 'closed' || status.reason === 'idle' ? 'not_connected' : status.reason)
    }
    if (status.state === 'retrying') {
      return new SkaileError('not_connected', describeError('not_connected', status.lastError))
    }
    return new SkaileError('not_connected')
  }

  // ── A live connection ───────────────────────────────────────────────────────

  private onFrame(live: Live, raw: string): void {
    live.lastReceivedAt = Date.now()
    const parsed = parseHarnessChannelFrame(raw, live.maxFrameBytes)
    if (!parsed.ok) {
      this.reply(live, {
        type: 'error',
        id: randomUUID(),
        code: parsed.code,
        message: parsed.message,
        ...(parsed.replyTo ? { replyTo: parsed.replyTo } : {}),
      })
      return
    }
    const frame = parsed.frame
    switch (frame.type) {
      case 'ping':
        this.reply(live, { type: 'pong', id: randomUUID(), replyTo: frame.id })
        return
      case 'pong':
        return
      case 'ack':
      case 'peers_result':
      case 'welcome':
        this.settle(this.pendingReplies, frame.replyTo)?.resolve(frame)
        return
      case 'error':
        this.onError(live, frame)
        return
      case 'answer': {
        this.reply(live, { type: 'ack', id: randomUUID(), replyTo: frame.id, exchangeId: frame.exchangeId })
        const pending = this.settle(this.pendingAsks, frame.exchangeId)
        if (pending) {
          pending.resolve(frame)
        } else {
          this.log(`answer for an exchange no longer waited on (${frame.exchangeId})`)
        }
        return
      }
      case 'ask': {
        const event: InboundEvent = {
          type: 'ask',
          exchangeId: frame.exchangeId,
          sessionId: frame.sessionId,
          text: frame.text,
        }
        if (this.deliver(event)) {
          this.reply(live, { type: 'ack', id: randomUUID(), replyTo: frame.id, exchangeId: frame.exchangeId })
          return
        }
        // Declined at once, so the asking session does not wait for nothing.
        this.reply(live, {
          type: 'error',
          id: randomUUID(),
          replyTo: frame.id,
          exchangeId: frame.exchangeId,
          code: 'peer_offline',
          message: this.onInbound
            ? 'Claude Code cannot take this question now (too many unanswered questions, or an unusable id); try again later.'
            : 'This Claude Code plugin cannot answer questions from Skaile.',
        })
        return
      }
      case 'send': {
        const delivered = this.deliver({
          type: 'send',
          sessionId: frame.sessionId,
          text: frame.text,
          ...(frame.exchangeId ? { exchangeId: frame.exchangeId } : {}),
        })
        if (delivered) {
          this.reply(live, {
            type: 'ack',
            id: randomUUID(),
            replyTo: frame.id,
            ...(frame.exchangeId ? { exchangeId: frame.exchangeId } : {}),
          })
          return
        }
        // Dropped: say so, so the sending session does not report it as delivered.
        this.reply(live, {
          type: 'error',
          id: randomUUID(),
          replyTo: frame.id,
          ...(frame.exchangeId ? { exchangeId: frame.exchangeId } : {}),
          code: 'peer_offline',
          message: this.onInbound
            ? 'Claude Code could not take this message (an unusable id); it was not delivered.'
            : 'This Claude Code plugin cannot take messages from Skaile.',
        })
        return
      }
      case 'hello':
      case 'peers':
        this.reply(live, {
          type: 'error',
          id: randomUUID(),
          replyTo: frame.id,
          code: 'invalid_frame',
          message: `${frame.type} is a harness-to-server frame`,
        })
        return
    }
  }

  private onError(live: Live, frame: HarnessChannelErrorFrame): void {
    if (frame.code === 'rate_limited' && frame.retryAfterMs !== undefined) {
      this.notBefore = Date.now() + Math.min(frame.retryAfterMs, MAX_RETRY_AFTER_MS)
    }
    const byReply = frame.replyTo ? this.settle(this.pendingReplies, frame.replyTo) : undefined
    if (byReply) {
      byReply.resolve(frame)
      // An ask refused outright (not_linked, rate_limited) also ends its exchange.
      if (frame.exchangeId) {
        this.settle(this.pendingAsks, frame.exchangeId)?.reject(errorFromFrame(frame))
      }
      return
    }
    const byExchange = frame.exchangeId ? this.settle(this.pendingAsks, frame.exchangeId) : undefined
    if (byExchange) {
      byExchange.resolve(frame)
      return
    }
    if (frame.exchangeId) {
      // An exchange a Skaile session opened is over (`timeout`, or the session declined it).
      this.log(`server ended exchange ${frame.exchangeId}: ${frame.code}`)
      this.deliver({ type: 'closed', exchangeId: frame.exchangeId, code: frame.code })
      return
    }
    // About the connection itself: `revoked`/`unauthorized`/`unsupported_version` precede a close.
    this.log(`server error ${frame.code}: ${frame.message}`)
    if (frame.code === 'revoked' || frame.code === 'unsupported_version') {
      this.endLive(
        live,
        frame.code === 'revoked'
          ? HARNESS_CHANNEL_CLOSE_CODES.revoked
          : HARNESS_CHANNEL_CLOSE_CODES.unsupported_version,
        frame.code,
      )
    }
  }

  /** Hands an inbound event to the inbox; a throwing handler must not break the connection. */
  private deliver(event: InboundEvent): boolean {
    if (!this.onInbound) {
      return false
    }
    try {
      return this.onInbound(event)
    } catch (error) {
      this.log(`inbound ${event.type} not delivered: ${(error as Error).message}`)
      return false
    }
  }

  private onClose(code: number, reason: string): void {
    const live = this.live
    if (!live) {
      return
    }
    this.endLive(live, code, reason)
  }

  /** Ends the live connection, fails everything waiting on it, and decides whether to reconnect. */
  private endLive(live: Live, code: number, reason: string): void {
    if (this.live !== live) {
      return
    }
    this.generation += 1
    this.live = null
    if (live.heartbeat) {
      clearInterval(live.heartbeat)
    }
    live.transport.close()
    if (Date.now() - live.since.getTime() >= this.stableAfterMs) {
      this.attempt = 0
    }
    this.afterClose(code, reason, live.token)
    if (this.status.state === 'retrying') {
      this.droppedAt = Date.now()
    }
    // The server ends an ask whose connection dropped with peer_offline; say so at once.
    const status = this.status
    const failure =
      status.state === 'stopped' && status.reason !== 'closed' && status.reason !== 'no_token'
        ? new SkaileError(status.reason === 'idle' ? 'not_connected' : status.reason, status.message)
        : new SkaileError(
            'peer_offline',
            `peer_offline: the connection to Skaile dropped (${reason || code}) before the answer came; the question is lost. ${status.state === 'retrying' ? 'Reconnecting; try again in a moment.' : ''}`.trim(),
          )
    this.failAll(failure)
  }

  private dropLive(error: Error): void {
    const live = this.live
    this.generation += 1
    this.live = null
    if (live) {
      if (live.heartbeat) {
        clearInterval(live.heartbeat)
      }
      live.transport.close()
    }
    this.failAll(error)
  }

  private failAll(error: Error): void {
    for (const map of [this.pendingReplies, this.pendingAsks]) {
      for (const [key, pending] of map) {
        clearTimeout(pending.timer)
        map.delete(key)
        pending.reject(error)
      }
    }
  }

  /**
   * Pings every `heartbeatIntervalMs` while nothing else went out, and drops a connection that
   * has received no frame of any kind for the heartbeat timeout (90 s), then reconnects.
   */
  private startHeartbeat(live: Live): void {
    const tick = Math.max(10, Math.min(live.heartbeatIntervalMs, Math.floor(this.heartbeatTimeoutMs / 6)))
    live.heartbeat = setInterval(() => {
      const now = Date.now()
      if (now - live.lastReceivedAt >= this.heartbeatTimeoutMs) {
        this.log('no frame from Skaile for the heartbeat timeout; dropping the connection')
        this.endLive(live, HARNESS_CHANNEL_CLOSE_CODES.heartbeat_timeout, 'heartbeat_timeout')
        return
      }
      if (now - live.lastSentAt >= live.heartbeatIntervalMs) {
        this.sendFrame(live, { type: 'ping', id: randomUUID() })
      }
    }, tick)
  }
}

export function errorFromFrame(frame: HarnessChannelErrorFrame): SkaileError {
  const code: HarnessChannelErrorCode = frame.code
  return new SkaileError(code, describeError(code, frame.message, frame.retryAfterMs), frame.retryAfterMs)
}
