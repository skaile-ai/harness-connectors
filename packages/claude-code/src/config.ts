export const DEFAULT_API_URL = 'https://platform-api.skaile.ai'

export type TransportMode = 'auto' | 'websocket' | 'long-poll'

export type Config = {
  /** Skaile API origin, e.g. `https://platform-api.skaile.ai`, without a trailing slash. */
  apiUrl: string
  /** `auto` tries the WebSocket first and falls back to long-poll when it cannot be reached. */
  transport: TransportMode
}

/**
 * Reads the configuration from the environment. `SKAILE_API_URL` overrides the server (for
 * staging or a self-hosted Skaile); `SKAILE_TRANSPORT` forces one transport.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = env.SKAILE_API_URL?.trim() || DEFAULT_API_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`SKAILE_API_URL is not a URL: ${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`SKAILE_API_URL must be an http(s) URL, got ${url.protocol}`)
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    // The token rides every request; plain http would send it in the clear.
    throw new Error('SKAILE_API_URL must use https (http is allowed only for localhost)')
  }
  const transport = env.SKAILE_TRANSPORT?.trim() || 'auto'
  if (transport !== 'auto' && transport !== 'websocket' && transport !== 'long-poll') {
    throw new Error(`SKAILE_TRANSPORT must be auto, websocket or long-poll, got ${transport}`)
  }
  return { apiUrl: url.origin + url.pathname.replace(/\/+$/, ''), transport }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}
