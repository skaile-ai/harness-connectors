import { runCli } from './cli.js'
import { createTokenStore } from './token-store.js'

/** Entry point of dist/cli.cjs; the logic is in cli.ts. */

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      data += chunk
      if (data.length > 64 * 1024) {
        reject(new Error('input too long'))
      }
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

function readSecretLine(prompt: string): Promise<string> | null {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    return null
  }
  return new Promise((resolve) => {
    process.stderr.write(prompt)
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    let value = ''
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          stdin.setRawMode(false)
          stdin.off('data', onData)
          stdin.pause()
          process.stderr.write('\n')
          resolve(value)
          return
        }
        if (char === '\u0003') {
          stdin.setRawMode(false)
          process.stderr.write('\n')
          process.exit(130)
        }
        value = char === '\u007f' || char === '\b' ? value.slice(0, -1) : value + char
      }
    }
    stdin.on('data', onData)
    stdin.resume()
  })
}

runCli(process.argv.slice(2), {
  readStdin,
  readSecretLine,
  write: (text) => process.stdout.write(text),
  tokens: createTokenStore(),
  cliPath: process.argv[1] ?? 'cli.cjs',
})
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stdout.write(`Skaile CLI failed: ${(error as Error).message}\n`)
    process.exitCode = 1
  })
