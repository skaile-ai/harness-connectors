import { hookOwners, inboxReminder, readInboxState } from './inbox-state.js'

/**
 * The plugin's UserPromptSubmit hook: when questions or messages from Skaile are waiting, it
 * prints one line, which Claude Code adds to the context of the prompt. It never fails the prompt.
 */
try {
  const state = hookOwners()
    .map((owner) => readInboxState(owner))
    .find((found) => found !== null)
  const line = inboxReminder(state ?? null)
  if (line) {
    process.stdout.write(`${line}\n`)
  }
} catch {
  // A hook error must never block the user's prompt.
}
process.exitCode = 0
