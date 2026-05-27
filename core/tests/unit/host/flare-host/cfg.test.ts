import { describe, it, expect } from "vitest";
import { FlareHost } from "../../../../src/lib/host/flare-host.js";
import { makeAdapter } from "./_fixtures.js";

describe("FlareHost.cfg", () => {
  it("registers passed tokens and chain-returns `this`", () => {
    const host = new FlareHost(makeAdapter());
    const out = host.cfg();
    expect(out).toBe(host);
  });

  it("variadic with zero args returns `this` unchanged", () => {
    const host = new FlareHost(makeAdapter());
    expect(host.cfg()).toBe(host);
  });
});
