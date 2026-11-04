// Bundles the MCP server and the CLI, with every dependency, into dist/. Plugins install from
// git with no `npm install`, so dist/ is committed; CI fails when it is stale.
import { build } from 'esbuild'

await build({
  entryPoints: { 'mcp-server': 'src/mcp-server.ts', cli: 'src/cli-main.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: true,
  legalComments: 'eof',
  // Optional native speed-ups that `ws` loads inside a try/catch.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'info',
})
