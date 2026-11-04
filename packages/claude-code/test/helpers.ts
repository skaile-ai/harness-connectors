import { SkaileClient } from '../src/client.js'
import type { TransportMode } from '../src/config.js'
import type { TokenStore } from '../src/token-store.js'

export const TOKEN = `skr_${'a'.repeat(43)}`
export const OTHER_TOKEN = `skr_${'b'.repeat(43)}`

export class MemoryTokenStore implements TokenStore {
  constructor(public token: string | null = null) {}
  async read() {
    return this.token
  }
  async write(token: string) {
    this.token = token
    return { location: 'file' as const, detail: 'memory' }
  }
  async clear() {
    this.token = null
  }
}

export function makeClient(
  apiUrl: string,
  tokens: TokenStore,
  options: { transport?: TransportMode; heartbeatTimeoutMs?: number; askTimeoutMs?: number } = {},
): SkaileClient {
  return new SkaileClient({
    config: { apiUrl, transport: options.transport ?? 'auto' },
    tokens,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 90_000,
    requestTimeoutMs: 2_000,
    askTimeoutMs: options.askTimeoutMs ?? 5_000,
    backoffBaseMs: 20,
    backoffMaxMs: 200,
  })
}
