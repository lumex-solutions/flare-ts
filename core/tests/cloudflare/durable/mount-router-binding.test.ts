// End-to-end: the front-door Worker (default export = host.export()) forwards /testroom/:instance/*
// to the TestRoom DO via the explicit mount room.mount("/testroom/:name") (prefix strip + relative
// per-DO arc match), and a WebSocket upgrade survives the forward into the DO's acceptWebSocket handler.
import { reset, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(async () => {
  await reset();
});

describe("explicit DO mount via a real binding", () => {
  it("forwards /testroom/:instance/n to the DO per-DO arc (prefix stripped, relative match)", async () => {
    const res = await SELF.fetch("https://flare.test/testroom/rt-mount/n");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ n: 0 });
  });

  it("persists across forwarded requests to the same instance (POST /bump then GET /n)", async () => {
    await SELF.fetch("https://flare.test/testroom/rt-persist/bump", { method: "POST" });
    const res = await SELF.fetch("https://flare.test/testroom/rt-persist/n");
    expect(await res.json()).toMatchObject({ n: 1 });
  });

  it("upgrades a WebSocket through the router into the DO and echoes a message", async () => {
    const res = await SELF.fetch("https://flare.test/testroom/rt-ws/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    expect(ws).toBeDefined();
    ws!.accept();
    const echoed = await new Promise<string>((resolve) => {
      ws!.addEventListener("message", (e) => resolve(e.data as string));
      ws!.send("hi");
    });
    expect(echoed).toBe("echo:hi");
    ws!.close();
  });
});
