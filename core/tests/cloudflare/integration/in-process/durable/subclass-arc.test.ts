/**
 * Regression test for per-DO arc dispatch when the runtime constructs a wrapper subclass of the
 * registered Durable Object class. Drives `composeDurableInstance` (the public production-path
 * compose surface) with a subclass of the registered class, exactly as the runtime hands the DO
 * base class `this.constructor` at construction time, and asserts the ancestor's per-DO arc still
 * serves the request. White-box registration-internals coverage (DO_HOST stamping, durableRegistration
 * prototype-chain lookup) lives in tests/cloudflare/unit/host/runtime/cloudflare/registration.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { composeDurableInstance, DurableState, FlareDurableObject } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse } from "../../../../../src/index.js";
import { makeEnv, makeFakeDurableState } from "../../../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

describe("per-DO arc resolution through a subclass (runtime do-wrapper)", () => {
  it("composeDurableInstance through a subclass dispatches the ancestor's per-DO arc", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/front", () => new FlareResponse(200, { where: "front" }));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get(
      "/in-do",
      { inject: { ds: DurableState } },
      (_c, s) => new FlareResponse(200, { where: "do", id: s.ds.id.toString() }),
    );
    host.build();

    // Compose with the wrapper subclass, exactly as the runtime hands us `this.constructor`.
    class WrappedRoom extends Room {}
    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "alpha" }), makeEnv(), WrappedRoom);

    const res = await inst.fetch(new Request("https://do/in-do"));
    expect(await res.json()).toEqual({ where: "do", id: "alpha" });
  });
});
