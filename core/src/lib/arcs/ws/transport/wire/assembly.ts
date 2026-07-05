/**
 * Message reassembly, as a byte-streaming reducer over caller-owned state: {@link beginFrame} folds a
 * data frame's header, {@link appendPayload} folds payload bytes in arrival order, and
 * {@link endFrame} closes the frame, yielding the message on FIN ({@link assembleFrame} is the
 * whole-frame composition of the three). There is no hidden state: the connection owns the
 * {@link AssemblyState} the same way it owns its socket.
 */
import type { AssembleResult, AssemblyLimits, AssemblyState, WsFrame } from "./types.js";
import { WS_CLOSE, WS_OPCODE } from "./protocol.js";

const PARTIAL: AssembleResult = { type: "partial" };

/** Returns a fresh, idle {@link AssemblyState}. */
export function newAssemblyState(): AssemblyState {
  return { fragments: [], fragmentCount: 0, total: 0, opcode: 0, frameFin: false, decoder: undefined, text: "" };
}

/**
 * Folds one data-frame header into `state`: enforces the message-level rules of RFC 6455 (a
 * continuation must follow a started message, a new data frame must not interrupt one) and the
 * fragment-count and message-size caps (payload length is known here, so the caps reject before any
 * payload buffers). Returns `partial` when the frame is accepted; an error resets the state.
 */
export function beginFrame(
  state: AssemblyState,
  header: { readonly fin: boolean; readonly opcode: number; readonly payloadLen: number; },
  limits: AssemblyLimits,
): AssembleResult {
  const { fin, opcode, payloadLen } = header;

  if (opcode === WS_OPCODE.CONTINUATION) {
    if (state.opcode === 0) {
      return reset(state, fail(WS_CLOSE.PROTOCOL_ERROR, "Continuation frame with no message in progress"));
    }
  } else {
    if (state.opcode !== 0) {
      return reset(state, fail(WS_CLOSE.PROTOCOL_ERROR, "New data frame during a fragmented message"));
    }
    state.opcode = opcode;
    if (opcode === WS_OPCODE.TEXT) state.decoder ??= new TextDecoder("utf-8", { fatal: true });
  }

  if (state.fragmentCount >= limits.maxFragments) {
    return reset(state, fail(WS_CLOSE.MESSAGE_TOO_BIG, "Too many fragments"));
  }
  state.fragmentCount += 1;
  state.total += payloadLen;
  if (state.total > limits.maxMessageSize) {
    return reset(state, fail(WS_CLOSE.MESSAGE_TOO_BIG, "Message exceeds the size limit"));
  }
  state.frameFin = fin;
  return PARTIAL;
}

/**
 * Folds payload bytes of the current frame, in arrival order. TEXT streams through the connection's
 * UTF-8 decoder, so an invalid byte sequence fails fast (1007) mid-frame and the decoded string
 * accumulates as it goes (completed text needs no byte merge); a multi-byte codepoint split across
 * chunk or fragment boundaries is held by the streaming decoder. BINARY accumulates as byte chunks.
 * The decoder lives for the CONNECTION (a successful flush resets it; a failed decode fails the
 * connection, taking the dirty decoder with it), so the per-message cost is zero. An error resets
 * the state.
 */
export function appendPayload(state: AssemblyState, chunk: Uint8Array): AssembleResult {
  if (chunk.length === 0) return PARTIAL;
  if (state.opcode === WS_OPCODE.TEXT) {
    try {
      state.text += state.decoder!.decode(chunk, { stream: true });
    } catch {
      return reset(state, fail(WS_CLOSE.INVALID_PAYLOAD, "Text message is not valid UTF-8"));
    }
  } else {
    state.fragments.push(chunk);
  }
  return PARTIAL;
}

/**
 * Closes the current frame: `partial` when more fragments follow (FIN clear), the completed message
 * on FIN (text is flushed through the decoder, which rejects a multi-byte sequence truncated at
 * message end; binary chunks merge). Resets the state either way a message or error is produced.
 */
export function endFrame(state: AssemblyState): AssembleResult {
  if (!state.frameFin) return PARTIAL;
  if (state.opcode === WS_OPCODE.TEXT) {
    let tail: string;
    try {
      tail = state.decoder!.decode(); // flush: rejects a truncated sequence, resets the decoder for reuse
    } catch {
      return reset(state, fail(WS_CLOSE.INVALID_PAYLOAD, "Text message is not valid UTF-8"));
    }
    return reset(state, { type: "message", data: state.text + tail });
  }
  const merged = state.fragments.length === 1 ? state.fragments[0]! : concat(state.fragments, state.total);
  return reset(state, { type: "message", data: merged });
}

/**
 * Folds one WHOLE data frame into `state`: {@link beginFrame} + {@link appendPayload} +
 * {@link endFrame} composed, for callers that already hold the full unmasked payload.
 */
export function assembleFrame(state: AssemblyState, frame: WsFrame, limits: AssemblyLimits): AssembleResult {
  const begun = beginFrame(state, { fin: frame.fin, opcode: frame.opcode, payloadLen: frame.payload.length }, limits);
  if (begun.type === "error") return begun;
  const appended = appendPayload(state, frame.payload);
  if (appended.type === "error") return appended;
  return endFrame(state);
}

function reset(state: AssemblyState, result: AssembleResult): AssembleResult {
  state.fragments = [];
  state.fragmentCount = 0;
  state.total = 0;
  state.opcode = 0;
  state.frameFin = false;
  // The decoder survives: endFrame's successful flush left it clean, and a decode failure fails the
  // whole connection, which discards this state (and the dirty decoder) with it.
  state.text = "";
  return result;
}

function fail(code: number, reason: string): AssembleResult {
  return { type: "error", code, reason };
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}
