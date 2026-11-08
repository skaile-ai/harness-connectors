import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { configDir, realHome } from './paths.js'
import { writePrivateFile } from './token-store.js'

export const DEFAULT_API_URL = 'https://platform-api.skaile.ai'

export type TransportMode = 'auto' | 'websocket' | 'long-poll'

export type Config = {
  /** Skaile API origin, e.g. `https://platform-api.skaile.ai`: no path, no trailing slash. */
  apiUrl: string
  /** `auto` tries the WebSocket first and falls back to long-poll when it cannot be reached. */
  transport: TransportMode
}

/**
 * Reads the configuration. `SKAILE_API_URL` picks the server and `SKAILE_TRANSPORT` forces one
 * transport. The token goes to the API host on every connect, and a project's settings can set
 * environment variables, so the environment alone may name only one of Skaile's own API hosts
 * (`TRUSTED_API_HOSTS`, https). Any other host, localhost included, must first be saved by the
 * user in a terminal (`cli.cjs set-api-url`); `savedApiUrl` is that value, and the environment
 * may then name it too.
 *
 * This guards the API URL only. A project's settings can still set other variables the plugin's
 * `node` process obeys (`NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `PATH`), and through them load code
 * or trust a proxy that reads the token. Open only projects you trust while the plugin holds a
 * token (see the README).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, savedApiUrl: string | null = null): Config {
  const apiUrl = normalizeApiUrl(env.SKAILE_API_URL?.trim() || savedApiUrl || DEFAULT_API_URL)
  if (!isTrustedHost(new URL(apiUrl)) && apiUrl !== (savedApiUrl && normalizeApiUrl(savedApiUrl))) {
    throw new Error(
      `SKAILE_API_URL points at ${new URL(apiUrl).host}, which is not a Skaile API host. To use it, save it in a terminal: node "<plugin>/dist/cli.cjs" set-api-url ${apiUrl}`,
    )
  }
  const transport = env.SKAILE_TRANSPORT?.trim() || 'auto'
  if (transport !== 'auto' && transport !== 'websocket' && transport !== 'long-poll') {
    throw new Error(`SKAILE_TRANSPORT must be auto, websocket or long-poll, got ${transport}`)
  }
  return { apiUrl, transport }
}

/**
 * An http(s) origin, nothing more: the plugin appends `/harness/...` itself, so a path would only
 * let an override point the token at another route on a trusted host. Throws on anything else.
 */
export function normalizeApiUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`The Skaile API URL is not a URL: ${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`The Skaile API URL must be an http(s) URL, got ${url.protocol}`)
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    // The token rides every request; plain http would send it in the clear.
    throw new Error('The Skaile API URL must use https (http is allowed only for localhost)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The Skaile API URL must not carry credentials, a query or a fragment')
  }
  if (url.pathname !== '/') {
    throw new Error(
      `The Skaile API URL must be an origin only (like https://platform-api.skaile.ai), without the path ${url.pathname}`,
    )
  }
  return url.origin
}

/** Skaile's own API hosts: the only ones the environment may name without a saved URL. */
export const TRUSTED_API_HOSTS: readonly string[] = ['platform-api.skaile.ai', 'staging-platform-api.skaile.ai']

function isTrustedHost(url: URL): boolean {
  // `url.host` keeps a non-default port, so `platform-api.skaile.ai:8443` is not trusted either.
  return url.protocol === 'https:' && TRUSTED_API_HOSTS.includes(url.host)
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

// ── The saved API URL ─────────────────────────────────────────────────────────

function apiUrlFile(home: string): string {
  return join(configDir(home), 'api-url')
}

/**
 * The API URL the user saved with `set-api-url`, or null when none is saved. A saved value that
 * is no longer valid throws, rather than falling back to the default host with that user's token.
 */
export async function readSavedApiUrl(home: string = realHome()): Promise<string | null> {
  let raw: string
  try {
    raw = await readFile(apiUrlFile(home), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw new Error(`Cannot read the saved Skaile API URL (${apiUrlFile(home)}): ${(error as Error).message}`)
  }
  try {
    return normalizeApiUrl(raw.trim())
  } catch (error) {
    throw new Error(
      `The saved Skaile API URL in ${apiUrlFile(home)} is not valid: ${(error as Error).message}. Save it again in a terminal with set-api-url, or remove it with set-api-url --clear.`,
    )
  }
}

/** Saves (or with null, removes) the trusted API URL. Returns the normalized URL. */
export async function saveApiUrl(raw: string | null, home: string = realHome()): Promise<string | null> {
  if (raw === null) {
    await rm(apiUrlFile(home), { force: true })
    return null
  }
  const apiUrl = normalizeApiUrl(raw.trim())
  await writePrivateFile(configDir(home), apiUrlFile(home), `${apiUrl}\n`)
  return apiUrl
}
