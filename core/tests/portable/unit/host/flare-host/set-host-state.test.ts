/**
 * Unit tests for {@link FlareHost} {@link SET_HOST_STATE} internal state transitions and the
 * public whenState() lifecycle waiters they settle.
 */
import { describe, it, expect } from "vitest";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { SET_HOST_STATE } from "../../../../../src/lib/host/types/const.js";
import { makeAdapter } from "./_fixtures.js";

describe("FlareHost[SET_HOST_STATE]", () => {
  it("mutates internal state through each HostState value", () => {
    const host = new FlareHost(makeAdapter());
    expect(host.state).toBe("starting");
    host[SET_HOST_STATE]("ready");
    expect(host.state).toBe("ready");
    host[SET_HOST_STATE]("draining");
    expect(host.state).toBe("draining");
    host[SET_HOST_STATE]("stopped");
    expect(host.state).toBe("stopped");
  });
});

describe("FlareHost.whenState", () => {
  it("resolves immediately for the current state and every state already passed", async () => {
    const host = new FlareHost(makeAdapter());
    host[SET_HOST_STATE]("draining");

    // At-or-past semantics: waiting for an earlier state must not hang forever.
    await host.whenState("starting");
    await host.whenState("ready");
    await host.whenState("draining");
  });

  it("stays pending until the state is reached, then resolves", async () => {
    const host = new FlareHost(makeAdapter());
    let resolved = false;
    const waiter = host.whenState("draining").then(() => {
      resolved = true;
    });

    host[SET_HOST_STATE]("ready");
    await Promise.resolve();
    expect(resolved).toBe(false);

    host[SET_HOST_STATE]("draining");
    await waiter;
    expect(resolved).toBe(true);
  });

  it("a transition settles every waiter at or below it (skipping straight to stopped resolves a draining waiter)", async () => {
    const host = new FlareHost(makeAdapter());
    const draining = host.whenState("draining");
    const stopped = host.whenState("stopped");

    host[SET_HOST_STATE]("stopped");

    await draining;
    await stopped;
  });

  it("multiple waiters for the same state all resolve", async () => {
    const host = new FlareHost(makeAdapter());
    const a = host.whenState("ready");
    const b = host.whenState("ready");

    host[SET_HOST_STATE]("ready");

    await Promise.all([a, b]);
  });
});
