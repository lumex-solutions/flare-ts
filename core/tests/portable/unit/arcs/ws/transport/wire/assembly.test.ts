/** Unit tests for WebSocket frame assembly state machine. */
import { describe, expect, it } from "vitest";
import type { WsFrame } from "../../../../../../../src/lib/arcs/ws/transport/wire/types.js";
import { assembleFrame, newAssemblyState } from "../../../../../../../src/lib/arcs/ws/transport/wire/assembly.js";
import { WS_CLOSE, WS_OPCODE } from "../../../../../../../src/lib/arcs/ws/transport/wire/protocol.js";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
const frame = (opcode: number, payload: Uint8Array, fin = true): WsFrame => ({ fin, opcode, payload });

/** Folds frames into one caller-owned state, the way the connection will. */
function run(frames: WsFrame[], maxMessageSize = 1 << 20, maxFragments = 256) {
  const state = newAssemblyState();
  const messages: Array<string | Uint8Array> = [];
  let error: { code: number; reason: string; } | undefined;
  for (const f of frames) {
    const r = assembleFrame(state, f, { maxMessageSize, maxFragments });
    if (r.type === "message") messages.push(r.data);
    else if (r.type === "error") {
      error = { code: r.code, reason: r.reason };
      break;
    }
  }
  return { messages, error };
}

describe("assembleFrame reassembly", () => {
  it("emits a single text frame as a string", () => {
    const { messages, error } = run([frame(WS_OPCODE.TEXT, bytes("hello"))]);
    expect(error).toBeUndefined();
    expect(messages).toEqual(["hello"]);
  });

  it("emits a single binary frame as a Uint8Array", () => {
    const { messages } = run([frame(WS_OPCODE.BINARY, new Uint8Array([1, 2, 3, 250]))]);
    expect(messages[0]).toBeInstanceOf(Uint8Array);
    expect([...(messages[0] as Uint8Array)]).toEqual([1, 2, 3, 250]);
  });

  it("joins a fragmented text message", () => {
    const { messages, error } = run([
      frame(WS_OPCODE.TEXT, bytes("and a "), false),
      frame(WS_OPCODE.CONTINUATION, bytes("happy "), false),
      frame(WS_OPCODE.CONTINUATION, bytes("new year"), true),
    ]);
    expect(error).toBeUndefined();
    expect(messages).toEqual(["and a happy new year"]);
  });

  it("decodes a multi-byte UTF-8 character split across fragments", () => {
    // "é" is 0xC3 0xA9; deliver the two bytes in separate fragments.
    const { messages, error } = run([
      frame(WS_OPCODE.TEXT, new Uint8Array([0xc3]), false),
      frame(WS_OPCODE.CONTINUATION, new Uint8Array([0xa9]), true),
    ]);
    expect(error).toBeUndefined();
    expect(messages).toEqual(["é"]);
  });

  it("emits an empty text frame as the empty string", () => {
    expect(run([frame(WS_OPCODE.TEXT, new Uint8Array(0))]).messages).toEqual([""]);
  });

  it("keeps folding into the same state after a completed message", () => {
    const { messages } = run([
      frame(WS_OPCODE.TEXT, bytes("first")),
      frame(WS_OPCODE.TEXT, bytes("second")),
    ]);
    expect(messages).toEqual(["first", "second"]);
  });
});

describe("assembleFrame violations", () => {
  it("rejects a continuation with no message in progress (1002)", () => {
    expect(run([frame(WS_OPCODE.CONTINUATION, bytes("x"))]).error!.code).toBe(WS_CLOSE.PROTOCOL_ERROR);
  });

  it("rejects a new data frame during a fragmented message (1002)", () => {
    const { messages, error } = run([
      frame(WS_OPCODE.TEXT, bytes("a"), false),
      frame(WS_OPCODE.TEXT, bytes("b"), true),
    ]);
    expect(messages).toEqual([]);
    expect(error!.code).toBe(WS_CLOSE.PROTOCOL_ERROR);
  });

  it("rejects a fragmented message exceeding the size cap (1009)", () => {
    const { error } = run(
      [
        frame(WS_OPCODE.BINARY, new Uint8Array(40), false),
        frame(WS_OPCODE.CONTINUATION, new Uint8Array(40), true),
      ],
      50,
    );
    expect(error!.code).toBe(WS_CLOSE.MESSAGE_TOO_BIG);
  });

  it("rejects a single-frame message exceeding the size cap (1009)", () => {
    const { messages, error } = run([frame(WS_OPCODE.BINARY, new Uint8Array(100))], 50);
    expect(messages).toEqual([]);
    expect(error!.code).toBe(WS_CLOSE.MESSAGE_TOO_BIG);
  });

  it("rejects too many fragments (1009)", () => {
    const { error } = run(
      [
        frame(WS_OPCODE.BINARY, new Uint8Array([0]), false),
        frame(WS_OPCODE.CONTINUATION, new Uint8Array([0]), false),
        frame(WS_OPCODE.CONTINUATION, new Uint8Array([0]), true),
      ],
      1 << 20,
      2,
    );
    expect(error!.code).toBe(WS_CLOSE.MESSAGE_TOO_BIG);
  });

  it("rejects invalid UTF-8 in a single text frame (1007)", () => {
    const { messages, error } = run([frame(WS_OPCODE.TEXT, new Uint8Array([0xc3]))]);
    expect(messages).toEqual([]);
    expect(error!.code).toBe(WS_CLOSE.INVALID_PAYLOAD);
  });

  it("rejects invalid UTF-8 assembled across fragments (1007)", () => {
    const { error } = run([
      frame(WS_OPCODE.TEXT, new Uint8Array([0xc3]), false),
      frame(WS_OPCODE.CONTINUATION, new Uint8Array([0x28]), true), // 0xC3 0x28 is invalid
    ]);
    expect(error!.code).toBe(WS_CLOSE.INVALID_PAYLOAD);
  });

  it("fails fast on an invalid UTF-8 fragment, without waiting for the final frame (1007)", () => {
    // The Autobahn 6.4.x shape: a valid prefix, then a fragment whose bytes are an out-of-range
    // codepoint (0xF4 0x90 0x80 0x80 encodes U+110000). Neither frame carries FIN; the streaming
    // validator must reject at the offending fragment instead of buffering to the size cap.
    const { messages, error } = run([
      frame(WS_OPCODE.TEXT, bytes("valid prefix "), false),
      frame(WS_OPCODE.CONTINUATION, new Uint8Array([0xf4, 0x90, 0x80, 0x80]), false),
    ]);
    expect(messages).toEqual([]);
    expect(error!.code).toBe(WS_CLOSE.INVALID_PAYLOAD);
  });

  it("rejects a multi-byte sequence truncated at message end (1007)", () => {
    // The split-codepoint case's evil twin: the continuation that would complete 0xC3 never comes.
    const { error } = run([
      frame(WS_OPCODE.TEXT, new Uint8Array([0xc3]), false),
      frame(WS_OPCODE.CONTINUATION, new Uint8Array(0), true),
    ]);
    expect(error!.code).toBe(WS_CLOSE.INVALID_PAYLOAD);
  });
});
