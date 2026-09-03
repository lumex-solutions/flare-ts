/**
 * Storage-mutating real-binding tests for the GENERATED Durable Object class. These exercise the
 * write/read/alarm glue that the read-only `do-binding.test.ts` smoke cannot. Requires
 * @cloudflare/vitest-pool-workers >= 0.15: isolation is per test FILE, and `reset()` /
 * `abortAllDurableObjects()` reset state in-memory via `workerd:unsafe` with no filesystem unlink
 * (unlinking the DO's SQLite while workerd holds it open breaks on Windows: cloudflare/workers-sdk
 * #10511 / #9913 / #11031). Each test uses a unique DO id, and `afterEach(reset)` wipes all binding
 * data between tests (the documented isolation pattern).
 */
import { abortAllDurableObjects, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

afterEach(async () => {
  await reset();
});

const bump = (stub: DurableObjectStub) =>
  stub.fetch(new Request("https://do/bump", { method: "POST" })).then((r) => r.json());
const read = (stub: DurableObjectStub) => stub.fetch(new Request("https://do/n")).then((r) => r.json());

describe("Flare Durable Object storage via a real binding", () => {
  it("persists writes across requests to the same instance (POST /bump then GET /n)", async () => {
    const id = env.TEST_ROOM.idFromName("rt-http");
    const stub = env.TEST_ROOM.get(id);

    expect(await bump(stub)).toEqual({ n: 1 });
    expect(await bump(stub)).toEqual({ n: 2 });
    // A fresh read re-hydrates the counter from durable storage via `init`.
    expect(await read(stub)).toEqual({ n: 2, id: id.toString(), flag: "on" });
  });

  it("exposes the DO's real DurableObjectState.storage via runInDurableObject", async () => {
    const stub = env.TEST_ROOM.get(env.TEST_ROOM.idFromName("rt-direct"));

    await bump(stub);
    const stored = await runInDurableObject(stub, (_i, state) => state.storage.get<number>("n"));
    expect(stored).toBe(1);
  });

  it("reset() clears persisted DO storage without a filesystem unlink (the Windows-safe path)", async () => {
    const id = env.TEST_ROOM.idFromName("reset-target");
    expect(await bump(env.TEST_ROOM.get(id))).toEqual({ n: 1 });

    await reset();

    // Storage wiped - the rebuilt instance's `init` finds nothing, so counter is back to 0.
    expect(await read(env.TEST_ROOM.get(id))).toMatchObject({ n: 0 });
  });

  it("abortAllDurableObjects() evicts the live instance but preserves persisted storage", async () => {
    const id = env.TEST_ROOM.idFromName("abort-target");
    expect(await bump(env.TEST_ROOM.get(id))).toEqual({ n: 1 });

    await abortAllDurableObjects();

    // Instance evicted, not wiped - the rebuilt instance's `init` re-hydrates n from storage.
    expect(await read(env.TEST_ROOM.get(id))).toMatchObject({ n: 1 });
  });

  it("runs the alarm(info) entrypoint via runDurableObjectAlarm and threads AlarmInvocationInfo", async () => {
    const stub = env.TEST_ROOM.get(env.TEST_ROOM.idFromName("alarm-target"));

    // Nothing scheduled yet.
    expect(await runDurableObjectAlarm(stub)).toBe(false);

    // Schedule for the future so it stays pending (an alarm at "now" auto-delivers, leaving nothing
    // to force); runDurableObjectAlarm then runs it immediately regardless of its scheduled time.
    await runInDurableObject(stub, (_i, state) => state.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // The entrypoint recorded what workerd handed it. `runDurableObjectAlarm` is a forced invocation
    // that threads no AlarmInvocationInfo, so the entrypoint sees `info === undefined` and its
    // `info?.x ?? null` fallback records nulls - proving alarm() ran and the optional-info path holds.
    const alarmInfo = await runInDurableObject(stub, (_i, state) => state.storage.get("alarmInfo"));
    expect(alarmInfo).toEqual({ isRetry: null, retryCount: null });
  });
});
