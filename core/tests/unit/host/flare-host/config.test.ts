import { describe, it, expect } from "vitest";
import { FlareHost } from "../../../../src/lib/host/flare-host.js";
import { makeAdapter, registerMinimalPingRoute } from "./_fixtures.js";

describe("FlareHost.config (getter)", () => {
  it("returns an empty object before #compileConfig runs", () => {
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    // No build() yet -> #compileConfig has not run -> #config is still its initial {}.
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
