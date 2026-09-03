/**
 * Hibernation-occurrence proofs, on real workerd. Real-binding suite: runs against wrangler bindings
 * with `fixtures/durable-worker.ts` as the worker under test. The white-box engine tests prove
 * hibernation SAFETY (every event reconstructs from the socket attachment alone); these prove
 * OCCURRENCE - the behaviors that keep a hibernating Durable Object cheap actually hold at runtime:
 *
 * - Non-wake: the configured auto-response pair answers client heartbeats inside the runtime, so a
 *   heartbeat never invokes DO code (the route's message counter must not move).
 * - Eviction survival: `evictDurableObject` tears the instance down with sockets hibernated (the
 *   production idle-eviction lifecycle); the SAME client socket keeps working afterward, `ws.state`
 *   comes back from the attachment, and a genuinely fresh instance served the wake (the in-memory
 *   marker changed). A route accidentally accepted residently would fail this: eviction would sever
 *   its socket.
 */
import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TestRoom } from "../../../fixtures/durable-worker.js";

async function connectCount(instance: string) {
  const res = await SELF.fetch(`https://flare.test/testroom/${instance}/count`, { headers: { Upgrade: "websocket" } });
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

describe("WS hibernation occurrence", () => {
  it("answers auto-response heartbeats without invoking any DO code", async () => {
    const c = await connectCount("hib-nonwake");

    // Three heartbeats: each must come back as the configured pong payload, answered by the runtime.
    for (let i = 0; i < 3; i++) {
      c.ws.send("hb");
      expect(await c.nextFrame()).toBe("hb-ack");
    }
    // The first REAL message proves the heartbeats never reached the message handler: the per-message
    // counter starts at 1. Had any "hb" woken the DO and dispatched, the counter would be past 1 (and
    // the earlier frames would have been "hits:N", failing the assertions above).
    c.ws.send("real");
    expect(await c.nextFrame()).toBe("hits:1");
    c.ws.close();
  });

  it("survives eviction: same socket, ws.state from the attachment, a fresh instance", async () => {
    const c = await connectCount("hib-evict");
    c.ws.send("a");
    expect(await c.nextFrame()).toBe("hits:1");

    // The generated Env types the binding's namespace as DurableObjectNamespace<undefined>; assert the
    // class so runInDurableObject's instance parameter types correctly.
    const stub = (env.TEST_ROOM as unknown as DurableObjectNamespace<TestRoom>).getByName("hib-evict");
    const before = await runInDurableObject(stub, (instance: TestRoom) => instance.marker);
    expect(await runInDurableObject(stub, (instance: TestRoom) => instance.marker)).toBe(before); // stable while live

    // The production idle-eviction lifecycle: instance torn down, hibernatable sockets preserved.
    await evictDurableObject(stub);

    // The SAME client socket still works, and the counter continued from the attachment-serialized
    // ws.state - nothing about the connection lived in the evicted instance's memory.
    c.ws.send("b");
    expect(await c.nextFrame()).toBe("hits:2");

    // The wake was served by a genuinely fresh instance, not a survivor.
    const after = await runInDurableObject(stub, (instance: TestRoom) => instance.marker);
    expect(after).not.toBe(before);
    c.ws.close();
  });
});
