// SPDX-License-Identifier: Apache-2.0
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { HarnessChannelHelloFrame } from '@skaile/harness-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { clientLabelFor } from '../src/client.js'
import { SkaileError } from '../src/errors.js'
import { startPlugin } from '../src/plugin.js'
import { statusText } from '../src/tools.js'
import { FakeServer } from './fake-server.js'
import { MemoryTokenStore, makeClient, TOKEN } from './helpers.js'

/**
 * One live connection per agent, taken over only on request: a session that never uses Skaile
 * never connects, a plain connect while another is live is refused with `in_use`, and
 * `reconnect()` takes the connection over.
 */

let server: FakeServer
let cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup()
  }
  cleanups = []
  await server?.stop()
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.each(['websocket', 'long-poll'] as const)('explicit takeover over %s', (transport) => {
  async function setup() {
    server = await new FakeServer({
      agents: { [TOKEN]: { agentId: 'ra_1' } },
      peers: [{ sessionId: 'sess-billing', name: 'Billing', online: true }],
    }).start()
  }

  function client(label: string, tokens = new MemoryTokenStore(TOKEN)) {
    const c = makeClient(server.url, tokens, { transport, clientLabel: label })
    cleanups.push(() => c.close())
    return c
  }

  const hellos = () => server.connections.map((c) => c.received[0] as HarnessChannelHelloFrame)

  it('a started plugin does not connect; the first tool call does', async () => {
    await setup()
    const claude = new Client({ name: 'claude-code-stand-in', version: '1.0.0' })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const plugin = await startPlugin({
      env: { SKAILE_TRANSPORT: transport },
      savedApiUrl: server.url,
      tokens: new MemoryTokenStore(TOKEN),
      transport: serverSide,
      owner: 2_000_000_001,
      cwd: '/home/ada/billing',
      log: () => undefined,
    })
    await claude.connect(clientSide)
    cleanups.push(async () => {
      await claude.close()
      await plugin.shutdown()
    })
    const skaile = plugin.client
    if (!skaile) {
      throw new Error('expected a client')
    }

    await pause(200)
    expect(server.connectAttempts).toHaveLength(0)
    const status = await claude.callTool({ name: 'skaile_status', arguments: {} })
    expect(JSON.stringify(status.content)).toMatch(/connects on the first Skaile tool call/)
    expect(server.connectAttempts).toHaveLength(0)

    const peers = await claude.callTool({ name: 'list_skaile_peers', arguments: {} })
    expect(JSON.stringify(peers.content)).toContain('Billing')
    expect(skaile.getStatus()).toMatchObject({ state: 'connected' })
    expect(hellos()[0]).toMatchObject({
      protocolVersion: '1.1',
      clientLabel: 'Claude Code in billing (pid 2000000001)',
    })
    expect(hellos()[0]?.takeover).toBeUndefined()
  })

  it('a plain connect while another is live is refused, names the holder, and leaves it connected', async () => {
    await setup()
    const working = client('Claude Code in billing (pid 1)')
    await working.ensureConnected()
    const holder = server.live('ra_1')
    const newcomer = client('Claude Code in notes (pid 2)')

    const refused = await newcomer.listPeers().then(
      () => {
        throw new Error('expected in_use')
      },
      (error: unknown) => error as SkaileError,
    )
    expect(refused).toBeInstanceOf(SkaileError)
    expect(refused.code).toBe('in_use')
    expect(refused.message).toContain('Claude Code in billing (pid 1)')
    expect(refused.message).toContain('/skaile:skaile reconnect')
    expect(newcomer.getStatus()).toMatchObject({ state: 'stopped', reason: 'in_use' })
    expect(server.live('ra_1')).toBe(holder)
    expect(working.getStatus()).toMatchObject({ state: 'connected' })
    expect(await working.listPeers()).toHaveLength(1)

    // No retry on its own: the next tool call tries again, still without taking over.
    await pause(300)
    expect(server.connectAttempts).toHaveLength(2)
    expect((await newcomer.listPeers().catch((error: SkaileError) => error)) as SkaileError).toMatchObject({
      code: 'in_use',
    })
    expect(server.connectAttempts).toHaveLength(3)
    expect(hellos().every((hello) => hello.takeover === undefined)).toBe(true)
    expect(server.live('ra_1')).toBe(holder)
  })

  it('reconnect takes the connection over', async () => {
    await setup()
    const working = client('Claude Code in billing (pid 1)')
    await working.ensureConnected()
    const newcomer = client('Claude Code in notes (pid 2)')
    await newcomer.listPeers().catch(() => undefined)

    expect(await newcomer.reconnect()).toMatchObject({ state: 'connected' })
    expect(hellos().at(-1)).toMatchObject({ takeover: true, clientLabel: 'Claude Code in notes (pid 2)' })
    await server.until(() => working.getStatus().state === 'stopped')
    expect(working.getStatus()).toMatchObject({ reason: 'replaced' })
    expect(await newcomer.listPeers()).toHaveLength(1)
  })

  it('reconnect keeps asking to take over through a passing failure', async () => {
    await setup()
    const working = client('Claude Code in billing (pid 1)')
    await working.ensureConnected()
    const newcomer = client('Claude Code in notes (pid 2)')
    server.refuseNext.push({ status: 429, code: 'rate_limited', retryAfterMs: 50 })

    await newcomer.reconnect()
    await server.until(() => newcomer.getStatus().state === 'connected', 5_000)
    expect(hellos().at(-1)).toMatchObject({ takeover: true, clientLabel: 'Claude Code in notes (pid 2)' })
    await server.until(() => working.getStatus().state === 'stopped')
    expect(working.getStatus()).toMatchObject({ reason: 'replaced' })
  })

  it('a reconnect that found no token does not take over on a later tool call', async () => {
    await setup()
    const working = client('Claude Code in billing (pid 1)')
    await working.ensureConnected()
    const holder = server.live('ra_1')
    const tokens = new MemoryTokenStore(null)
    const newcomer = client('Claude Code in notes (pid 2)', tokens)
    expect(await newcomer.reconnect()).toMatchObject({ state: 'stopped', reason: 'no_token' })

    tokens.token = TOKEN
    expect((await newcomer.listPeers().catch((error: SkaileError) => error)) as SkaileError).toMatchObject({
      code: 'in_use',
    })
    expect(hellos().every((hello) => hello.takeover === undefined)).toBe(true)
    expect(server.live('ra_1')).toBe(holder)
  })

  it('a plain connect succeeds once the holder has gone', async () => {
    await setup()
    const working = client('Claude Code in billing (pid 1)')
    await working.ensureConnected()
    const newcomer = client('Claude Code in notes (pid 2)')
    await newcomer.listPeers().catch(() => undefined)
    // The holder's session ends; the server drops its connection (at once over WebSocket, after
    // 60 s without a poll over long-poll).
    working.close()
    server.live('ra_1')?.close(4408, 'heartbeat_timeout')

    expect(await newcomer.listPeers()).toHaveLength(1)
    expect(hellos().at(-1)?.takeover).toBeUndefined()
  })

  it('after its own connection drops, retries in_use while the server may still count the dead one live', async () => {
    await setup()
    const c = client('Claude Code in billing (pid 1)')
    await c.ensureConnected()
    // The server has not noticed yet that this connection is gone.
    server.ghosts.add('ra_1')
    server.live('ra_1')?.close(1011, 'network')
    await server.until(() => server.connectAttempts.length >= 2)
    await server.until(() => c.getStatus().state === 'retrying')
    const status = c.getStatus()
    expect(status.state === 'retrying' && status.lastError).toMatch(/^in use/)

    server.ghosts.delete('ra_1')
    await server.until(() => c.getStatus().state === 'connected', 5_000)
    expect(hellos().every((hello) => hello.takeover === undefined)).toBe(true)
  })
})

describe('the client label', () => {
  it('names the folder and the process, without control characters, within the limit', () => {
    expect(clientLabelFor('/home/ada/repos/billing', 42)).toBe('Claude Code in billing (pid 42)')
    expect(clientLabelFor('/tmp/a\nb', 1)).toBe('Claude Code in ab (pid 1)')
    expect(clientLabelFor(`/${'x'.repeat(300)}`, 1)).toHaveLength(128)
  })

  it('the status before the first tool call says it connects lazily', async () => {
    const c = makeClient('http://127.0.0.1:9', new MemoryTokenStore(TOKEN))
    expect(await statusText(c)).toMatch(/Not connected yet: the plugin connects on the first Skaile tool call/)
  })
})
