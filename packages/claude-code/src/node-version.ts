/**
 * The bundle targets Node 20.3+ (it uses `AbortSignal.any`), but `.mcp.json` and `/skaile` run
 * whatever `node` is first on PATH. Imported first by each entry point, so an older Node fails
 * at start with one clear line instead of a TypeError later, mid-connection.
 */
export const MIN_NODE_VERSION = '20.3.0'

/** True when `version` (like `v22.1.0` or `20.3.0`) is at least MIN_NODE_VERSION. */
export function isSupportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.replace(/^v/, '').split('.').map(Number)
  const [minMajor, minMinor, minPatch] = MIN_NODE_VERSION.split('.').map(Number) as [number, number, number]
  if (major !== minMajor) {
    return major > minMajor
  }
  if (minor !== minMinor) {
    return minor > minMinor
  }
  return patch >= minPatch
}

export function nodeVersionError(version: string, execPath: string): string {
  return `The Skaile plugin needs Node.js ${MIN_NODE_VERSION} or newer, but ${execPath} is ${version}. Install a current Node.js (22 LTS or newer) and put it first on PATH, then restart Claude Code.`
}

/** Exits the process (stderr only: stdout is the MCP channel) when this Node is too old. */
export function exitOnUnsupportedNode(): void {
  if (!isSupportedNodeVersion(process.version) || typeof AbortSignal.any !== 'function') {
    process.stderr.write(`[skaile] ${nodeVersionError(process.version, process.execPath)}\n`)
    process.exit(1)
  }
}

exitOnUnsupportedNode()
