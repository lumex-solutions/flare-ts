/** Wire-frame and message-assembly vocabulary for the WebSocket codec: frames, parse outcomes, and assembly state. */

/** One parsed, unmasked WebSocket frame. */
export type WsFrame = {
  readonly fin: boolean;
  readonly opcode: number;
  /** Unmasked payload, a fresh copy independent of the source buffer. */
  readonly payload: Uint8Array;
};

/**
 * Outcome of reading one frame: a complete frame with the byte count it consumed, a signal that
 * more bytes are needed, or a protocol violation carrying the close code to send.
 */
export type FrameRead =
  | { readonly type: "frame"; readonly frame: WsFrame; readonly consumed: number; }
  | { readonly type: "incomplete"; }
  | { readonly type: "error"; readonly code: number; readonly reason: string; };

/** One parsed frame HEADER: everything known before any payload byte arrives. */
export type FrameHeader = {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payloadLen: number;
  /** Header bytes (base + extended length + masking key); the payload starts right after. */
  readonly headerLen: number;
  /** The client's 4-byte masking key. */
  readonly mask: readonly [number, number, number, number];
};

/**
 * Outcome of reading one frame header: the header (frame-level rules already enforced), a signal
 * that more bytes are needed, or a protocol violation carrying the close code to send.
 */
export type HeaderRead =
  | { readonly type: "header"; readonly header: FrameHeader; }
  | { readonly type: "incomplete"; }
  | { readonly type: "error"; readonly code: number; readonly reason: string; };

/**
 * Outcome of parsing a close-frame payload: the status code and reason, or the close code to
 * respond with when the frame is malformed.
 */
export type ParsedClose =
  | { readonly ok: true; readonly code: number; readonly reason: string; }
  | { readonly ok: false; readonly closeCode: number; readonly message: string; };

/** The partial-message accumulator a caller threads through the assembler. */
export type AssemblyState = {
  /** Buffered BINARY payload chunks (text accumulates as {@link text} instead; see assembly.ts). */
  fragments: Uint8Array[];
  /** Frames folded into the current message so far, for the fragment-count cap. */
  fragmentCount: number;
  /** Wire payload bytes committed to the current message (counted at frame begin, from the header). */
  total: number;
  /** 0 while idle; TEXT or BINARY while a message is in progress. */
  opcode: number;
  /** The current frame's FIN bit (set at beginFrame; endFrame completes the message when set). */
  frameFin: boolean;
  /** Connection-lifetime streaming UTF-8 decoder for TEXT payloads (fail-fast validation). */
  decoder: TextDecoder | undefined;
  /** Decoded text accumulated so far for the in-progress TEXT message. */
  text: string;
};

/** Caps a message is reassembled within. */
export type AssemblyLimits = {
  readonly maxMessageSize: number;
  readonly maxFragments: number;
};

/**
 * Result of folding one frame into the assembly: a completed message, a signal that more frames are
 * needed, or a protocol violation carrying the close code to send.
 */
export type AssembleResult =
  | { readonly type: "message"; readonly data: string | Uint8Array; }
  | { readonly type: "partial"; }
  | { readonly type: "error"; readonly code: number; readonly reason: string; };
