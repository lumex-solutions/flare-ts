/**
 * Unit tests for {@link FlareHost.scopedServices} and {@link FlareHost.singletonServices} live map references.
 */
import { describe, it, expect } from "vitest";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { Logger } from "../../../../../src/lib/logger/logger.js";
import { makeAdapter, registerMinimalPingRoute } from "./_fixtures.js";

describe("scoped and singleton service registries", () => {
  it("return live references to the underlying maps; mutations are visible to subsequent reads", () => {
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    const scopedBefore = host.scopedServices;
    const singletonsBefore = host.singletonServices;
    host.build();
    // Live map references: mutations after build() are visible through earlier getters.
    expect(host.singletonServices.get(Logger)).toBeInstanceOf(Logger);
    expect(singletonsBefore).toBe(host.singletonServices);
    expect(scopedBefore).toBe(host.scopedServices);
    expect(singletonsBefore.get(Logger)).toBeInstanceOf(Logger);
    expect(scopedBefore.length).toBe(0);
  });
});
