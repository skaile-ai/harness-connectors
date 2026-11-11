import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_API_URL, loadConfig, readSavedApiUrl, saveApiUrl } from '../src/config.js'
import { webSocketUrl } from '../src/transport/websocket.js'

describe('config', () => {
  it('defaults to the Skaile API', () => {
    expect(loadConfig({})).toEqual({ apiUrl: DEFAULT_API_URL, transport: 'auto' })
    expect(DEFAULT_API_URL).toBe('https://platform-api.skaile.ai')
    expect(webSocketUrl(DEFAULT_API_URL)).toBe('wss://platform-api.skaile.ai/harness/connect')
  })

  it('takes SKAILE_API_URL for one of Skaile’s API hosts, and SKAILE_TRANSPORT', () => {
    expect(
      loadConfig({ SKAILE_API_URL: 'https://staging-platform-api.skaile.ai/', SKAILE_TRANSPORT: 'long-poll' }),
    ).toEqual({ apiUrl: 'https://staging-platform-api.skaile.ai', transport: 'long-poll' })
    expect(loadConfig({ SKAILE_API_URL: 'https://platform-api.skaile.ai:443' }).apiUrl).toBe(DEFAULT_API_URL)
  })

  it('refuses any other host from the environment, so a project cannot point the token elsewhere', () => {
    for (const url of [
      'https://evil.example',
      'https://skaile.ai.evil.example',
      'https://evilskaile.ai',
      // Exact hosts only: another skaile.ai subdomain, the apex or another port is not the API.
      'https://skaile.ai',
      'https://uploads.skaile.ai',
      'https://platform-api.skaile.ai:8443',
      // localhost (any port: another local process may listen there) only once saved.
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://[::1]:3000',
    ]) {
      expect(() => loadConfig({ SKAILE_API_URL: url }), url).toThrow(/not a Skaile API host/)
    }
  })

  it('accepts localhost the user saved in a terminal, and from the environment only that one', () => {
    expect(loadConfig({}, 'http://localhost:3000').apiUrl).toBe('http://localhost:3000')
    expect(loadConfig({ SKAILE_API_URL: 'http://localhost:3000' }, 'http://localhost:3000').apiUrl).toBe(
      'http://localhost:3000',
    )
    expect(() => loadConfig({ SKAILE_API_URL: 'http://localhost:4000' }, 'http://localhost:3000')).toThrow(
      /not a Skaile API host/,
    )
  })

  it('accepts a foreign host the user saved in a terminal', () => {
    expect(loadConfig({}, 'https://skaile.corp.example').apiUrl).toBe('https://skaile.corp.example')
    expect(loadConfig({ SKAILE_API_URL: 'https://skaile.corp.example/' }, 'https://skaile.corp.example').apiUrl).toBe(
      'https://skaile.corp.example',
    )
    expect(() => loadConfig({ SKAILE_API_URL: 'https://evil.example' }, 'https://skaile.corp.example')).toThrow()
  })

  it('takes an origin only: a path on a trusted host is refused', () => {
    expect(() => loadConfig({ SKAILE_API_URL: 'https://platform-api.skaile.ai/other/route' })).toThrow(/origin only/)
    expect(() => loadConfig({}, 'http://localhost:3000/x')).toThrow(/origin only/)
    expect(() => loadConfig({}, 'https://skaile.corp.example/api')).toThrow(/origin only/)
  })

  it('refuses plain http to anything but localhost, credentials in the URL, and unknown transports', () => {
    expect(() => loadConfig({ SKAILE_API_URL: 'http://platform-api.skaile.ai' })).toThrow(/https/)
    expect(() => loadConfig({ SKAILE_API_URL: 'ftp://x' })).toThrow()
    expect(() => loadConfig({ SKAILE_API_URL: 'https://u:p@platform-api.skaile.ai' })).toThrow(/credentials/)
    expect(() => loadConfig({ SKAILE_TRANSPORT: 'carrier-pigeon' })).toThrow()
  })

  it('saves the trusted API URL in a 0600 file under ~/.config/skaile, and clears it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'skaile-home-'))
    expect(await readSavedApiUrl(home)).toBeNull()
    expect(await saveApiUrl('https://skaile.corp.example/', home)).toBe('https://skaile.corp.example')
    const file = join(home, '.config', 'skaile', 'api-url')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await readFile(file, 'utf8')).trim()).toBe('https://skaile.corp.example')
    expect(await readSavedApiUrl(home)).toBe('https://skaile.corp.example')
    await expect(saveApiUrl('http://plain.example', home)).rejects.toThrow(/https/)
    await saveApiUrl(null, home)
    expect(await readSavedApiUrl(home)).toBeNull()
    // A saved value that is no longer valid (an older one with a path) is an error, not the default host.
    await writeFile(file, 'https://skaile.corp.example/api\n')
    await expect(readSavedApiUrl(home)).rejects.toThrow(/not valid[\s\S]*origin only/)
  })
})
