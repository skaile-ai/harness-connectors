import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configDir } from '../src/paths.js'
import { createTokenStore, isValidToken, type Runner } from '../src/token-store.js'
import { TOKEN } from './helpers.js'

type Call = { command: string; args: string[]; input: string }

/** A fake `security` / `secret-tool` that keeps one secret, and records every call. */
function fakeKeychain(options: { broken?: boolean } = {}) {
  const calls: Call[] = []
  let secret: string | null = null
  const run: Runner = async (command, args, input) => {
    calls.push({ command, args, input })
    if (options.broken) {
      return { code: -1, stdout: '' }
    }
    if (command === 'security') {
      if (args[0] === '-i') {
        secret = /-w (\S+)\n$/.exec(input)?.[1] ?? null
        return { code: 0, stdout: '' }
      }
      if (args[0] === 'find-generic-password') {
        return secret ? { code: 0, stdout: `${secret}\n` } : { code: 44, stdout: '' }
      }
      secret = null
      return { code: 0, stdout: '' }
    }
    if (args[0] === 'store') {
      secret = input
      return { code: 0, stdout: '' }
    }
    if (args[0] === 'lookup') {
      return secret ? { code: 0, stdout: secret } : { code: 1, stdout: '' }
    }
    secret = null
    return { code: 0, stdout: '' }
  }
  return { calls, run }
}

async function home() {
  return mkdtemp(join(tmpdir(), 'skaile-home-'))
}

describe('token store', () => {
  it.each(['darwin', 'linux'] as const)(
    'stores in the %s keychain through stdin, never as an argument',
    async (platform) => {
      const keychain = fakeKeychain()
      const store = createTokenStore({ platform, home: await home(), run: keychain.run })
      expect(await store.write(TOKEN)).toMatchObject({ location: 'keychain' })
      expect(await store.read()).toBe(TOKEN)
      for (const call of keychain.calls) {
        expect(call.args.join(' ')).not.toContain('skr_')
      }
      expect(keychain.calls.some((call) => call.input.includes(TOKEN))).toBe(true)
      await store.clear()
      expect(await store.read()).toBeNull()
    },
  )

  it('falls back to a 0600 file under ~/.config/skaile when no keychain works', async () => {
    const dir = await home()
    const store = createTokenStore({ platform: 'linux', home: dir, run: fakeKeychain({ broken: true }).run })
    const stored = await store.write(TOKEN)
    const file = join(dir, '.config', 'skaile', 'token')
    expect(stored).toEqual({ location: 'file', detail: file })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, '.config', 'skaile'))).mode & 0o777).toBe(0o700)
    expect((await readFile(file, 'utf8')).trim()).toBe(TOKEN)
    expect(await store.read()).toBe(TOKEN)
    await store.clear()
    expect(await store.read()).toBeNull()
  })

  it('uses the file on platforms without a supported keychain', async () => {
    const keychain = fakeKeychain()
    const store = createTokenStore({ platform: 'win32', home: await home(), run: keychain.run })
    expect(await store.write(TOKEN)).toMatchObject({ location: 'file' })
    expect(keychain.calls).toHaveLength(0)
  })

  it('removes a stale file copy once the keychain holds the token', async () => {
    const dir = await home()
    const broken = createTokenStore({ platform: 'darwin', home: dir, run: fakeKeychain({ broken: true }).run })
    await broken.write(TOKEN)
    const working = createTokenStore({ platform: 'darwin', home: dir, run: fakeKeychain().run })
    await working.write(TOKEN)
    await expect(stat(join(dir, '.config', 'skaile', 'token'))).rejects.toThrow()
  })

  it('refuses anything that is not a remote-agent token, and ignores a corrupt file', async () => {
    const dir = await home()
    const store = createTokenStore({ platform: 'win32', home: dir })
    await expect(store.write('skr_short')).rejects.toThrow(/starts with skr_/)
    await expect(store.write(`skr_${'a'.repeat(30)} -w evil`)).rejects.toThrow()
    await store.write(TOKEN)
    await writeFile(join(dir, '.config', 'skaile', 'token'), 'garbage')
    expect(await store.read()).toBeNull()
    expect(isValidToken(TOKEN)).toBe(true)
    expect(isValidToken(`Bearer ${TOKEN}`)).toBe(false)
  })

  it('keeps the file under the home directory and ignores XDG_CONFIG_HOME and HOME', () => {
    expect(configDir('/home/u')).toBe('/home/u/.config/skaile')
    const before = { xdg: process.env.XDG_CONFIG_HOME, home: process.env.HOME }
    process.env.XDG_CONFIG_HOME = process.cwd()
    process.env.HOME = process.cwd()
    try {
      // A project's settings could set these; the directory still comes from the account database.
      expect(configDir().startsWith(process.cwd())).toBe(false)
    } finally {
      for (const [key, value] of [
        ['XDG_CONFIG_HOME', before.xdg],
        ['HOME', before.home],
      ] as const) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })
})
