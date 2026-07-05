/**
 * RFC 6455 wire vocabulary for WebSocket framing: frame opcodes, close codes, and validation
 * predicates.
 */

/** @internal WebSocket frame opcodes (RFC 6455 section 5.2). */
export const WS_OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

/** @internal WebSocket close codes (RFC 6455 section 7.4). */
export const WS_CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  INVALID_PAYLOAD: 1007,
  POLICY_VIOLATION: 1008,
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
} as const;

/** @internal Close code reported up when a peer closes without a status code (RFC 6455 section 7.1.5). */
export const WS_CLOSE_NO_STATUS = 1005;

/** @internal Close code reported up when the connection drops without a close handshake (RFC 6455 section 7.1.5). */
export const WS_CLOSE_ABNORMAL = 1006;

/** @internal Returns true for one of the six defined opcodes; all others are reserved. */
export function isKnownOpcode(opcode: number): boolean {
  return opcode === WS_OPCODE.CONTINUATION
    || opcode === WS_OPCODE.TEXT
    || opcode === WS_OPCODE.BINARY
    || opcode === WS_OPCODE.CLOSE
    || opcode === WS_OPCODE.PING
    || opcode === WS_OPCODE.PONG;
}

/** @internal Returns true for control opcodes (close, ping, pong), which the high bit marks. */
export function isControlOpcode(opcode: number): boolean {
  return opcode >= WS_OPCODE.CLOSE;
}

/**
 * Returns true for a close code an endpoint may send or accept on the wire.
 *
 * Covers the registered protocol codes (RFC 6455 section 7.4.1) and the application range
 * 3000-4999. Excludes the codes reserved for local use only (1004, 1005, 1006, 1015) and every
 * other unassigned value.
 *
 * @internal
 */
export function isValidCloseCode(code: number): boolean {
  if (code >= 3000 && code <= 4999) return true;
  switch (code) {
    case 1000:
    case 1001:
    case 1002:
    case 1003:
    case 1007:
    case 1008:
    case 1009:
    case 1010:
    case 1011:
      return true;
    default:
      return false;
  }
}
