import { saveApiUrl } from './config.js'
import { isValidToken, type TokenStore } from './token-store.js'

/**
 * The plugin's small CLI.
 *
 * - `cli.cjs command` is what `/skaile` runs, with no arguments: it prints, per subcommand, what
 *   the model should do next. The user's words reach the model in the command's prompt, never a
 *   shell or a process argument, so a token typed after `/skaile connect` stays out of argv.
 *   `command <subcommand>` gives that one line. It never stores, replaces or removes a token:
 *   the command's `allowed-tools` stay in force for the model's whole turn, so a prompt-injected
 *   model could run it too.
 * - `cli.cjs connect` is the terminal path, and the only way to store a token: it reads the
 *   token from stdin (hidden when typed), so the token never enters the Claude Code conversation.
 * - `cli.cjs disconnect` removes the stored token. Terminal only, like `connect`.
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
  /skaile disconnect        show the terminal command that removes the stored token`

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

const connectLine = (io: CliIo) =>
  `the user runs this in a terminal and pastes the token when asked:\n\n  node "${io.cliPath}" connect\n\nThen /skaile reconnect here.`

/** Anything the user typed that looks like a Skaile token, valid or not: it is now in the conversation. */
const looksLikeToken = (word: string) => word.startsWith('skr_')

const tokenReply = (io: CliIo) =>
  `Nothing was stored: /skaile does not take a token. To store one, ${connectLine(io)} Tell the user exactly that and show the command, without repeating what they typed. If it was a real token, it is now in this conversation; they can create a new one in Skaile.\n`

const disconnectLine = (io: CliIo) =>
  `the user runs this in a terminal:\n\n  node "${io.cliPath}" disconnect\n\nThen /skaile reconnect here, so this session drops its connection.`

function guide(io: CliIo): string {
  return [
    'First: if anything the user typed after /skaile starts with skr_ (a Skaile token), whatever the subcommand, or none: do not call any tool and do not repeat it. Nothing was stored: /skaile does not take a token. To store one, ' +
      `${connectLine(io)} Tell the user exactly that and show the command. If it was a real token, it is now in this conversation, so they can create a new one in Skaile.`,
    '',
    'Otherwise, for each /skaile subcommand, do this:',
    '',
    `- connect: to store a Skaile token, ${connectLine(io)} Tell the user exactly that and show the command. If they typed anything after connect, nothing was stored: do not repeat it, and if it was a real token, it is now in this conversation, so they can create a new one in Skaile.`,
    '- status (or nothing): call the skaile_status tool and show the user its result.',
    '- reconnect: call the skaile_reconnect tool and show the user its result.',
    `- disconnect: to remove the stored token, ${disconnectLine(io)} Tell the user exactly that and show the command.`,
    `- anything else: show the user this:\n\n${USAGE}`,
    '',
  ].join('\n')
}

async function slashCommand(words: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = words
  // A token anywhere (bare, after status, …) gets the token reply, never the subcommand's line.
  if (words.some(looksLikeToken)) {
    io.write(tokenReply(io))
    return 1
  }
  switch (sub) {
    case undefined:
      io.write(guide(io))
      return 0
    case 'connect': {
      if (rest.length === 0) {
        io.write(`To store a Skaile token, ${connectLine(io)} Tell the user exactly that, and show the command.\n`)
        return 0
      }
      // Never stored from here, whatever it is (see the header): the terminal is the only path.
      io.write(tokenReply(io))
      return 1
    }
    case 'status':
      io.write('NEXT: call the skaile_status tool and show the user its result.\n')
      return 0
    case 'reconnect':
      io.write('NEXT: call the skaile_reconnect tool and show the user its result.\n')
      return 0
    case 'disconnect':
      // Removing the token is terminal only too: a prompt-injected model must not be able to drop it.
      io.write(
        `To remove the stored Skaile token, ${disconnectLine(io)} Tell the user exactly that, and show the command.\n`,
      )
      return 0
    default:
      io.write(`Unknown /skaile command. Show the user this:\n\n${USAGE}\n`)
      return 1
  }
}
