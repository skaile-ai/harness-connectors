import { describe, expect, it } from 'vitest'
import { type CliIo, runCli } from '../src/cli.js'
import { MemoryTokenStore, TOKEN } from './helpers.js'

function io(stdin: string, secretLine?: string) {
  const out: string[] = []
  const tokens = new MemoryTokenStore(null)
  const value: CliIo = {
    readStdin: async () => stdin,
    readSecretLine: secretLine === undefined ? () => null : async () => secretLine,
    write: (text) => out.push(text),
    tokens,
    cliPath: '/plugin/dist/cli.cjs',
  }
  return { value, out, tokens }
}

describe('the /skaile command', () => {
  it('connect <token> stores the token, never echoes it, and asks for a reconnect', async () => {
    const { value, out, tokens } = io(`connect ${TOKEN}`)
    expect(await runCli(['command'], value)).toBe(0)
    expect(tokens.token).toBe(TOKEN)
    expect(out.join('')).toMatch(/NEXT: call the skaile_reconnect tool/)
    expect(out.join('')).not.toContain('skr_')
  })

  it('connect with a bad token stores nothing and does not repeat it', async () => {
    const { value, out, tokens } = io('connect skr_nope')
    expect(await runCli(['command'], value)).toBe(1)
    expect(tokens.token).toBeNull()
    expect(out.join('')).not.toContain('skr_nope')
  })

  it('connect without a token shows the terminal command', async () => {
    const { value, out } = io('connect')
    await runCli(['command'], value)
    expect(out.join('')).toContain('node "/plugin/dist/cli.cjs" connect')
  })

  it('status and reconnect go through the MCP server, not a second connection', async () => {
    for (const [sub, tool] of [
      ['status', 'skaile_status'],
      ['', 'skaile_status'],
      ['reconnect', 'skaile_reconnect'],
    ]) {
      const { value, out } = io(sub as string)
      await runCli(['command'], value)
      expect(out.join('')).toContain(`NEXT: call the ${tool} tool`)
    }
  })

  it('disconnect clears the token', async () => {
    const { value, tokens } = io('disconnect')
    tokens.token = TOKEN
    await runCli(['command'], value)
    expect(tokens.token).toBeNull()
  })

  it('an unknown subcommand prints the usage', async () => {
    const { value, out } = io('frobnicate')
    expect(await runCli(['command'], value)).toBe(1)
    expect(out.join('')).toMatch(/Usage:/)
  })
})

describe('the terminal path', () => {
  it('reads the token from stdin', async () => {
    const { value, tokens } = io(`${TOKEN}\n`)
    expect(await runCli(['connect'], value)).toBe(0)
    expect(tokens.token).toBe(TOKEN)
  })

  it('reads a typed token without echo when stdin is a terminal', async () => {
    const { value, tokens, out } = io('', TOKEN)
    expect(await runCli(['connect'], value)).toBe(0)
    expect(tokens.token).toBe(TOKEN)
    expect(out.join('')).not.toContain('skr_')
  })

  it('refuses something that is not a token', async () => {
    const { value, tokens } = io('hello')
    expect(await runCli(['connect'], value)).toBe(1)
    expect(tokens.token).toBeNull()
  })
})
