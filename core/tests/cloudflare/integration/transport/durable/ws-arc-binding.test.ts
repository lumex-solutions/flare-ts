/**
 * End-to-end (real bindings) for per-DO WebSocket connections: `room.ws` routes reached through the
 * explicit mount, injecting the DO's DurableState. Runs against wrangler bindings with
 * `fixtures/durable-worker.ts` as the worker under test. Mirrors the manual-acceptWebSocket test in
 * mount-router-binding.test.ts but drives the first-class arc.
 */
import { reset, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { echoOnce } from "../../../helpers/ws-binding.js";

afterEach(async () => {
  await reset();
});

describe("per-DO WebSocket arc over real bindings", () => {
  it("room.ws hosts a per-DO connection through the mount and injects DurableState", async () => {
    const { status, echoed } = await echoOnce(SELF, "https://flare.test/testroom/rt-arc/rt", "hi");
    expect(status).toBe(101);
    // The DO echoes `room:<durable-object-id>:hi`, proving the connection ran in the DO with DI.
    expect(echoed).toMatch(/^room:.+:hi$/);
  });

  it("room.ws routes the same DO instance name to one Durable Object", async () => {
    const a = await echoOnce(SELF, "https://flare.test/testroom/rt-same/rt", "a");
    const b = await echoOnce(SELF, "https://flare.test/testroom/rt-same/rt", "b");
    const idA = a.echoed.split(":")[1];
    const idB = b.echoed.split(":")[1];
    expect(idA).toBe(idB); // same mount instance name => same DO id
  });

  it("room.ws persists ws.state across messages via the socket attachment (hibernation round-trip)", async () => {
    const res = await SELF.fetch("https://flare.test/testroom/rt-state/count", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();

    // Each message reconstructs the connection from the attachment; a rising count proves ws.state (set at
    // open, incremented per message) round-tripped through serialize/deserialize, not in-memory carryover.
    const frames: string[] = [];
    let firstFrame!: () => void;
    const oneFrame = new Promise<void>((resolve) => (firstFrame = resolve));
    const twoFrames = new Promise<void>((resolve) => {
      ws.addEventListener("message", (e) => {
        frames.push(e.data as string);
        if (frames.length === 1) firstFrame();
        if (frames.length === 2) resolve();
      });
    });
    ws.send("a");
    await oneFrame; // the first reply landed, so the second send is a separate wake dispatch
    ws.send("b");
    await twoFrames;

    expect(frames).toEqual(["hits:1", "hits:2"]);
    ws.close();
  });

  it("room.ws honors the hibernate:false resident opt-out", async () => {
    const { status, echoed } = await echoOnce(SELF, "https://flare.test/testroom/rt-res/resident", "hi");
    expect(status).toBe(101);
    expect(echoed).toBe("resident:hi"); // the resident backing drove the handler, not the manual webSocketMessage
  });

  it("room.ws broadcasts a message between two connections in the same DO (real chat room)", async () => {
    // Two clients join the same room (same mount instance => same DO instance).
    const resA = await SELF.fetch("https://flare.test/testroom/lounge/chat", { headers: { Upgrade: "websocket" } });
    const resB = await SELF.fetch("https://flare.test/testroom/lounge/chat", { headers: { Upgrade: "websocket" } });
    expect(resA.status).toBe(101);
    expect(resB.status).toBe(101);
    const a = resA.webSocket!;
    const b = resB.webSocket!;
    a.accept();
    b.accept();

    // B's frame should arrive at A (and at B) because A sent it to the shared room.
    const gotAtA = new Promise<string>((resolve) => a.addEventListener("message", (e) => resolve(e.data as string)));
    const gotAtB = new Promise<string>((resolve) => b.addEventListener("message", (e) => resolve(e.data as string)));
    a.send("hello room");

    expect(await gotAtA).toBe("chat:hello room");
    expect(await gotAtB).toBe("chat:hello room"); // the other connection in the SAME DO received it
    a.close();
    b.close();
  });
});
