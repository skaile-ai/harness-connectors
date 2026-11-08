import { HARNESS_CHANNEL_CONNECT_PATH } from '@skaile/harness-protocol'
import WebSocket from 'ws'
import {
  MAX_INBOUND_MESSAGE_BYTES,
  OpenError,
  type OpenTransport,
  refusalFromResponse,
  type Transport,
} from './types.js'

const HANDSHAKE_TIMEOUT_MS = 15_000
const MAX_REFUSAL_BODY_BYTES = 16 * 1024

export function webSocketUrl(apiUrl: string): string {
  return apiUrl.replace(/^http/, 'ws') + HARNESS_CHANNEL_CONNECT_PATH
}

/** `wss://<api>/harness/connect`, with the token in the `Authorization` header (never the query string). */
export const openWebSocket: OpenTransport = ({ apiUrl, token, firstFrame, events }) =>
  new Promise((resolve, reject) => {
    let settled = false
    let opened = false
    let closedLocally = false
    const ws = new WebSocket(webSocketUrl(apiUrl), {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: MAX_INBOUND_MESSAGE_BYTES,
      followRedirects: false,
    })
    const fail = (error: OpenError) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    }

    // The server refuses a bad token at the upgrade, with an `error` frame as the HTTP body.
    ws.on('unexpected-response', (req, res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        if (body.length < MAX_REFUSAL_BODY_BYTES) {
          body += chunk
        }
      })
      res.on('end', () => {
        fail(refusalFromResponse(res.statusCode ?? 0, body))
        req.destroy()
      })
      res.on('error', () => fail(new OpenError('unreachable', `HTTP ${res.statusCode}`, res.statusCode)))
    })
    ws.on('error', (error) => fail(new OpenError('unreachable', error.message)))

    ws.on('open', () => {
      settled = true
      opened = true
      const transport: Transport = {
        kind: 'websocket',
        send(frame) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(frame))
          }
        },
        close() {
          closedLocally = true
          ws.close(1000)
          // A peer that does not finish the closing handshake does not hold the socket open.
          setTimeout(() => ws.terminate(), 2_000).unref()
        },
      }
      transport.send(firstFrame)
      resolve(transport)
    })

    ws.on('message', (data, isBinary) => {
      if (isBinary || closedLocally) {
        return
      }
      events.onFrame(rawData(data))
    })

    ws.on('close', (code, reason) => {
      if (!opened) {
        fail(new OpenError('unreachable', `closed during the handshake (${code})`))
        return
      }
      if (!closedLocally) {
        closedLocally = true
        events.onClose(code, reason.toString('utf8'))
      }
    })
  })

function rawData(data: WebSocket.RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8')
  }
  return Buffer.from(data as ArrayBuffer).toString('utf8')
}
