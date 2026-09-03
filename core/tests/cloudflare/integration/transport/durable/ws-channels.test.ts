/**
 * The injectable WebSocketChannels capability on a real Durable Object: an HTTP route on the DO publishes
 * into the instance's channel domain and a hibernating WS connection subscribed to that channel
 * receives it - HTTP -> WS broadcast with no live connection involved. Real-binding suite: runs against
 * wrangler bindings with `fixtures/durable-worker.ts` as the worker under test. This is the pattern an
 * arc-level publish could never serve on a DO (one arc per class, one domain per instance).
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function connectChat(instance: string) {
  const res = await SELF.fetch(`https://flare.test/testroom/${instance}/chat`, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const frames: string[] = [];
  const waiters: Array<(f: string) => void> = [];
  ws.accept();
  ws.addEventListener("message", (e) => {
    const frame = String(e.data);
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  return {
    ws,
    nextFrame(): Promise<string> {
      const queued = frames.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), 8000);
        waiters.push((f) => {
          clearTimeout(timer);
          resolve(f);
        });
      });
    },
  };
}

describe("WebSocketChannels on a Durable Object", () => {
  it("an HTTP route on the DO broadcasts to the instance's subscribed connections", async () => {
    const a = await connectChat("announce-room");
    const b = await connectChat("announce-room");

    const res = await SELF.fetch("https://flare.test/testroom/announce-room/announce", {
      method: "POST",
      body: "deploy-done",
    });
    expect(res.status).toBe(200);

    // BOTH connections receive it: the publisher is not a connection, so nobody is excluded.
    expect(await a.nextFrame()).toBe("announce:deploy-done");
    expect(await b.nextFrame()).toBe("announce:deploy-done");
    a.ws.close();
    b.ws.close();
  });
});
