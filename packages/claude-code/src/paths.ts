import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * The user's home directory from the account database, not `$HOME`: a project's settings can
 * set environment variables for the plugin, and must not be able to move the token or the
 * trusted API URL into the project directory.
 */
export function realHome(): string {
  try {
    return userInfo().homedir || homedir()
  } catch {
    return homedir()
  }
}

/** `~/.config/skaile`: where the token file and the saved API URL live. Never the project directory. */
export function configDir(home: string = realHome()): string {
  return join(home, '.config', 'skaile')
}
