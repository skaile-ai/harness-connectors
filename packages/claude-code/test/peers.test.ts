import type { HarnessChannelPeer } from '@skaile/harness-protocol'
import { describe, expect, it } from 'vitest'
import { resolvePeer } from '../src/peers.js'

const peers: HarnessChannelPeer[] = [
  { sessionId: 's1', name: 'Billing', online: true, agentName: 'Ada' },
  { sessionId: 's2', name: 'Ops', online: true },
  { sessionId: 's3', name: 'ops', online: false, agentName: 'Bob' },
]

describe('resolvePeer', () => {
  it('matches the sessionId first', () => {
    expect(resolvePeer(peers, 's2').sessionId).toBe('s2')
  })

  it('matches a unique display name, ignoring case and spaces', () => {
    expect(resolvePeer(peers, '  billing ').sessionId).toBe('s1')
  })

  it('matches a unique agent name', () => {
    expect(resolvePeer(peers, 'bob').sessionId).toBe('s3')
  })

  it('refuses a name two peers share and lists them', () => {
    expect(() => resolvePeer(peers, 'Ops')).toThrow(
      /ambiguous_peer: 2 linked sessions are called "Ops"[\s\S]*s2[\s\S]*s3/,
    )
  })

  it('refuses an unknown peer and lists the linked ones', () => {
    expect(() => resolvePeer(peers, 'Sales')).toThrow(/unknown_peer[\s\S]*Billing \(sessionId s1/)
    expect(() => resolvePeer([], 'Sales')).toThrow(/not linked to any Skaile session/)
  })
})
