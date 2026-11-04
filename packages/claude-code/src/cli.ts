import { isValidToken, type TokenStore } from './token-store.js'

/**
 * The plugin's small CLI.
 *
 * - `cli.cjs command` is what `/skaile` runs: it reads the command's arguments from stdin (so
 *   the token is never a process argument of node) and prints what the model should do next.
 * - `cli.cjs connect` is the terminal path: it reads the token from stdin (hidden when typed),
 *   so the token never enters the Claude Code conversation.
 * - `cli.cjs disconnect` removes the stored token.
 *
 * It never opens a connection to Skaile: an agent has one live connection, and a second one
 * would replace the MCP server's. Status and reconnect go through the MCP server's tools.
 */

export type CliIo = {
  readStdin(): Promise<string>
  /** Reads one line from a terminal without echoing it; null when stdin is not a terminal. */
  readSecretLine?(prompt: string): Promise<string> | null
  write(text: string): void
  tokens: TokenStore
  /** Path of this script, for the terminal command it prints. */
  cliPath: string
}

const USAGE = `Usage:
  /skaile connect <token>   store a Skaile remote-agent token (skr_…) and connect
  /skaile connect           show the terminal command that keeps the token out of this chat
  /skaile status            show whether Claude Code is connected, the agent and the linked sessions
  /skaile reconnect         reconnect (takes the connection over from another Claude Code session)
  /skaile disconnect        remove the stored token and disconnect`

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [mode] = argv
  if (mode === 'command') {
    const words = (await io.readStdin()).trim().split(/\s+/).filter(Boolean)
    return slashCommand(words, io)
  }
  if (mode === 'connect') {
    const typed = io.readSecretLine?.('Paste your Skaile remote-agent token (input hidden): ')
    const token = (typed ? await typed : await io.readStdin()).trim()
    if (!isValidToken(token)) {
      io.write('That is not a Skaile remote-agent token (it starts with skr_). Nothing was stored.\n')
      return 1
    }
    const stored = await io.tokens.write(token)
    io.write(`Stored the Skaile token in ${stored.detail}. In Claude Code, run /skaile reconnect to connect.\n`)
    return 0
  }
  if (mode === 'disconnect') {
    await io.tokens.clear()
    io.write('Removed the stored Skaile token.\n')
    return 0
  }
  io.write(`${USAGE}\n\nIn a terminal: node "${io.cliPath}" connect   (reads the token from stdin)\n`)
  return mode === undefined || mode === 'help' || mode === '--help' ? 0 : 1
}

async function slashCommand(words: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = words
  switch (sub) {
    case 'connect': {
      const token = rest[0]
      if (!token) {
        io.write(
          `To keep the token out of this conversation, the user runs this in a terminal and pastes the token when asked:\n\n  node "${io.cliPath}" connect\n\nThen /skaile reconnect here. Tell the user exactly that, and show the command.\n`,
        )
        return 0
      }
      if (rest.length > 1 || !isValidToken(token)) {
        io.write(
          'That is not a Skaile remote-agent token (it starts with skr_). Nothing was stored. Tell the user, without repeating what they typed.\n',
        )
        return 1
      }
      const stored = await io.tokens.write(token)
      io.write(
        `Stored the Skaile token in ${stored.detail}. NEXT: call the skaile_reconnect tool now and show the user its result. Never repeat the token.\n`,
      )
      return 0
    }
    case 'status':
    case undefined:
      io.write('NEXT: call the skaile_status tool and show the user its result.\n')
      return 0
    case 'reconnect':
      io.write('NEXT: call the skaile_reconnect tool and show the user its result.\n')
      return 0
    case 'disconnect':
      await io.tokens.clear()
      io.write(
        'Removed the stored Skaile token. NEXT: call the skaile_reconnect tool so this session drops its connection, and tell the user.\n',
      )
      return 0
    default:
      io.write(`Unknown /skaile command. Show the user this:\n\n${USAGE}\n`)
      return 1
  }
}
