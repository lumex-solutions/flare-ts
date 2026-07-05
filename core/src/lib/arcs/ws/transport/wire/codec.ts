/** RFC 6455 WebSocket frame codec for stateless frame encoding and stream-oriented decoding. */
import type { FrameRead, HeaderRead, ParsedClose } from "./types.js";
import {
  isControlOpcode,
  isKnownOpcode,
  isValidCloseCode,
  WS_CLOSE,
  WS_CLOSE_NO_STATUS,
  WS_OPCODE,
} from "./protocol.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const INCOMPLETE: FrameRead = { type: "incomplete" };
const INCOMPLETE_HEADER: HeaderRead = { type: "incomplete" };

/**
 * Reads one frame HEADER from `bytes` in the range `[offset, end)`: everything before the payload
 * (base header, extended length, masking key), reporting the header's byte count or that more bytes
 * are needed.
 *
 * Enforces the frame-level rules of RFC 6455 (reserved bits, known opcodes, control-frame
 * constraints, mandatory client masking, minimal length encoding, the frame-size cap) WITHOUT
 * requiring any payload bytes, so the caller can stream a data frame's payload as it arrives (see
 * {@link unmaskChunk}) instead of buffering the whole frame first.
 */
export function readFrameHeader(bytes: Uint8Array, offset: number, end: number, maxFrameSize: number): HeaderRead {
  const avail = end - offset;
  if (avail < 2) return INCOMPLETE_HEADER;

  const b0 = bytes[offset]!;
  const b1 = bytes[offset + 1]!;
  const fin = (b0 & 0x80) !== 0;
  const rsv = b0 & 0x70;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  const len7 = b1 & 0x7f;

  if (rsv !== 0) return fail(WS_CLOSE.PROTOCOL_ERROR, "Reserved bits set");
  if (!isKnownOpcode(opcode)) return fail(WS_CLOSE.PROTOCOL_ERROR, "Reserved opcode");
  if (isControlOpcode(opcode)) {
    if (!fin) return fail(WS_CLOSE.PROTOCOL_ERROR, "Fragmented control frame");
    if (len7 > 125) return fail(WS_CLOSE.PROTOCOL_ERROR, "Control frame payload too large");
  }
  if (!masked) return fail(WS_CLOSE.PROTOCOL_ERROR, "Client frame is not masked");

  let headerLen = 2 + 4; // base header + 4-byte masking key (client frames are always masked)
  if (len7 === 126) headerLen += 2;
  else if (len7 === 127) headerLen += 8;
  if (avail < headerLen) return INCOMPLETE_HEADER;

  let payloadLen: number;
  if (len7 < 126) {
    payloadLen = len7;
  } else if (len7 === 126) {
    payloadLen = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (payloadLen < 126) return fail(WS_CLOSE.PROTOCOL_ERROR, "Non-minimal length encoding");
  } else {
    // 64-bit length. The high 32 bits must be zero; we cap far below 4 GiB regardless.
    const high = bytes[offset + 2]! * 0x1000000 + (bytes[offset + 3]! << 16) + (bytes[offset + 4]! << 8)
      + bytes[offset + 5]!;
    const low = bytes[offset + 6]! * 0x1000000 + (bytes[offset + 7]! << 16) + (bytes[offset + 8]! << 8)
      + bytes[offset + 9]!;
    if (high !== 0) return fail(WS_CLOSE.MESSAGE_TOO_BIG, "Frame payload too large");
    if (low <= 0xffff) return fail(WS_CLOSE.PROTOCOL_ERROR, "Non-minimal length encoding");
    payloadLen = low;
  }
  if (payloadLen > maxFrameSize) return fail(WS_CLOSE.MESSAGE_TOO_BIG, "Frame payload too large");

  const maskOff = offset + headerLen - 4;
  return {
    type: "header",
    header: {
      fin,
      opcode,
      payloadLen,
      headerLen,
      mask: [bytes[maskOff]!, bytes[maskOff + 1]!, bytes[maskOff + 2]!, bytes[maskOff + 3]!],
    },
  };
}

/**
 * Unmasks `length` payload bytes starting at `bytes[start]` into a fresh copy, continuing a frame's
 * mask rotation at `maskOffset` (the count of payload bytes already consumed from this frame). The
 * streaming counterpart of the whole-frame unmask: feeding a frame's payload through this in arrival
 * order with a running offset produces exactly the bytes a single whole-frame unmask would.
 */
export function unmaskChunk(
  bytes: Uint8Array,
  start: number,
  length: number,
  mask: readonly [number, number, number, number],
  maskOffset: number,
): Uint8Array {
  const out = bytes.slice(start, start + length);
  for (let i = 0; i < length; i++) {
    out[i] = out[i]! ^ mask[(maskOffset + i) & 3]!;
  }
  return out;
}

/**
 * Reads one whole frame from `bytes` in the range `[offset, end)`, reporting how many bytes it
 * consumed or that more are needed. A composition of {@link readFrameHeader} + {@link unmaskChunk}
 * for callers that want frame-at-a-time semantics (control frames, tests); the connection streams
 * data-frame payloads through the parts instead.
 */
export function readFrame(bytes: Uint8Array, offset: number, end: number, maxFrameSize: number): FrameRead {
  const h = readFrameHeader(bytes, offset, end, maxFrameSize);
  if (h.type === "error") return h;
  if (h.type === "incomplete") return INCOMPLETE;
  const { fin, opcode, payloadLen, headerLen, mask } = h.header;
  if (end - offset < headerLen + payloadLen) return INCOMPLETE;
  const payload = unmaskChunk(bytes, offset + headerLen, payloadLen, mask, 0);
  return { type: "frame", frame: { fin, opcode, payload }, consumed: headerLen + payloadLen };
}

/**
 * Encodes one outbound (server to client) frame.
 *
 * Server frames are never masked (RFC 6455 section 5.1). The buffer is allocated to the exact size
 * and the payload copied in, so no uninitialized memory is ever written to the wire.
 */
export function encodeFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 0x10000) headerLen += 8;
  else if (len >= 126) headerLen += 2;

  const out = new Uint8Array(headerLen + len);
  out[0] = (fin ? 0x80 : 0) | opcode;

  if (len < 126) {
    out[1] = len;
  } else if (len < 0x10000) {
    out[1] = 126;
    out[2] = (len >> 8) & 0xff;
    out[3] = len & 0xff;
  } else {
    out[1] = 127;
    // 64-bit big-endian length; the high 32 bits are zero for any length JS can hold here.
    out[6] = (len >>> 24) & 0xff;
    out[7] = (len >>> 16) & 0xff;
    out[8] = (len >>> 8) & 0xff;
    out[9] = len & 0xff;
  }

  out.set(payload, headerLen);
  return out;
}

/** Encodes a text frame from a string. */
export function encodeText(text: string): Uint8Array {
  return encodeFrame(WS_OPCODE.TEXT, encoder.encode(text));
}

/** Encodes a binary frame. */
export function encodeBinary(data: Uint8Array): Uint8Array {
  return encodeFrame(WS_OPCODE.BINARY, data);
}

/** Encodes a ping frame, optionally carrying an application payload (at most 125 bytes). */
export function encodePing(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  return encodeFrame(WS_OPCODE.PING, payload);
}

/** Encodes a pong frame echoing the given payload. */
export function encodePong(payload: Uint8Array): Uint8Array {
  return encodeFrame(WS_OPCODE.PONG, payload);
}

/**
 * Encodes a close frame carrying the 2-byte status code and an optional UTF-8 reason.
 * The reason is truncated to 123 bytes so the control-frame payload stays within 125 bytes.
 */
export function encodeClose(code: number, reason = ""): Uint8Array {
  let reasonBytes = encoder.encode(reason);
  if (reasonBytes.length > 123) reasonBytes = reasonBytes.subarray(0, 123);
  const payload = new Uint8Array(2 + reasonBytes.length);
  payload[0] = (code >> 8) & 0xff;
  payload[1] = code & 0xff;
  payload.set(reasonBytes, 2);
  return encodeFrame(WS_OPCODE.CLOSE, payload);
}

/**
 * Parses a close-frame payload into its status code and reason.
 *
 * An empty payload is a clean close with no status, reported as {@link WS_CLOSE_NO_STATUS}. A single
 * byte, an out-of-range code, or a non-UTF-8 reason are protocol violations carrying the close code
 * to respond with (1002, or 1007 for a bad reason).
 */
export function parseCloseFrame(payload: Uint8Array): ParsedClose {
  if (payload.length === 0) return { ok: true, code: WS_CLOSE_NO_STATUS, reason: "" };
  if (payload.length === 1) {
    return { ok: false, closeCode: WS_CLOSE.PROTOCOL_ERROR, message: "Close frame with a 1-byte payload" };
  }

  const code = (payload[0]! << 8) | payload[1]!;
  if (!isValidCloseCode(code)) {
    return { ok: false, closeCode: WS_CLOSE.PROTOCOL_ERROR, message: "Invalid close code" };
  }

  let reason = "";
  if (payload.length > 2) {
    try {
      reason = decoder.decode(payload.subarray(2));
    } catch {
      return { ok: false, closeCode: WS_CLOSE.INVALID_PAYLOAD, message: "Close reason is not valid UTF-8" };
    }
  }
  return { ok: true, code, reason };
}

function fail(
  code: number,
  reason: string,
): { readonly type: "error"; readonly code: number; readonly reason: string; } {
  return { type: "error", code, reason };
}
