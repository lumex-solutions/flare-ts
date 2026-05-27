import { describe, it, expect } from "vitest";
import { FlareHost } from "../../../../src/lib/host/flare-host.js";
import { makeAdapter } from "./_fixtures.js";

describe("FlareHost.state (getter)", () => {
  it("returns the initial 'starting' value before SET_HOST_STATE is invoked", () => {
    const host = new FlareHost(makeAdapter());
    expect(host.state).toBe("starting");
  });
});
