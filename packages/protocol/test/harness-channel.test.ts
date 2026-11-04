import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HARNESS_CHANNEL_CLOSE_CODES,
  HARNESS_CHANNEL_MAX_FRAME_BYTES,
  HARNESS_CHANNEL_PROTOCOL_VERSION,
  type HarnessChannelFrame,
  harnessChannelJsonSchema,
  negotiateHarnessChannelVersion,
  parseHarnessChannelFrame,
} from '../src/index.js'

const frames: HarnessChannelFrame[] = [
  { type: 'hello', id: 'h1', protocolVersion: '1.0', harnessKind: 'claude-code', clientVersion: '0.1.0' },
  {
    type: 'welcome',
    id: 's1',
    replyTo: 'h1',
    protocolVersion: '1.0',
    remoteAgentId: 'ra_1',
    heartbeatIntervalMs: 30_000,
    maxFrameBytes: 262_144,
  },
  { type: 'ask', id: 'h2', exchangeId: 'x1', sessionId: 'sess-1', text: 'Which tests failed?' },
  { type: 'send', id: 'h3', sessionId: 'sess-1', text: 'FYI' },
  { type: 'send', id: 'h4', sessionId: 'sess-1', exchangeId: 'x2', text: 'follow-up' },
  { type: 'answer', id: 's3', exchangeId: 'x1', text: 'Two, both in billing.' },
  { type: 'ack', id: 's2', replyTo: 'h2', exchangeId: 'x1' },
  { type: 'error', id: 's4', replyTo: 'h2', code: 'rate_limited', message: 'slow down', retryAfterMs: 1000 },
  { type: 'ping', id: 's5' },
  { type: 'pong', id: 'h5', replyTo: 's5' },
  { type: 'peers', id: 'h6' },
  {
    type: 'peers_result',
    id: 's6',
    replyTo: 'h6',
    peers: [{ sessionId: 'sess-1', name: 'Billing', online: true, agentName: 'Ada' }],
  },
]

describe('harness channel protocol v1', () => {
  it('is pinned to protocol 1.0', () => {
    expect(HARNESS_CHANNEL_PROTOCOL_VERSION).toBe('1.0')
    expect(HARNESS_CHANNEL_CLOSE_CODES.replaced).toBe(4409)
  })

  it.each(frames.map((f) => [f.type, f] as const))('round-trips a %s frame', (_type, frame) => {
    const parsed = parseHarnessChannelFrame(JSON.stringify(frame))
    expect(parsed).toEqual({ ok: true, frame })
  })

  it('drops unknown keys instead of rejecting the frame', () => {
    const parsed = parseHarnessChannelFrame(JSON.stringify({ type: 'ping', id: 'p1', token: 'skr_x', extra: 1 }))
    expect(parsed).toEqual({ ok: true, frame: { type: 'ping', id: 'p1' } })
  })

  it('rejects an unknown type with invalid_frame and keeps the id as replyTo', () => {
    const parsed = parseHarnessChannelFrame(JSON.stringify({ type: 'nope', id: 'n1' }))
    expect(parsed).toMatchObject({ ok: false, code: 'invalid_frame', replyTo: 'n1' })
  })

  it('rejects text that is not JSON', () => {
    expect(parseHarnessChannelFrame('{')).toMatchObject({ ok: false, code: 'invalid_frame' })
  })

  it('rejects an oversize frame before parsing it', () => {
    const raw = JSON.stringify({
      type: 'send',
      id: 'b',
      sessionId: 's',
      text: 'x'.repeat(HARNESS_CHANNEL_MAX_FRAME_BYTES),
    })
    expect(parseHarnessChannelFrame(raw)).toMatchObject({ ok: false, code: 'payload_too_large' })
    expect(parseHarnessChannelFrame(JSON.stringify(frames[8]), 5)).toMatchObject({
      ok: false,
      code: 'payload_too_large',
    })
  })

  it('negotiates any minor of major 1 and refuses other majors', () => {
    expect(negotiateHarnessChannelVersion('1.7')).toEqual({ ok: true, version: '1.0' })
    expect(negotiateHarnessChannelVersion('2.0')).toEqual({ ok: false, code: 'unsupported_version' })
    expect(negotiateHarnessChannelVersion('x')).toEqual({ ok: false, code: 'unsupported_version' })
  })

  it('matches the JSON Schema the platform publishes for v1', () => {
    const published = JSON.parse(
      readFileSync(new URL('../src/harness-channel-v1.schema.json', import.meta.url), 'utf8'),
    )
    expect(JSON.parse(JSON.stringify(harnessChannelJsonSchema()))).toEqual(published)
  })
})
