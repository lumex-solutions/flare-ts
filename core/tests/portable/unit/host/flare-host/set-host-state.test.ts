/**
 * Unit tests for {@link FlareHost} {@link SET_HOST_STATE} internal state transitions.
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
