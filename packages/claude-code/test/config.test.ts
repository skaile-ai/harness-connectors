import { describe, expect, it } from 'vitest'
import { DEFAULT_API_URL, loadConfig } from '../src/config.js'
import { webSocketUrl } from '../src/transport/websocket.js'

describe('config', () => {
  it('defaults to the Skaile API', () => {
    expect(loadConfig({})).toEqual({ apiUrl: DEFAULT_API_URL, transport: 'auto' })
    expect(DEFAULT_API_URL).toBe('https://platform-api.skaile.ai')
    expect(webSocketUrl(DEFAULT_API_URL)).toBe('wss://platform-api.skaile.ai/harness/connect')
  })

  it('takes SKAILE_API_URL and SKAILE_TRANSPORT', () => {
    expect(loadConfig({ SKAILE_API_URL: 'https://staging.example.com/', SKAILE_TRANSPORT: 'long-poll' })).toEqual({
      apiUrl: 'https://staging.example.com',
      transport: 'long-poll',
    })
    expect(loadConfig({ SKAILE_API_URL: 'http://localhost:3000' }).apiUrl).toBe('http://localhost:3000')
  })

  it('refuses plain http to anything but localhost, so the token is never sent in the clear', () => {
    expect(() => loadConfig({ SKAILE_API_URL: 'http://platform-api.skaile.ai' })).toThrow(/https/)
    expect(() => loadConfig({ SKAILE_API_URL: 'ftp://x' })).toThrow()
    expect(() => loadConfig({ SKAILE_TRANSPORT: 'carrier-pigeon' })).toThrow()
  })
})
