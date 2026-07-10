/**
 * Server-sent events: frame encoding, the writer contract, and the paced stream behind ctx.sse().
 */
import type { JsonValue } from "@flare-ts/lib/schema";

/**
 * One Server-Sent Events frame.
 *
 * `data` is sent as-is when it is a string; any other JSON value is serialized
 * with `JSON.stringify`. `event`, `id`, and `retry` map to the corresponding
 * SSE fields and are omitted from the frame when not provided.
 */
export type SseEvent = {
  data: JsonValue;
  event?: string;
  id?: string;
  retry?: number;
};

/**
 * Push surface handed to a `ctx.sse(...)` producer.
 *
 * `send` and `comment` resolve once the transport has pulled the frame, so a
 * producer that awaits each call is paced by the connection (at most one frame
 * is buffered).
 */
export type SseWriter = {
  /** Sends one event frame. */
  send(event: SseEvent): Promise<void>;
  /** Sends a comment frame. Clients ignore it; useful as a keep-alive. */
  comment(text: string): Promise<void>;
};

const encoder = new TextEncoder();

type QueuedFrame = { bytes: Uint8Array; onPulled: () => void; };

/**
 * Encodes one {@link SseEvent} into its wire frame.
 *
 * A `data` payload containing newlines maps to one `data:` line per segment,
 * which the receiver rejoins with `\n`. JSON output has no raw newlines, so the
 * non-string form always yields a single `data:` line.
 */
export function encodeSseEvent(event: SseEvent): Uint8Array {
  let frame = "";
  if (event.id !== undefined) frame += `id: ${event.id}\n`;
  if (event.event !== undefined) frame += `event: ${event.event}\n`;
  if (event.retry !== undefined) frame += `retry: ${event.retry}\n`;
  const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
  const lines = data.split("\n");
  for (let i = 0; i < lines.length; i++) frame += `data: ${lines[i]}\n`;
  frame += "\n";
  return encoder.encode(frame);
}

/** Encodes a comment frame (`: text`), one line per newline-separated segment. */
export function encodeSseComment(text: string): Uint8Array {
  const lines = text.split("\n");
  let frame = "";
  for (let i = 0; i < lines.length; i++) frame += `: ${lines[i]}\n`;
  frame += "\n";
  return encoder.encode(frame);
}

/**
 * Single-producer/single-consumer async byte stream backing an SSE response.
 *
 * The producer enqueues encoded frames with {@link push}; the transport drains
 * them by iterating the stream. Buffering is one frame deep: a pushed frame's
 * promise resolves only once the consumer has pulled it, so an awaiting producer
 * cannot outrun a slow connection.
 *
 * @internal
 */
export class SseStream implements AsyncIterable<Uint8Array> {
  #queue: QueuedFrame[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  /** Enqueues one encoded frame. Resolves once the consumer pulls it. */
  push(bytes: Uint8Array): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise<void>((onPulled) => {
      this.#queue.push({ bytes, onPulled });
      this.#wakeConsumer();
    });
  }

  /**
   * Ends the stream gracefully: stops accepting frames but lets the consumer
   * drain whatever is already queued before the iterator returns.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wakeConsumer();
  }

  /**
   * Ends the stream abruptly: drops queued frames and unblocks any producer
   * awaiting one. Used when the request aborts and the consumer is gone, so the
   * frames can never be delivered.
   */
  abort(): void {
    if (this.#closed) return;
    this.#closed = true;
    const queue = this.#queue;
    this.#queue = [];
    for (let i = 0; i < queue.length; i++) queue[i]!.onPulled();
    this.#wakeConsumer();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      const frame = this.#queue.shift();
      if (frame) {
        yield frame.bytes;
        frame.onPulled();
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  #wakeConsumer(): void {
    const wake = this.#wake;
    if (wake) {
      this.#wake = null;
      wake();
    }
  }
}
