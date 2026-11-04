import { spawn } from 'node:child_process'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * A remote-agent token: `skr_` and the base64url of 32 random bytes. The charset check also
 * keeps the token safe to hand to `security -i`, which reads it as part of a command line.
 */
export const TOKEN_PATTERN = /^skr_[A-Za-z0-9_-]{20,256}$/

const KEYCHAIN_SERVICE = 'skaile-harness'
const KEYCHAIN_ACCOUNT = 'default'
const KEYCHAIN_LABEL = 'Skaile remote agent token'

export type TokenLocation = 'keychain' | 'file'

export interface TokenStore {
  /** The stored token, or null. Never throws for a missing or unreadable store. */
  read(): Promise<string | null>
  /** Stores the token, in the OS keychain when one works, else in the 0600 file. */
  write(token: string): Promise<{ location: TokenLocation; detail: string }>
  /** Removes the token from every place it may be stored. */
  clear(): Promise<void>
}

export type RunResult = { code: number; stdout: string }
/**
 * Runs a program with `input` on its stdin. The token only ever travels through `input`,
 * never through `args`, so it does not show in `ps`.
 */
export type Runner = (command: string, args: string[], input: string) => Promise<RunResult>

export type TokenStoreOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  run?: Runner
}

export function isValidToken(token: string): boolean {
  return TOKEN_PATTERN.test(token)
}

/** `$XDG_CONFIG_HOME/skaile` or `~/.config/skaile`: always under the user's home, never the project. */
export function configDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME?.trim()
  return join(xdg?.startsWith('/') ? xdg : join(home, '.config'), 'skaile')
}

export function createTokenStore(options: TokenStoreOptions = {}): TokenStore {
  const platform = options.platform ?? process.platform
  const run = options.run ?? runProgram
  const dir = configDir(options.env ?? process.env, options.home ?? homedir())
  const file = join(dir, 'token')
  const keychain = keychainFor(platform, run)

  return {
    async read() {
      const fromKeychain = keychain ? await keychain.read().catch(() => null) : null
      if (fromKeychain && isValidToken(fromKeychain)) {
        return fromKeychain
      }
      try {
        const fromFile = (await readFile(file, 'utf8')).trim()
        return isValidToken(fromFile) ? fromFile : null
      } catch {
        return null
      }
    },

    async write(token) {
      if (!isValidToken(token)) {
        throw new Error('That is not a Skaile remote-agent token (it starts with skr_).')
      }
      if (keychain && (await keychain.write(token).catch(() => false))) {
        // A stale copy in the file would be read if the keychain later fails.
        await rm(file, { force: true })
        return { location: 'keychain', detail: keychain.name }
      }
      await writePrivateFile(dir, file, token)
      return { location: 'file', detail: file }
    },

    async clear() {
      if (keychain) {
        await keychain.clear().catch(() => undefined)
      }
      await rm(file, { force: true })
    },
  }
}

type Keychain = {
  name: string
  read(): Promise<string | null>
  /** True once the token is stored and reads back. */
  write(token: string): Promise<boolean>
  clear(): Promise<void>
}

function keychainFor(platform: NodeJS.Platform, run: Runner): Keychain | null {
  if (platform === 'darwin') {
    const read = async () => {
      const result = await run(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        '',
      )
      return result.code === 0 ? result.stdout.trim() || null : null
    }
    return {
      name: 'the macOS keychain',
      read,
      async write(token) {
        // `security -i` reads its command from stdin, so the token is not in any process's argv.
        const command = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -l "${KEYCHAIN_LABEL}" -w ${token}\n`
        const result = await run('security', ['-i'], command)
        return result.code === 0 && (await read()) === token
      },
      async clear() {
        await run('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT], '')
      },
    }
  }
  if (platform === 'linux') {
    const attributes = ['service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT]
    const read = async () => {
      const result = await run('secret-tool', ['lookup', ...attributes], '')
      return result.code === 0 ? result.stdout.trim() || null : null
    }
    return {
      name: 'the Secret Service keyring',
      read,
      async write(token) {
        // secret-tool reads the secret from stdin when it is not a terminal.
        const result = await run('secret-tool', ['store', `--label=${KEYCHAIN_LABEL}`, ...attributes], token)
        return result.code === 0 && (await read()) === token
      },
      async clear() {
        await run('secret-tool', ['clear', ...attributes], '')
      },
    }
  }
  return null
}

async function writePrivateFile(dir: string, file: string, token: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  // Created 0600, so the token is never readable by others, not even for a moment.
  const handle = await open(temp, 'w', 0o600)
  try {
    await handle.writeFile(`${token}\n`, 'utf8')
  } finally {
    await handle.close()
  }
  await chmod(temp, 0o600)
  await rename(temp, file)
}

/** Spawns without a shell; a missing program reads as a failure, so the caller falls back. */
export const runProgram: Runner = (command, args, input) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false })
    } catch {
      resolve({ code: -1, stdout: '' })
      return
    }
    let stdout = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout })
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(input)
  })
