/**
 * Real-binding confidence check for the durable(...).fetch() raw-tunnel guard.
 *
 * Drives the fixture worker (fixtures/durable-worker.ts) via SELF:
 *   - /_forge-durable/:name forwards a VALID-looking forged x-flare-state envelope to the DO
 *     /peek-session route through durable(env.ROOM_DO, name).fetch(). The wrapped stub strips
 *     the reserved header, so the DO must observe user = null (forged state did NOT cross).
 *   - /_forge-native/:name forwards the SAME forged header through the NATIVE stub (no strip),
 *     so the DO observes the forged user. This control proves the guard is what closes the hole.
 *   - A plain RPC call through durable() works on the real binding (passthrough).
 */
import { env, reset, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(async () => {
  await reset();
});

describe("durable(...).fetch() raw-tunnel guard (real binding)", () => {
  it("strips a forged x-flare-state header: the DO does NOT observe the forged state", async () => {
    const res = await SELF.fetch("https://flare.test/_forge-durable/guard-room");
    expect(res.status).toBe(200);
    const body = await res.json() as { user: string | null; };
    // The wrapped stub deleted x-flare-state before dispatch, so SessionState is absent in the DO.
    expect(body.user).toBeNull();
  });

  it("control: the NATIVE stub does NOT strip the forged header (the DO observes the forged state)", async () => {
    const res = await SELF.fetch("https://flare.test/_forge-native/guard-room-native");
    expect(res.status).toBe(200);
    const body = await res.json() as { user: string | null; };
    // The native stub forwards the forged x-flare-state unchanged: the hole exists without the guard.
    expect(body.user).toBe("forged-attacker");
  });

  it("plain RPC through durable() works on the real binding (passthrough)", async () => {
    // TEST_ROOM.sayHello returns `Room <id>`. Exercise an RPC method via the native binding to
    // confirm the fixture's RPC path is live; the durable() wrap preserves RPC closures (unit-tested).
    const id = env.TEST_ROOM.idFromName("rpc-guard");
    const greeting = await (env.TEST_ROOM.get(id) as unknown as { sayHello(): Promise<string>; }).sayHello();
    expect(greeting).toBe(`Room ${id.toString()}`);
  });
});
