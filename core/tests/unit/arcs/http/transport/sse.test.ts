import { describe, expect, it } from "vitest";
import { encodeSseComment, encodeSseEvent, SseStream } from "../../../../../src/lib/arcs/http/transport/sse.js";

const decoder = new TextDecoder();
const decode = (bytes: Uint8Array): string => decoder.decode(bytes);

describe("encodeSseEvent", () => {
  it("emits a single `data:` line plus a blank terminator for string data", () => {
    expect(decode(encodeSseEvent({ data: "hello" }))).toBe("data: hello\n\n");
  });

  it("JSON-serializes non-string data into one `data:` line", () => {
    expect(decode(encodeSseEvent({ data: { a: 1, b: "x" } }))).toBe('data: {"a":1,"b":"x"}\n\n');
  });

  it("orders id, event, and retry fields before data", () => {
    const frame = decode(encodeSseEvent({ id: "7", event: "tick", retry: 3000, data: "go" }));
    expect(frame).toBe("id: 7\nevent: tick\nretry: 3000\ndata: go\n\n");
  });

  it("splits multi-line string data into one `data:` line per segment", () => {
    expect(decode(encodeSseEvent({ data: "line1\nline2" }))).toBe("data: line1\ndata: line2\n\n");
  });

  it("omits absent optional fields", () => {
    expect(decode(encodeSseEvent({ event: "ping", data: "1" }))).toBe("event: ping\ndata: 1\n\n");
  });
});

describe("encodeSseComment", () => {
  it("emits a `: text` line per segment", () => {
    expect(decode(encodeSseComment("keep-alive"))).toBe(": keep-alive\n\n");
  });
});

describe("SseStream", () => {
  async function drain(stream: SseStream): Promise<string[]> {
    const out: string[] = [];
    for await (const chunk of stream) out.push(decode(chunk));
    return out;
  }

  it("delivers pushed frames in order, then ends on close()", async () => {
    const stream = new SseStream();
    const collected = drain(stream);

    await stream.push(encodeSseEvent({ data: "a" }));
    await stream.push(encodeSseEvent({ data: "b" }));
    stream.close();

    expect(await collected).toEqual(["data: a\n\n", "data: b\n\n"]);
  });

  it("resolves push() only after the consumer pulls the frame (one-frame backpressure)", async () => {
    const stream = new SseStream();
    let pulled = false;

    const consume = (async () => {
      for await (const _chunk of stream) {
        // Defer the next pull a turn so the producer's awaited push cannot
        // resolve until this iteration hands control back.
        await Promise.resolve();
      }
    })();

    const push = stream.push(encodeSseEvent({ data: "x" })).then(() => {
      pulled = true;
    });

    expect(pulled).toBe(false);
    await push;
    expect(pulled).toBe(true);

    stream.close();
    await consume;
  });

  it("abort() drops queued frames and unblocks an awaiting producer", async () => {
    const stream = new SseStream();
    // No consumer is attached, so this push stays queued until abort().
    const push = stream.push(encodeSseEvent({ data: "lost" }));
    stream.abort();
    await expect(push).resolves.toBeUndefined();

    // A stream that aborted before iteration yields nothing.
    const out: string[] = [];
    for await (const chunk of stream) out.push(decode(chunk));
    expect(out).toEqual([]);
  });

  it("push() after close is a no-op that resolves immediately", async () => {
    const stream = new SseStream();
    stream.close();
    await expect(stream.push(encodeSseEvent({ data: "ignored" }))).resolves.toBeUndefined();
  });
});
