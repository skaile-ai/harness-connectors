import {
  HARNESS_CHANNEL_POLL_PATH,
  HARNESS_CHANNEL_POLL_WAIT_MS,
  type HarnessChannelFrame,
} from '@skaile/harness-protocol'
import { splitPollBatch } from './poll-batch.js'
import {
  MAX_INBOUND_MESSAGE_BYTES,
  OpenError,
  type OpenTransport,
  refusalFromResponse,
  type Transport,
  type TransportEvents,
} from './types.js'

/** At most this many frames per `POST` (the server's batch limit). */
const MAX_BATCH_FRAMES = 100
/** A `GET` waits up to 25 s on the server; give the network some slack on top. */
const GET_TIMEOUT_MS = HARNESS_CHANNEL_POLL_WAIT_MS + 10_000
const POST_TIMEOUT_MS = 30_000
/** The server answers a `GET` with at most ~1 MiB of frames (plus one oversize frame); anything far larger is not it. */
const MAX_GET_BYTES = MAX_INBOUND_MESSAGE_BYTES
const MAX_OPEN_BYTES = 64 * 1024
/** Failed `GET`s in a row before the connection counts as lost. Under the server's 60 s idle drop. */
const MAX_GET_FAILURES = 3
/** After a `POST` got 404, how long the one `GET` that fetches the connection's close code may take. */
const CLOSE_CHECK_TIMEOUT_MS = 5_000

/** Local close codes for a connection this client lost, not one the server closed. */
export const CLOSE_CONNECTION_LOST = 1006
export const CLOSE_SHUTDOWN = 1001

/**
 * The long-poll fallback (`/harness/poll`) for networks that block WebSockets. The opening
 * `POST` carries the `hello`; one `GET` is always waiting for server frames, and its cursor
 * confirms what was received, so a lost response is fetched again by repeating the cursor.
 */
export const openLongPoll: OpenTransport = async ({ apiUrl, token, firstFrame, events }) => {
  const url = apiUrl + HARNESS_CHANNEL_POLL_PATH
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([firstFrame]),
      redirect: 'error',
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new OpenError('unreachable', (error as Error).message)
  }
  const body = (await readCapped(response, MAX_OPEN_BYTES).catch(() => '')) ?? ''
  if (!response.ok) {
    throw refusalFromResponse(response.status, body)
  }
  let opened: { connectionId?: unknown; cursor?: unknown }
  try {
    opened = JSON.parse(body)
  } catch {
    throw new OpenError('unreachable', 'the long-poll open answer is not JSON')
  }
  if (typeof opened.connectionId !== 'string' || typeof opened.cursor !== 'string') {
    throw new OpenError('unreachable', 'the long-poll open answer lacks connectionId or cursor')
  }
  return new LongPollTransport(url, token, opened.connectionId, opened.cursor, events)
}

class LongPollTransport implements Transport {
  readonly kind = 'long-poll' as const
  private ended = false
  private readonly queue: HarnessChannelFrame[] = []
  private flushing = false
  private readonly getAbort = new AbortController()
  /** Aborts only the `GET` in flight, so the poll loop asks again at once. */
  private currentGet: AbortController | null = null
  /** A `POST` got 404: the next `GET` fetches the close code, and the connection ends after it. */
  private closeCheck = false

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly connectionId: string,
    cursor: string,
    private readonly events: TransportEvents,
  ) {
    void this.poll(cursor)
  }

  send(frame: HarnessChannelFrame): void {
    if (this.ended) {
      return
    }
    this.queue.push(frame)
    if (!this.closeCheck) {
      // After a 404 the connection is gone: queued frames fail when it ends, nothing more is sent.
      void this.flush()
    }
  }

  close(): void {
    // The server drops the connection after 60 s without a request; a newer one replaces it sooner.
    this.ended = true
    this.getAbort.abort()
  }

  /** Sends queued frames in order, one `POST` at a time. */
  private async flush(): Promise<void> {
    if (this.flushing) {
      return
    }
    this.flushing = true
    try {
      while (!this.ended && !this.closeCheck && this.queue.length > 0) {
        const batch = this.queue.splice(0, MAX_BATCH_FRAMES)
        let status: number
        try {
          const response = await fetch(`${this.url}?connection=${encodeURIComponent(this.connectionId)}`, {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(batch),
            redirect: 'error',
            signal: AbortSignal.timeout(POST_TIMEOUT_MS),
          })
          status = response.status
          await response.body?.cancel().catch(() => undefined)
        } catch {
          // The frames may or may not have arrived; the connection cannot be trusted any more.
          this.end(CLOSE_CONNECTION_LOST, 'connection_lost')
          return
        }
        if (status === 503) {
          this.end(CLOSE_SHUTDOWN, 'shutdown')
          return
        }
        if (status === 404) {
          // The connection ended and this batch was dropped. Ask once more, now, for its close
          // code (a `replaced` must not turn into a reconnect), then end it either way, so the
          // requests in the batch fail at once instead of timing out.
          if (!this.closeCheck) {
            // Only the `GET` that was waiting: never the one that fetches the close code.
            this.closeCheck = true
            this.currentGet?.abort()
          }
          return
        }
        if (status !== 200) {
          this.end(CLOSE_CONNECTION_LOST, 'connection_lost')
          return
        }
      }
    } finally {
      this.flushing = false
    }
  }

  private async poll(initialCursor: string): Promise<void> {
    let cursor = initialCursor
    let failures = 0
    while (!this.ended) {
      let status = 0
      let text = ''
      const closeCheck = this.closeCheck
      const get = new AbortController()
      this.currentGet = get
      try {
        const response = await fetch(`${this.url}?cursor=${encodeURIComponent(cursor)}`, {
          headers: this.headers(),
          redirect: 'error',
          signal: AbortSignal.any([
            this.getAbort.signal,
            get.signal,
            AbortSignal.timeout(closeCheck ? CLOSE_CHECK_TIMEOUT_MS : GET_TIMEOUT_MS),
          ]),
        })
        status = response.status
        const capped = await readCapped(response, MAX_GET_BYTES)
        if (capped === null) {
          this.end(CLOSE_CONNECTION_LOST, 'connection_lost')
          return
        }
        text = capped
      } catch {
        status = 0
      } finally {
        this.currentGet = null
      }
      if (this.ended) {
        return
      }
      if (this.closeCheck && !closeCheck && status !== 200) {
        // A `POST` got 404 while this `GET` waited, and aborted it: ask again at once, with the
        // same cursor, which re-sends anything the aborted one would have carried.
        continue
      }
      if (status === 200) {
        const batch = parseBatch(text)
        if (!batch) {
          this.end(CLOSE_CONNECTION_LOST, 'connection_lost')
          return
        }
        failures = 0
        cursor = batch.cursor
        for (const frame of batch.frames) {
          if (this.ended) {
            return
          }
          // Raw text: the client checks its size before it parses it.
          this.events.onFrame(frame)
        }
        if (batch.closed) {
          const code = typeof batch.closed.code === 'number' ? batch.closed.code : CLOSE_CONNECTION_LOST
          const reason = typeof batch.closed.reason === 'string' ? batch.closed.reason : 'connection_lost'
          this.end(code, reason)
          return
        }
        if (closeCheck) {
          this.end(CLOSE_CONNECTION_LOST, 'connection_lost')
          return
        }
        continue
      }
      if (status === 503) {
        this.end(CLOSE_SHUTDOWN, 'shutdown')
        return
      }
      if (closeCheck || status === 404 || status === 401 || status === 400) {
        this.end(CLOSE_CONNECTION_LOST, 'connection_lost')
        return
      }
      // A network blip: ask again with the same cursor, which re-sends anything lost.
      failures += 1
      if (failures >= MAX_GET_FAILURES) {
        this.end(CLOSE_CONNECTION_LOST, 'connection_lost')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000 * failures))
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra }
  }

  private end(code: number, reason: string): void {
    if (this.ended) {
      return
    }
    this.ended = true
    this.getAbort.abort()
    this.events.onClose(code, reason)
  }
}

/** A `GET` answer, its frames still raw; null when it is not one. */
function parseBatch(
  text: string,
): { frames: string[]; cursor: string; closed: { code?: unknown; reason?: unknown } | null } | null {
  let raw: ReturnType<typeof splitPollBatch>
  try {
    raw = splitPollBatch(text)
  } catch {
    return null
  }
  if (!raw || raw.frames === null || typeof raw.cursor !== 'string') {
    return null
  }
  const closed =
    raw.closed && typeof raw.closed === 'object' ? (raw.closed as { code?: unknown; reason?: unknown }) : null
  return { frames: raw.frames, cursor: raw.cursor, closed }
}

/** The response body as text, or null when it is larger than `maxBytes` (the read stops there). */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader()
  if (!reader) {
    return ''
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
