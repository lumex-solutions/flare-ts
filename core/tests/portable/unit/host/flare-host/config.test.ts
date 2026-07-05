/**
 * Unit tests for resolved host config before and after {@link FlareHost.build}.
 */
import { describe, it, expect } from "vitest";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { makeAdapter, registerMinimalPingRoute } from "./_fixtures.js";

describe("resolved host config", () => {
  it("returns an empty object before build has run", () => {
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    // #config stays {} until build() runs #compileConfig.
    expect(host.config).toEqual({});
  });

  it("returns the parsed config snapshot after build()", () => {
    const adapter = makeAdapter({
      flareJsonFile: { host: { env: "production", port: 9001 } },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.build();
    expect(host.config["host"]).toMatchObject({ env: "production", port: 9001 });
  });
});
