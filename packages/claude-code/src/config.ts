import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { configDir, realHome } from './paths.js'
import { writePrivateFile } from './token-store.js'

export const DEFAULT_API_URL = 'https://platform-api.skaile.ai'

export type TransportMode = 'auto' | 'websocket' | 'long-poll'

export type Config = {
  /** Skaile API origin, e.g. `https://platform-api.skaile.ai`, without a trailing slash. */
  apiUrl: string
  /** `auto` tries the WebSocket first and falls back to long-poll when it cannot be reached. */
  transport: TransportMode
}

/**
 * Reads the configuration. `SKAILE_API_URL` picks the server and `SKAILE_TRANSPORT` forces one
 * transport. The token goes to the API host on every connect, so the environment alone may name
 * only a Skaile host (`skaile.ai` and its subdomains) or localhost: a project's settings can set
 * environment variables, and must not be able to send the token elsewhere. Any other host (a
 * self-hosted Skaile) must first be saved by the user in a terminal (`cli.cjs set-api-url`);
 * `savedApiUrl` is that value, and the environment may then name it too.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, savedApiUrl: string | null = null): Config {
  const apiUrl = normalizeApiUrl(env.SKAILE_API_URL?.trim() || savedApiUrl || DEFAULT_API_URL)
  if (!isTrustedHost(new URL(apiUrl)) && apiUrl !== (savedApiUrl && normalizeApiUrl(savedApiUrl))) {
    throw new Error(
      `SKAILE_API_URL points at ${new URL(apiUrl).host}, which is not a Skaile host. To use it, save it in a terminal: node "<plugin>/dist/cli.cjs" set-api-url ${apiUrl}`,
    )
  }
  const transport = env.SKAILE_TRANSPORT?.trim() || 'auto'
  if (transport !== 'auto' && transport !== 'websocket' && transport !== 'long-poll') {
    throw new Error(`SKAILE_TRANSPORT must be auto, websocket or long-poll, got ${transport}`)
  }
  return { apiUrl, transport }
}

/** An http(s) origin plus path, without a trailing slash. Throws on anything else. */
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
  return url.origin + url.pathname.replace(/\/+$/, '')
}

function isTrustedHost(url: URL): boolean {
  if (isLoopback(url.hostname)) {
    return true
  }
  return url.protocol === 'https:' && (url.hostname === 'skaile.ai' || url.hostname.endsWith('.skaile.ai'))
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

// ── The saved API URL ─────────────────────────────────────────────────────────

function apiUrlFile(home: string): string {
  return join(configDir(home), 'api-url')
}

/** The API URL the user saved with `set-api-url`, or null. */
export async function readSavedApiUrl(home: string = realHome()): Promise<string | null> {
  try {
    return normalizeApiUrl((await readFile(apiUrlFile(home), 'utf8')).trim())
  } catch {
    return null
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
