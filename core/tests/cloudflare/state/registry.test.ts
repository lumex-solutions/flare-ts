// Token registry tests for the static state crossing module.
// Pure registry logic; no miniflare binding needed. Uses cfProdAdapter + FlareHost
// to register DO classes the same way production code does, then asserts the
// registry state exposed by the state-crossing module.
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { flareState } from "../../../src/lib/arcs/http/state/flare-state.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { FlareDurableObject } from "../../../src/lib/host/runtime/cloudflare/index.js";
import {
  keyForToken,
  registerStateTokens,
  staticStateTokens,
  tokenForKey,
} from "../../../src/lib/host/runtime/cloudflare/state-crossing.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

function cfJson(host: JsonObject = {}): JsonObject {
  return {
    host: { env: "test", requestIdHeader: false, ...host },
    log: { level: "fatal", format: "json" },
  };
}

describe("static state token registry", () => {
  it("registering a class with static state = [A, B] makes staticStateTokens return [A, B]", () => {
    const TokenA = flareState<string>("TokenA");
    const TokenB = flareState<number>("TokenB");

    class RoomA extends FlareDurableObject {
      static override deps = [] as const;
      static state = [TokenA, TokenB] as const;
    }

    registerStateTokens(RoomA);

    const tokens = staticStateTokens(RoomA);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(TokenA);
    expect(tokens[1]).toBe(TokenB);
  });

  it("tokenForKey(keyForToken(A)) === A (round-trip)", () => {
    const TokenC = flareState<boolean>("TokenC");

    class RoomB extends FlareDurableObject {
      static override deps = [] as const;
      static state = [TokenC] as const;
    }

    registerStateTokens(RoomB);

    const key = keyForToken(TokenC);
    expect(key).toBeDefined();
    expect(tokenForKey(key!)).toBe(TokenC);
  });

  it("a token shared across two DOs has a single stable key", () => {
    const SharedToken = flareState<string>("SharedToken");

    class RoomC extends FlareDurableObject {
      static override deps = [] as const;
      static state = [SharedToken] as const;
    }

    class RoomD extends FlareDurableObject {
      static override deps = [] as const;
      static state = [SharedToken] as const;
    }

    registerStateTokens(RoomC);
    registerStateTokens(RoomD);

    const keyC = keyForToken(SharedToken);
    expect(keyC).toBeDefined();

    // Both classes see the same token with the same key.
    expect(staticStateTokens(RoomC)).toContain(SharedToken);
    expect(staticStateTokens(RoomD)).toContain(SharedToken);

    // The key resolves back to the same token object from either class's perspective.
    expect(tokenForKey(keyC!)).toBe(SharedToken);
  });

  it("a class with no static state yields []", () => {
    class RoomE extends FlareDurableObject {
      static override deps = [] as const;
    }

    registerStateTokens(RoomE);

    expect(staticStateTokens(RoomE)).toEqual([]);
  });

  it("registerStateTokens is idempotent: calling twice does not duplicate keys", () => {
    const TokenD = flareState<string>("TokenD");

    class RoomF extends FlareDurableObject {
      static override deps = [] as const;
      static state = [TokenD] as const;
    }

    registerStateTokens(RoomF);
    const keyFirst = keyForToken(TokenD);

    registerStateTokens(RoomF);
    const keySecond = keyForToken(TokenD);

    expect(keyFirst).toBeDefined();
    expect(keyFirst).toBe(keySecond);
    expect(staticStateTokens(RoomF)).toHaveLength(1);
  });

  it("host.durableObject(cls) triggers registerStateTokens at registration time", () => {
    const TokenE = flareState<string>("TokenE");

    class RoomG extends FlareDurableObject {
      static override deps = [] as const;
      static state = [TokenE] as const;
    }

    const host = new FlareHost(cfProdAdapter(cfJson()));
    // Front-door route required for build() to succeed.
    host.http.get("/_health", () => new FlareResponse(200));
    host.durableObject(RoomG);

    // Should be registered after durableObject() call, before build().
    const key = keyForToken(TokenE);
    expect(key).toBeDefined();
    expect(tokenForKey(key!)).toBe(TokenE);
    expect(staticStateTokens(RoomG)).toContain(TokenE);

    host.build();
  });
});
