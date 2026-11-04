// Copied from skaile-ai/platform backend/libs/types/src/harness-channel.types.ts
// at 6c902a74857f51eafcf7029c1d310ecbc0d0a518 (protocol v1.0, spec docs/protocol/harness-channel-v1.md).
// Keep this file a verbatim copy so a diff against the platform shows protocol drift;
// change it only when the platform's copy changes. harness-channel-v1.schema.json beside it is the
// platform's published JSON Schema from the same commit; a test checks the two still agree.

import { z } from 'zod'

/**
 * Harness channel wire protocol v1: the frames a remote agent (a person's local
 * harness, e.g. Claude Code) and the Skaile server exchange. The spec is
 * `docs/protocol/harness-channel-v1.md`; the JSON Schema beside it is generated
 * from these schemas (`bun run generate:harness-channel-schema`).
 *
 * Objects strip unknown keys rather than reject them: a later minor version may add
 * optional fields, and a receiver on an older minor must still accept the frame.
 */

/** The version this build speaks, `<major>.<minor>`. */
export const HARNESS_CHANNEL_PROTOCOL_VERSION = '1.0'

/** Majors this build accepts in `hello`. Any other major gets `unsupported_version`. */
export const HARNESS_CHANNEL_SUPPORTED_MAJORS: readonly number[] = [1]

/** Upper bound on one serialized frame, in UTF-8 bytes. `welcome` may announce a lower one. */
export const HARNESS_CHANNEL_MAX_FRAME_BYTES = 256 * 1024

/** Upper bound on the `text` of `ask`, `send` and `answer`, in UTF-16 code units. */
export const HARNESS_CHANNEL_MAX_TEXT_LENGTH = 32_000

/** Upper bound on `id`, `replyTo`, `exchangeId` and `sessionId`. */
export const HARNESS_CHANNEL_MAX_ID_LENGTH = 128

/** Matches the per-agent link cap in `remote-agents` (100). */
export const HARNESS_CHANNEL_MAX_PEERS = 100

/** Bound on `error.message`; a parse failure is cut to it so the answering `error` frame stays valid. */
export const HARNESS_CHANNEL_MAX_ERROR_MESSAGE_LENGTH = 1000

/** Default ping interval. `welcome` carries the value the server actually wants. */
export const HARNESS_CHANNEL_HEARTBEAT_INTERVAL_MS = 30_000

/** A side that has heard nothing (no frame of any type) for this long drops the connection. */
export const HARNESS_CHANNEL_HEARTBEAT_TIMEOUT_MS = 90_000

/** WebSocket path a harness connects to. The token rides the upgrade, never the query string. */
export const HARNESS_CHANNEL_CONNECT_PATH = '/harness/connect'

/** Long-poll fallback for clients whose proxy blocks WebSockets: `POST` sends frames, `GET` waits for them. */
export const HARNESS_CHANNEL_POLL_PATH = '/harness/poll'

/** How long a long-poll `GET` waits for a server frame before it returns an empty batch. */
export const HARNESS_CHANNEL_POLL_WAIT_MS = 25_000

/** A long-poll client that has made no request (and holds no waiting `GET`) for this long is dropped. */
export const HARNESS_CHANNEL_POLL_IDLE_TIMEOUT_MS = 60_000

/**
 * WebSocket close codes the server ends a harness connection with. The close reason is the
 * key. `unauthorized`, `revoked` and `unsupported_version` follow an `error` frame with the same code.
 */
export const HARNESS_CHANNEL_CLOSE_CODES = {
  unsupported_version: 4400,
  unauthorized: 4401,
  revoked: 4403,
  heartbeat_timeout: 4408,
  replaced: 4409,
  hello_timeout: 4410,
} as const
export type HarnessChannelCloseReason = keyof typeof HARNESS_CHANNEL_CLOSE_CODES

const frameId = z.string().min(1).max(HARNESS_CHANNEL_MAX_ID_LENGTH)
const text = z.string().min(1).max(HARNESS_CHANNEL_MAX_TEXT_LENGTH)
const protocolVersion = z.string().regex(/^\d{1,4}\.\d{1,4}$/)

export const harnessChannelErrorCodeSchema = z.enum([
  'unauthorized',
  'revoked',
  'not_linked',
  'peer_offline',
  'unsupported_version',
  'rate_limited',
  'timeout',
  'invalid_frame',
  'payload_too_large',
])
export type HarnessChannelErrorCode = z.infer<typeof harnessChannelErrorCodeSchema>

export const harnessChannelHelloFrameSchema = z.object({
  type: z.literal('hello'),
  id: frameId,
  protocolVersion,
  /** Free string naming the harness (`claude-code`, `codex`, …). The server never branches on it. */
  harnessKind: z.string().min(1).max(64),
  clientVersion: z.string().min(1).max(64),
})

export const harnessChannelWelcomeFrameSchema = z.object({
  type: z.literal('welcome'),
  id: frameId,
  replyTo: frameId,
  protocolVersion,
  remoteAgentId: frameId,
  /** At most a third of the fixed silence timeout, so two late pings never drop an idle connection. */
  heartbeatIntervalMs: z
    .number()
    .int()
    .positive()
    .max(HARNESS_CHANNEL_HEARTBEAT_TIMEOUT_MS / 3),
  maxFrameBytes: z.number().int().positive().max(HARNESS_CHANNEL_MAX_FRAME_BYTES),
})

export const harnessChannelAskFrameSchema = z.object({
  type: z.literal('ask'),
  id: frameId,
  exchangeId: frameId,
  /** The Skaile session at the other end: the target when the harness asks, the asker when the server does. */
  sessionId: frameId,
  text,
})

export const harnessChannelSendFrameSchema = z.object({
  type: z.literal('send'),
  id: frameId,
  sessionId: frameId,
  /** Set when the message belongs to an open exchange. */
  exchangeId: frameId.optional(),
  text,
})

export const harnessChannelAnswerFrameSchema = z.object({
  type: z.literal('answer'),
  id: frameId,
  exchangeId: frameId,
  text,
})

export const harnessChannelAckFrameSchema = z.object({
  type: z.literal('ack'),
  id: frameId,
  replyTo: frameId,
  exchangeId: frameId.optional(),
})

export const harnessChannelErrorFrameSchema = z.object({
  type: z.literal('error'),
  id: frameId,
  /** Absent when the error is not about one frame (e.g. a revoked token mid-connection). */
  replyTo: frameId.optional(),
  exchangeId: frameId.optional(),
  code: harnessChannelErrorCodeSchema,
  message: z.string().max(HARNESS_CHANNEL_MAX_ERROR_MESSAGE_LENGTH),
  /** Set with `rate_limited`. */
  retryAfterMs: z.number().int().nonnegative().optional(),
})

export const harnessChannelPingFrameSchema = z.object({
  type: z.literal('ping'),
  id: frameId,
})

export const harnessChannelPongFrameSchema = z.object({
  type: z.literal('pong'),
  id: frameId,
  replyTo: frameId,
})

export const harnessChannelPeersFrameSchema = z.object({
  type: z.literal('peers'),
  id: frameId,
})

export const harnessChannelPeerSchema = z.object({
  sessionId: frameId,
  name: z.string().max(256),
  online: z.boolean(),
  /** The session's agent name, when its project has one. */
  agentName: z.string().max(256).optional(),
})

export const harnessChannelPeersResultFrameSchema = z.object({
  type: z.literal('peers_result'),
  id: frameId,
  replyTo: frameId,
  peers: z.array(harnessChannelPeerSchema).max(HARNESS_CHANNEL_MAX_PEERS),
})

export const harnessChannelFrameSchema = z.discriminatedUnion('type', [
  harnessChannelHelloFrameSchema,
  harnessChannelWelcomeFrameSchema,
  harnessChannelAskFrameSchema,
  harnessChannelSendFrameSchema,
  harnessChannelAnswerFrameSchema,
  harnessChannelAckFrameSchema,
  harnessChannelErrorFrameSchema,
  harnessChannelPingFrameSchema,
  harnessChannelPongFrameSchema,
  harnessChannelPeersFrameSchema,
  harnessChannelPeersResultFrameSchema,
])

export type HarnessChannelFrame = z.infer<typeof harnessChannelFrameSchema>
export type HarnessChannelFrameType = HarnessChannelFrame['type']
export type HarnessChannelHelloFrame = z.infer<typeof harnessChannelHelloFrameSchema>
export type HarnessChannelWelcomeFrame = z.infer<typeof harnessChannelWelcomeFrameSchema>
export type HarnessChannelAskFrame = z.infer<typeof harnessChannelAskFrameSchema>
export type HarnessChannelSendFrame = z.infer<typeof harnessChannelSendFrameSchema>
export type HarnessChannelAnswerFrame = z.infer<typeof harnessChannelAnswerFrameSchema>
export type HarnessChannelAckFrame = z.infer<typeof harnessChannelAckFrameSchema>
export type HarnessChannelErrorFrame = z.infer<typeof harnessChannelErrorFrameSchema>
export type HarnessChannelPingFrame = z.infer<typeof harnessChannelPingFrameSchema>
export type HarnessChannelPongFrame = z.infer<typeof harnessChannelPongFrameSchema>
export type HarnessChannelPeersFrame = z.infer<typeof harnessChannelPeersFrameSchema>
export type HarnessChannelPeer = z.infer<typeof harnessChannelPeerSchema>
export type HarnessChannelPeersResultFrame = z.infer<typeof harnessChannelPeersResultFrameSchema>

export type HarnessChannelParseResult =
  | { ok: true; frame: HarnessChannelFrame }
  | {
      ok: false
      code: 'invalid_frame' | 'payload_too_large'
      message: string
      /** The rejected frame's `id`, when it parsed far enough to have a usable one: the answer's `replyTo`. */
      replyTo?: string
    }

/**
 * Decodes one wire frame. The byte check runs before `JSON.parse`, so an oversize
 * frame is never parsed (a transport that hands over raw bytes should check their
 * length before decoding them, too). `maxFrameBytes` is the limit this connection announced.
 */
export function parseHarnessChannelFrame(
  raw: string,
  maxFrameBytes: number = HARNESS_CHANNEL_MAX_FRAME_BYTES,
): HarnessChannelParseResult {
  // A UTF-16 unit encodes to at most 3 UTF-8 bytes, so short strings skip the encode.
  if (raw.length * 3 > maxFrameBytes && new TextEncoder().encode(raw).byteLength > maxFrameBytes) {
    return { ok: false, code: 'payload_too_large', message: `Frame exceeds ${maxFrameBytes} bytes` }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'invalid_frame', message: 'Frame is not valid JSON' }
  }
  const parsed = harnessChannelFrameSchema.safeParse(json)
  if (!parsed.success) {
    const id = frameId.safeParse((json as { id?: unknown } | null)?.id)
    return {
      ok: false,
      code: 'invalid_frame',
      message: z.prettifyError(parsed.error).slice(0, HARNESS_CHANNEL_MAX_ERROR_MESSAGE_LENGTH),
      ...(id.success ? { replyTo: id.data } : {}),
    }
  }
  return { ok: true, frame: parsed.data }
}

/**
 * Version negotiation for `hello`: a major this build does not know is refused; any
 * minor of a known major is accepted, and both sides then speak the server's minor
 * (fields from a newer minor are optional, so the older side ignores them).
 */
export function negotiateHarnessChannelVersion(
  clientVersion: string,
): { ok: true; version: string } | { ok: false; code: 'unsupported_version' } {
  const major = Number(clientVersion.split('.')[0])
  if (!protocolVersion.safeParse(clientVersion).success || !HARNESS_CHANNEL_SUPPORTED_MAJORS.includes(major)) {
    return { ok: false, code: 'unsupported_version' }
  }
  return { ok: true, version: HARNESS_CHANNEL_PROTOCOL_VERSION }
}

/** The JSON Schema committed at `docs/protocol/harness-channel-v1.schema.json`. */
export function harnessChannelJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(harnessChannelFrameSchema, { io: 'input' }),
    title: 'Skaile harness channel frame, protocol v1',
  }
}
