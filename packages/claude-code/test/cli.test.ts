import { describe, expect, it } from 'vitest'
import { type CliIo, runCli } from '../src/cli.js'
import { MemoryTokenStore, OTHER_TOKEN, TOKEN } from './helpers.js'

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
  it('connect <token> stores nothing, never echoes it, and gives the terminal command', async () => {
    for (const args of [
      ['connect', TOKEN],
      ['connect', 'skr_nope'],
      ['connect', TOKEN, 'extra'],
    ]) {
      const { value, out, tokens } = io('')
      expect(await runCli(['command', ...args], value)).toBe(1)
      expect(tokens.token).toBeNull()
      expect(out.join('')).toContain('node "/plugin/dist/cli.cjs" connect')
      expect(out.join('')).toMatch(/Nothing was stored/)
      expect(out.join('')).not.toContain('skr_')
    }
  })

  it('connect without a token shows the terminal command', async () => {
    const { value, out } = io('')
    expect(await runCli(['command', 'connect'], value)).toBe(0)
    expect(out.join('')).toContain('node "/plugin/dist/cli.cjs" connect')
  })

  it('cannot store or replace a token, whatever the model passes, on argv or stdin', async () => {
    // allowed-tools let a prompt-injected model run `cli.cjs command` during the turn, and the
    // user can approve other arguments.
    const tries = [
      ['connect', OTHER_TOKEN],
      [`connect ${OTHER_TOKEN}`],
      ['set-api-url', 'https://evil.example'],
      ['status', OTHER_TOKEN],
      ['disconnect'],
      [OTHER_TOKEN],
      [],
    ]
    for (const args of tries) {
      const { value, tokens } = io(`connect ${OTHER_TOKEN}\n${OTHER_TOKEN}\n`, OTHER_TOKEN)
      tokens.token = TOKEN
      value.saveApiUrl = async () => {
        throw new Error('must not be called')
      }
      const writes: string[] = []
      tokens.write = async (token: string) => {
        writes.push(token)
        return { location: 'file' as const, detail: 'memory' }
      }
      tokens.clear = async () => {
        writes.push('clear')
      }
      await runCli(['command', ...args], value)
      expect(writes, args.join(' ')).toEqual([])
      expect(tokens.token, args.join(' ')).toBe(TOKEN)
    }
  })

  it('status and reconnect go through the MCP server, not a second connection', async () => {
    for (const [sub, tool] of [
      ['status', 'skaile_status'],
      ['reconnect', 'skaile_reconnect'],
    ]) {
      const { value, out } = io('')
      await runCli(['command', sub as string], value)
      expect(out.join('')).toContain(`NEXT: call the ${tool} tool`)
    }
  })

  it('disconnect keeps the token and gives the terminal command', async () => {
    const { value, tokens, out } = io('')
    tokens.token = TOKEN
    expect(await runCli(['command', 'disconnect'], value)).toBe(0)
    expect(tokens.token).toBe(TOKEN)
    expect(out.join('')).toContain('node "/plugin/dist/cli.cjs" disconnect')
  })

  it('without arguments prints the guide for every subcommand, as /skaile runs it', async () => {
    const { value, out } = io('')
    expect(await runCli(['command'], value)).toBe(0)
    const text = out.join('')
    expect(text).toContain('node "/plugin/dist/cli.cjs" connect')
    expect(text).toContain('node "/plugin/dist/cli.cjs" disconnect')
    expect(text).toContain('call the skaile_status tool')
    expect(text).toContain('call the skaile_reconnect tool')
    expect(text).toMatch(/Usage:/)
  })

  it('the slash command passes no arguments to a shell or a process', async () => {
    const { readFile } = await import('node:fs/promises')
    const md = await readFile(new URL('../commands/skaile.md', import.meta.url), 'utf8')
    const shellLines = md.split('\n').filter((line) => line.startsWith('!') || line.startsWith('allowed-tools:'))
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's own placeholder, kept literal
    const root = '${CLAUDE_PLUGIN_ROOT}'
    expect(shellLines).toEqual([
      `allowed-tools: Bash(node "${root}/dist/cli.cjs" command)`,
      `!\`node "${root}/dist/cli.cjs" command\``,
    ])
    expect(md).not.toMatch(/printf/)
  })

  it('an unknown subcommand prints the usage', async () => {
    const { value, out } = io('')
    expect(await runCli(['command', 'frobnicate'], value)).toBe(1)
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

describe('set-api-url', () => {
  it('saves a trusted API URL from the terminal and clears it', async () => {
    const saved: (string | null)[] = []
    const { value, out } = io('')
    value.saveApiUrl = async (url) => {
      saved.push(url)
      return url
    }
    expect(await runCli(['set-api-url', 'https://skaile.corp.example'], value)).toBe(0)
    expect(await runCli(['set-api-url', '--clear'], value)).toBe(0)
    expect(saved).toEqual(['https://skaile.corp.example', null])
    expect(out.join('')).toMatch(/Saved https:\/\/skaile\.corp\.example/)
  })

  it('is not reachable from the /skaile command', async () => {
    const { value, out } = io('')
    value.saveApiUrl = async () => {
      throw new Error('must not be called')
    }
    expect(await runCli(['command', 'set-api-url', 'https://evil.example'], value)).toBe(1)
    expect(out.join('')).toMatch(/Unknown \/skaile command/)
  })
})
