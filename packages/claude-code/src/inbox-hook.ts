import { inboxReminder, readInboxState } from './inbox-state.js'

/**
 * The plugin's UserPromptSubmit hook: when questions or messages from Skaile are waiting, it
 * prints one line, which Claude Code adds to the context of the prompt. It never fails the prompt.
 */
try {
  const line = inboxReminder(readInboxState())
  if (line) {
    process.stdout.write(`${line}\n`)
  }
} catch {
  // A hook error must never block the user's prompt.
}
process.exitCode = 0
