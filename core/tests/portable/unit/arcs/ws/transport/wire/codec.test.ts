/** Unit tests for WebSocket wire codec readFrame, encode*, and parseCloseFrame. */
import { describe, expect, it } from "vitest";
import type { FrameRead, WsFrame } from "../../../../../../../src/lib/arcs/ws/transport/wire/types.js";
import {
  encodeBinary,
  encodeClose,
  encodeFrame,
  encodePing,
  encodePong,
  encodeText,
  parseCloseFrame,
  readFrame,
} from "../../../../../../../src/lib/arcs/ws/transport/wire/codec.js";
import {
  WS_CLOSE,
  WS_CLOSE_NO_STATUS,
  WS_OPCODE,
} from "../../../../../../../src/lib/arcs/ws/transport/wire/protocol.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const text = (s: string) => enc.encode(s);

/** Builds a valid masked client frame (the only kind a server reader should accept). */
function clientFrame(
  opcode: number,
  payload: Uint8Array,
  opts: { fin?: boolean; mask?: [number, number, number, number]; } = {},
): Uint8Array {
  const fin = opts.fin ?? true;
  const mask = opts.mask ?? [0x01, 0x02, 0x03, 0x04];
  const len = payload.length;
  let ext = 0;
  if (len >= 0x10000) ext = 8;
  else if (len >= 126) ext = 2;

  const out = new Uint8Array(2 + ext + 4 + len);
  out[0] = (fin ? 0x80 : 0) | opcode;
  let p = 2;
  if (len < 126) {
    out[1] = 0x80 | len;
  } else if (len < 0x10000) {
    out[1] = 0x80 | 126;
    out[2] = (len >> 8) & 0xff;
    out[3] = len & 0xff;
    p = 4;
  } else {
    out[1] = 0x80 | 127;
    out[6] = (len >>> 24) & 0xff;
    out[7] = (len >>> 16) & 0xff;
    out[8] = (len >>> 8) & 0xff;
    out[9] = len & 0xff;
    p = 10;
  }
  out[p] = mask[0];
  out[p + 1] = mask[1];
  out[p + 2] = mask[2];
  out[p + 3] = mask[3];
  for (let i = 0; i < len; i++) out[p + 4 + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

/** Builds a masked frame that deliberately uses the 16-bit length marker for a sub-126 length. */
function nonMinimal16(opcode: number, payload: Uint8Array): Uint8Array {
  const len = payload.length;
  const mask = [0x01, 0x02, 0x03, 0x04];
  const out = new Uint8Array(2 + 2 + 4 + len);
  out[0] = 0x80 | opcode;
  out[1] = 0x80 | 126;
  out[2] = (len >> 8) & 0xff;
  out[3] = len & 0xff;
  out[4] = mask[0]!;
  out[5] = mask[1]!;
  out[6] = mask[2]!;
  out[7] = mask[3]!;
  for (let i = 0; i < len; i++) out[8 + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

/** Drives readFrame across a whole buffer the way a caller would, collecting frames and any error. */
function readAll(bytes: Uint8Array, maxFrameSize = 1 << 20) {
  const frames: WsFrame[] = [];
  let error: { code: number; reason: string; } | undefined;
  let off = 0;
  while (off < bytes.length) {
    const r: FrameRead = readFrame(bytes, off, bytes.length, maxFrameSize);
    if (r.type === "incomplete") break;
    if (r.type === "error") {
      error = { code: r.code, reason: r.reason };
      break;
    }
    frames.push(r.frame);
    off += r.consumed;
  }
  return { frames, error };
}

describe("readFrame parsing", () => {
  it("parses the RFC 6455 masked 'Hello' frame and reports bytes consumed", () => {
    const bytes = new Uint8Array([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
    const r = readFrame(bytes, 0, bytes.length, 1 << 20);
    expect(r.type).toBe("frame");
    if (r.type !== "frame") return;
    expect(r.consumed).toBe(11);
    expect(r.frame.opcode).toBe(WS_OPCODE.TEXT);
    expect(dec.decode(r.frame.payload)).toBe("Hello");
  });

  it("unmasks an arbitrary masked text payload", () => {
    const { frames } = readAll(clientFrame(WS_OPCODE.TEXT, text("the quick brown fox")));
    expect(dec.decode(frames[0]!.payload)).toBe("the quick brown fox");
  });

  it("parses a binary frame", () => {
    const data = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const { frames } = readAll(clientFrame(WS_OPCODE.BINARY, data));
    expect([...frames[0]!.payload]).toEqual([...data]);
  });

  it("parses multiple frames from one buffer, advancing by consumed", () => {
    const a = clientFrame(WS_OPCODE.TEXT, text("one"));
    const b = clientFrame(WS_OPCODE.TEXT, text("two"));
    const merged = new Uint8Array(a.length + b.length);
    merged.set(a, 0);
    merged.set(b, a.length);
    const { frames } = readAll(merged);
    expect(frames.map((f) => dec.decode(f.payload))).toEqual(["one", "two"]);
  });

  it("handles a 16-bit length payload", () => {
    const { frames } = readAll(clientFrame(WS_OPCODE.BINARY, new Uint8Array(200).fill(0x7a)));
    expect(frames[0]!.payload.length).toBe(200);
  });

  it("handles a 64-bit length payload (above the 16-bit boundary)", () => {
    const big = new Uint8Array(70000).fill(0x5a);
    const { frames, error } = readAll(clientFrame(WS_OPCODE.BINARY, big));
    expect(error).toBeUndefined();
    expect(frames[0]!.payload.length).toBe(70000);
    expect(frames[0]!.payload[69999]).toBe(0x5a);
  });

  it("parses an empty-payload frame", () => {
    const { frames } = readAll(clientFrame(WS_OPCODE.TEXT, new Uint8Array(0)));
    expect(frames[0]!.payload.length).toBe(0);
  });

  it("returns 'incomplete' when the header is truncated", () => {
    expect(readFrame(new Uint8Array([0x81]), 0, 1, 1 << 20).type).toBe("incomplete");
  });

  it("returns 'incomplete' when the payload is truncated", () => {
    const frame = clientFrame(WS_OPCODE.TEXT, text("hello"));
    const truncated = frame.subarray(0, frame.length - 3);
    expect(readFrame(truncated, 0, truncated.length, 1 << 20).type).toBe("incomplete");
  });

  it("does not mutate the source buffer when unmasking", () => {
    const frame = clientFrame(WS_OPCODE.TEXT, text("abc"));
    const copy = frame.slice();
    readFrame(frame, 0, frame.length, 1 << 20);
    expect([...frame]).toEqual([...copy]);
  });
});

describe("readFrame protocol violations", () => {
  const code = (bytes: Uint8Array, max = 1 << 20) => {
    const r = readFrame(bytes, 0, bytes.length, max);
    return r.type === "error" ? r.code : undefined;
  };

  it("rejects a frame with a reserved bit set (1002)", () => {
    const frame = clientFrame(WS_OPCODE.TEXT, text("x"));
    frame[0]! |= 0x40;
    expect(code(frame)).toBe(WS_CLOSE.PROTOCOL_ERROR);
  });

  it("rejects a reserved opcode (1002)", () => {
    expect(code(clientFrame(0x3, text("x")))).toBe(WS_CLOSE.PROTOCOL_ERROR);
  });

  it("rejects an unmasked client frame (1002)", () => {
    expect(code(new Uint8Array([0x81, 0x01, 0x61]))).toBe(WS_CLOSE.PROTOCOL_ERROR);
  });

  it("rejects a control frame larger than 125 bytes (1002)", () => {
    expect(code(clientFrame(WS_OPCODE.PING, new Uint8Array(126)))).toBe(WS_CLOSE.PROTOCOL_ERROR);
  });

  it("rejects a fragmented control frame (1002)", () => {
    expect(code(clientFrame(WS_OPCODE.CLOSE, new Uint8Array(0), { fin: false }))).toBe(WS_CLOSE.PROTOCOL_ERROR);
  });

  it("rejects a frame exceeding maxFrameSize (1009)", () => {
    expect(code(clientFrame(WS_OPCODE.BINARY, new Uint8Array(100)), 50)).toBe(WS_CLOSE.MESSAGE_TOO_BIG);
  });

  it("rejects a non-minimal length encoding (1002)", () => {
    expect(code(nonMinimal16(WS_OPCODE.BINARY, new Uint8Array(10)))).toBe(WS_CLOSE.PROTOCOL_ERROR);
  });
});

const filled = (n: number) => new Uint8Array(n).fill(0x61);
const isMasked = (frame: Uint8Array) => (frame[1]! & 0x80) !== 0;

describe("encode frames", () => {
  it("emits FIN + text opcode, length, and the unmasked UTF-8 payload", () => {
    expect([...encodeText("Hi")]).toEqual([0x81, 0x02, 0x48, 0x69]);
  });

  it("uses the 7-bit, 16-bit, and 64-bit length encodings at their boundaries", () => {
    expect(encodeFrame(WS_OPCODE.BINARY, filled(125))[1]).toBe(125);
    const f16 = encodeFrame(WS_OPCODE.BINARY, filled(126));
    expect([f16[1], f16[2], f16[3]]).toEqual([126, 0x00, 0x7e]);
    expect([...encodeFrame(WS_OPCODE.BINARY, filled(65535)).slice(1, 4)]).toEqual([126, 0xff, 0xff]);
    const f64 = encodeFrame(WS_OPCODE.BINARY, filled(65536));
    expect(f64[1]).toBe(127);
    expect([...f64.slice(2, 10)]).toEqual([0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00]);
  });

  it("never masks server frames and allocates no trailing bytes", () => {
    expect(isMasked(encodeText("anything"))).toBe(false);
    expect(isMasked(encodeBinary(filled(200)))).toBe(false);
    expect(encodeBinary(filled(10)).length).toBe(2 + 10);
  });

  it("encodes close with a 2-byte code and UTF-8 reason, truncating an over-long reason", () => {
    expect([...encodeClose(1000, "bye")]).toEqual([0x88, 0x05, 0x03, 0xe8, 0x62, 0x79, 0x65]);
    const long = encodeClose(1000, "x".repeat(200));
    expect(long[1]).toBe(125);
    expect(long.length).toBe(2 + 125);
  });

  it("encodes ping and pong", () => {
    expect(encodePing()[0]).toBe(0x89);
    const pong = encodePong(new Uint8Array([1, 2, 3]));
    expect(pong[0]).toBe(0x8a);
    expect([...pong.slice(2)]).toEqual([1, 2, 3]);
  });
});

const closePayload = (code: number, reason = "") => {
  const r = enc.encode(reason);
  const out = new Uint8Array(2 + r.length);
  out[0] = (code >> 8) & 0xff;
  out[1] = code & 0xff;
  out.set(r, 2);
  return out;
};

describe("parseCloseFrame", () => {
  it("treats an empty payload as a clean close with no status", () => {
    expect(parseCloseFrame(new Uint8Array(0))).toEqual({ ok: true, code: WS_CLOSE_NO_STATUS, reason: "" });
  });

  it("reads a code and a UTF-8 reason", () => {
    expect(parseCloseFrame(closePayload(1001, "bye"))).toEqual({ ok: true, code: 1001, reason: "bye" });
  });

  it("rejects a 1-byte payload (1002)", () => {
    const r = parseCloseFrame(new Uint8Array([0x03]));
    expect(r).toMatchObject({ ok: false, closeCode: WS_CLOSE.PROTOCOL_ERROR });
  });

  it("rejects an invalid close code (1002)", () => {
    expect(parseCloseFrame(closePayload(1004))).toMatchObject({ ok: false, closeCode: WS_CLOSE.PROTOCOL_ERROR });
  });

  it("rejects a non-UTF-8 reason (1007)", () => {
    const payload = new Uint8Array([0x03, 0xe8, 0xc3]); // code 1000 + lone 0xC3
    expect(parseCloseFrame(payload)).toMatchObject({ ok: false, closeCode: WS_CLOSE.INVALID_PAYLOAD });
  });
});
