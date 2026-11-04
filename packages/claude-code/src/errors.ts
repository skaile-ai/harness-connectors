import type { HarnessChannelErrorCode } from '@skaile/harness-protocol'

/** Server codes plus the ones this client raises itself. */
export type SkaileErrorCode =
  | HarnessChannelErrorCode
  | 'not_connected'
  | 'no_token'
  | 'replaced'
  | 'unknown_peer'
  | 'ambiguous_peer'
  | 'invalid_argument'

/** An error the tools hand to the model as a clear sentence. `code` is what callers branch on. */
export class SkaileError extends Error {
  constructor(
    readonly code: SkaileErrorCode,
    message?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message ?? describeError(code, undefined, retryAfterMs))
    this.name = 'SkaileError'
  }
}

/** The sentence the model sees for a code. `detail` is the server's own message, when one came. */
export function describeError(code: SkaileErrorCode, detail?: string, retryAfterMs?: number): string {
  switch (code) {
    case 'not_linked':
      return 'not_linked: this agent is not linked to that Skaile session, or the link was removed. Call list_skaile_peers for the sessions it can reach; the owner links more in Skaile.'
    case 'peer_offline':
      return 'peer_offline: the Skaile session cannot take a message right now (it is closed, or the connection dropped while waiting). Try again later.'
    case 'revoked':
      return 'revoked: this agent was revoked in Skaile, so the connection is closed. The user needs a new remote-agent token from Skaile and then runs /skaile connect.'
    case 'unsupported_version':
      return 'unsupported_version: Skaile does not accept this plugin’s protocol version (1.0). The user needs to update the Skaile Claude Code plugin.'
    case 'unauthorized':
      return 'unauthorized: Skaile has refused the token for over 5 minutes (it was rotated, or its owner lost access to the agent). The user runs /skaile connect with a current token, or /skaile reconnect to try the same token again.'
    case 'replaced':
      return 'replaced: another Claude Code session took over this agent’s Skaile connection (an agent has one live connection, the newest). Run /skaile reconnect in this session to take it back.'
    case 'no_token':
      return 'not_connected: no Skaile token is stored. The user runs /skaile connect <token> (or the terminal command that /skaile connect without a token prints).'
    case 'not_connected':
      return `not_connected: not connected to Skaile${detail ? ` (${detail})` : ''}. It keeps retrying; /skaile status shows the state.`
    case 'rate_limited':
      return retryAfterMs !== undefined
        ? `rate_limited: too many messages; try again in ${Math.ceil(retryAfterMs / 1000)} s.`
        : 'rate_limited: too many messages into that session with no reply from a person there. Wait until a person replies in it.'
    case 'timeout':
      return 'timeout: the Skaile session did not answer in time, and the question is closed. Ask again or send a follow-up later.'
    case 'invalid_frame':
    case 'payload_too_large':
    case 'unknown_peer':
    case 'ambiguous_peer':
    case 'invalid_argument':
      return `${code}: ${detail ?? 'the request was refused'}`
  }
}
