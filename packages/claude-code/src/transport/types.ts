import type { HarnessChannelErrorCode, HarnessChannelFrame } from '@skaile/harness-protocol'

export type TransportKind = 'websocket' | 'long-poll'

export interface TransportEvents {
  /** One raw frame from the server, as it came off the wire. */
  onFrame(raw: string): void
  /** The connection ended (server close, network loss). Not called after a local `close()`. */
  onClose(code: number, reason: string): void
}

export interface Transport {
  readonly kind: TransportKind
  send(frame: HarnessChannelFrame): void
  /** Ends the connection from this side. No `onClose` follows. */
  close(): void
}

export type OpenOptions = {
  /** API origin, e.g. `https://platform-api.skaile.ai`. */
  apiUrl: string
  token: string
  /** Sent as the connection's first frame (the `hello`). */
  firstFrame: HarnessChannelFrame
  events: TransportEvents
}

export type OpenTransport = (options: OpenOptions) => Promise<Transport>

/**
 * A connection that did not open. `refused` is the server's answer to the token (401 or 429,
 * with the `error` frame from the response body); `unreachable` is anything else: network
 * failure, a proxy, the endpoint switched off, the server shutting down.
 */
export class OpenError extends Error {
  constructor(
    readonly kind: 'refused' | 'unreachable',
    message: string,
    readonly status?: number,
    readonly code?: HarnessChannelErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'OpenError'
  }
}

/** Builds an OpenError from an HTTP refusal and its body (an `error` frame, when there is one). */
export function refusalFromResponse(status: number, body: string): OpenError {
  let code: HarnessChannelErrorCode | undefined
  let retryAfterMs: number | undefined
  try {
    const frame = JSON.parse(body) as { type?: unknown; code?: unknown; retryAfterMs?: unknown }
    if (frame?.type === 'error' && typeof frame.code === 'string') {
      code = frame.code as HarnessChannelErrorCode
    }
    if (typeof frame?.retryAfterMs === 'number' && frame.retryAfterMs >= 0) {
      retryAfterMs = frame.retryAfterMs
    }
  } catch {
    // Not a frame: a proxy's page or an empty body.
  }
  if (status === 401 || status === 429) {
    return new OpenError(
      'refused',
      `refused with HTTP ${status}${code ? ` ${code}` : ''}`,
      status,
      code ?? (status === 429 ? 'rate_limited' : 'unauthorized'),
      retryAfterMs,
    )
  }
  return new OpenError('unreachable', `HTTP ${status}`, status)
}
