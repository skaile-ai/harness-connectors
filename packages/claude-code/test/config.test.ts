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

  it('takes SKAILE_API_URL for a Skaile host or localhost, and SKAILE_TRANSPORT', () => {
    expect(loadConfig({ SKAILE_API_URL: 'https://staging-api.skaile.ai/', SKAILE_TRANSPORT: 'long-poll' })).toEqual({
      apiUrl: 'https://staging-api.skaile.ai',
      transport: 'long-poll',
    })
    expect(loadConfig({ SKAILE_API_URL: 'http://localhost:3000' }).apiUrl).toBe('http://localhost:3000')
  })

  it('refuses a foreign host from the environment, so a project cannot send the token elsewhere', () => {
    expect(() => loadConfig({ SKAILE_API_URL: 'https://evil.example' })).toThrow(/not a Skaile host/)
    expect(() => loadConfig({ SKAILE_API_URL: 'https://skaile.ai.evil.example' })).toThrow(/not a Skaile host/)
    expect(() => loadConfig({ SKAILE_API_URL: 'https://evilskaile.ai' })).toThrow(/not a Skaile host/)
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
    expect(() => loadConfig({ SKAILE_API_URL: 'http://localhost:3000/x' })).toThrow(/origin only/)
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
