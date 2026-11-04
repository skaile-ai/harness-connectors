import type { HarnessChannelPeer } from '@skaile/harness-protocol'
import { SkaileError } from './errors.js'

/** One line per peer, for tool output and error messages. */
export function describePeer(peer: HarnessChannelPeer): string {
  const agent = peer.agentName ? `, agent ${peer.agentName}` : ''
  return `${peer.name || '(no name)'} (sessionId ${peer.sessionId}${agent}, ${peer.online ? 'online' : 'offline'})`
}

/**
 * Finds the session a `peer` argument means. It matches, in order: the exact sessionId; the
 * display name (case and surrounding spaces ignored); the agent name. A name two peers share is
 * refused with the candidates listed, so the model retries with the sessionId.
 */
export function resolvePeer(peers: HarnessChannelPeer[], query: string): HarnessChannelPeer {
  const wanted = query.trim()
  const byId = peers.find((peer) => peer.sessionId === wanted)
  if (byId) {
    return byId
  }
  const folded = wanted.toLowerCase()
  for (const field of ['name', 'agentName'] as const) {
    const matches = peers.filter((peer) => peer[field]?.trim().toLowerCase() === folded)
    if (matches.length === 1 && matches[0]) {
      return matches[0]
    }
    if (matches.length > 1) {
      throw new SkaileError(
        'ambiguous_peer',
        `ambiguous_peer: ${matches.length} linked sessions are called "${wanted}". Use the sessionId of the one you mean:\n${matches.map((peer) => `- ${describePeer(peer)}`).join('\n')}`,
      )
    }
  }
  const known = peers.length
    ? `Linked sessions:\n${peers.map((peer) => `- ${describePeer(peer)}`).join('\n')}`
    : 'This agent is not linked to any Skaile session yet; the owner links it in Skaile.'
  throw new SkaileError('unknown_peer', `unknown_peer: no linked Skaile session matches "${wanted}". ${known}`)
}
