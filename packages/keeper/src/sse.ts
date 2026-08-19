import type { ServerResponse } from 'node:http'

import type { KeeperEvent } from './events.js'

/**
 * Server-sent events, framed by hand.
 *
 * SSE rather than a WebSocket because the traffic is one-way and rare, `EventSource` is built into
 * every browser, and neither side needs a dependency. The framing is a dozen lines and lives here
 * rather than in `server.ts` so it can be tested without a socket.
 */
export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // nginx buffers a response body by default, which for a stream means the client sees nothing at
  // all until the connection closes.
  'x-accel-buffering': 'no',
} as const

/**
 * One event as wire bytes.
 *
 * `data` is always a single compact line. A pretty-printed payload contains newlines, and a newline
 * inside `data:` silently ends the frame — the client would receive a truncated JSON fragment and
 * quietly drop it.
 */
export function frame(event: { id?: number; name: string; data: unknown }): string {
  const id = event.id === undefined ? '' : `id: ${event.id}\n`
  return `${id}event: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`
}

/** A comment line. Keeps proxies from closing a stream that has been quiet. */
export function keepalive(): string {
  return ': keepalive\n\n'
}

/** The retry interval the browser should use. Sent once, before anything else. */
export function retryAfter(ms: number): string {
  return `retry: ${ms}\n\n`
}

/** Write one bus event to a stream, using its sequence number as the SSE id. */
export function writeEvent(response: ServerResponse, event: KeeperEvent): void {
  response.write(frame({ id: event.seq, name: event.type, data: event }))
}
