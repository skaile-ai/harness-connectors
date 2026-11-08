import { saveApiUrl } from './config.js'
import { isValidToken, type TokenStore } from './token-store.js'

/**
 * The plugin's small CLI.
 *
 * - `cli.cjs command <args>` is what `/skaile` runs, with the command's arguments as argv. It
 *   prints what the model should do next, and it never stores or replaces a token: the
 *   command's `allowed-tools` stay in force for the model's whole turn, so a prompt-injected
 *   model could run it too, with arguments of its choosing. A token typed after `/skaile connect`
 *   gets the terminal command instead, and is not stored.
 * - `cli.cjs connect` is the terminal path, and the only way to store a token: it reads the
 *   token from stdin (hidden when typed), so the token never enters the Claude Code conversation.
 * - `cli.cjs disconnect` removes the stored token.
 * - `cli.cjs set-api-url <url>|--clear` trusts a Skaile API host other than skaile.ai (a
 *   self-hosted Skaile). Terminal only, so neither a project's settings nor the model can set it.
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
  /** Replaced in tests. */
  saveApiUrl?: (url: string | null) => Promise<string | null>
}

const USAGE = `Usage:
  /skaile connect           show the terminal command that stores a Skaile remote-agent token
  /skaile status            show whether Claude Code is connected, the agent and the linked sessions
  /skaile reconnect         reconnect (takes the connection over from another Claude Code session)
  /skaile disconnect        remove the stored token and disconnect`

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [mode] = argv
  if (mode === 'command') {
    return slashCommand(argv.slice(1).filter(Boolean), io)
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
  if (mode === 'set-api-url') {
    const target = argv[1]
    if (!target) {
      io.write('Usage: set-api-url <https://your-skaile-api> | --clear\n')
      return 1
    }
    const saved = await (io.saveApiUrl ?? saveApiUrl)(target === '--clear' ? null : target)
    io.write(
      saved
        ? `Saved ${saved} as the Skaile API. The token goes to this host. Restart Claude Code to use it.\n`
        : 'Removed the saved Skaile API URL; the plugin uses https://platform-api.skaile.ai again after a restart.\n',
    )
    return 0
  }
  io.write(
    `${USAGE}\n\nIn a terminal:\n  node "${io.cliPath}" connect                 read the token from stdin\n  node "${io.cliPath}" set-api-url <url>       trust a self-hosted Skaile API (--clear to undo)\n`,
  )
  return mode === undefined || mode === 'help' || mode === '--help' ? 0 : 1
}

async function slashCommand(words: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = words
  switch (sub) {
    case 'connect': {
      const terminal = `the user runs this in a terminal and pastes the token when asked:\n\n  node "${io.cliPath}" connect\n\nThen /skaile reconnect here.`
      if (rest.length === 0) {
        io.write(`To store a Skaile token, ${terminal} Tell the user exactly that, and show the command.\n`)
        return 0
      }
      // Never stored from here, whatever it is (see the header): the terminal is the only path.
      io.write(
        `Nothing was stored: /skaile does not take a token. To store one, ${terminal} Tell the user exactly that and show the command, without repeating what they typed after connect. If it was a real token, it is now in this conversation; they can create a new one in Skaile.\n`,
      )
      return 1
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
