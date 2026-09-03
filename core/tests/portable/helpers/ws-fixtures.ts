/**
 * Shared WebSocket fixtures for portable and node test suites.
 */
import type { IFlareWebSocket } from "../../../src/lib/arcs/ws/transport/socket.js";

/**
 * Slice-only stand-in for the transport socket a `WsConnection` drives: records sends and the last
 * close, and nothing else (an unexpected interaction fails loudly as a missing member).
 */
export class FakeSocket implements IFlareWebSocket {
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  protocol = "";
  sent: Array<string | Uint8Array> = [];
  closed: { code: number | undefined; reason: string | undefined; } | undefined;
  send(d: string | Uint8Array): void {
    this.sent.push(d);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}
