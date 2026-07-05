/**
 * Runtime-agnostic wrapper for a single WebSocket message with lazy, memoized text and JSON accessors.
 */

import type { JsonValue } from "@flare-ts/lib/schema";

/**
 * Runtime-agnostic representation of a single WebSocket message.
 *
 * Wraps the raw decoded payload (text as `string`, binary as `Uint8Array`) with lazy, memoized
 * accessors, mirroring {@link FlareRequest}: allocating a `FlareWebSocketMessage` costs only the wrapper, and
 * decoding/parsing is deferred to first access and cached, so nothing is spent on the per-message hot
 * path unless a handler actually reads it. The same type represents a message in either direction - the
 * one delivered to a `message` handler and, conceptually, the one emitted via `ws.send`.
 *
 * The Node codec and the Cloudflare transport both hand up a `string | Uint8Array`; this is the single
 * shape they normalize onto.
 */
export class FlareWebSocketMessage {
  readonly #raw: string | Uint8Array;
  #text: string | undefined;
  #json: JsonValue | undefined;
  #jsonRead = false;
  #size: number | undefined;

  constructor(raw: string | Uint8Array) {
    this.#raw = raw;
  }

  /** The raw payload exactly as it crossed the wire: text (`string`) or binary (`Uint8Array`). */
  get raw(): string | Uint8Array {
    return this.#raw;
  }

  /** True when the message arrived as a binary frame. */
  get isBinary(): boolean {
    return typeof this.#raw !== "string";
  }

  /** Byte length of the payload (UTF-8 byte length for a text payload). Memoized. */
  get size(): number {
    if (this.#size !== undefined) return this.#size;
    return (this.#size = typeof this.#raw === "string" ? encoder.encode(this.#raw).length : this.#raw.byteLength);
  }

  /**
   * Returns the payload as text: the string itself, or the UTF-8 decoding of a binary payload. Memoized.
   *
   * Decoding is lenient (invalid sequences become the replacement character), matching {@link FlareRequest};
   * an inbound text frame is already validated as UTF-8 by the codec.
   */
  text(): string {
    if (this.#text !== undefined) return this.#text;
    return (this.#text = typeof this.#raw === "string" ? this.#raw : decoder.decode(this.#raw));
  }

  /**
   * Parses and returns the payload as JSON. Memoized (a valid `null` result is cached, not re-parsed).
   *
   * @throws {SyntaxError} When the payload is not valid JSON. The memo is only set on success, so a
   *   caller that catches the error and retries re-parses rather than reading a stale `undefined`.
   */
  json(): JsonValue {
    if (this.#jsonRead) return this.#json as JsonValue; // the read flag guarantees the memo is set
    const parsed: JsonValue = JSON.parse(this.text());
    this.#json = parsed;
    this.#jsonRead = true;
    return parsed;
  }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
