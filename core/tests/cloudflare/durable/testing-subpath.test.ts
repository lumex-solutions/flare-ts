// Smoke-test for the new @flare-ts/core/cloudflare/testing public subpath.
//
// Imports composeDurableInstance, makeFakeDurableState, makeFakeStorage, and makeEnv
// from the relative src path (../../../src/cloudflare/testing.js) rather than the
// package self-path because core's own tests resolve via the vitest alias table, not
// the published exports map. The public package path @flare-ts/core/cloudflare/testing
// is valid for consumers once the package is built; inside the monorepo test suite the
// relative src import is the correct form.
import { describe, expect, it } from "vitest";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { FlareDurableObject } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { DurableState } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import {
  composeDurableInstance,
  makeFakeDurableState,
  makeFakeStorage,
  makeEnv,
} from "../../../src/cloudflare/testing.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

function cfJson() {
  return {
    host: { env: "test", requestIdHeader: false },
    log: { level: "fatal", format: "json" },
  };
}

describe("cloudflare/testing public subpath: composeDurableInstance + fake helpers", () => {
  it("composes a DO instance and dispatches a route (fetch works)", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));

    class SmokeRoom extends FlareDurableObject {
      static override deps = [DurableState] as const;
    }
    const room = host.durableObject(SmokeRoom);
    room.http.get("/ping", { inject: { ds: DurableState } }, (_ctx, scope) =>
      new FlareResponse(200, { id: scope.ds.id.toString() }),
    );
    host.build();

    const inst = composeDurableInstance(
      host,
      makeFakeDurableState({ name: "smoke-room" }),
      makeEnv({ REGION: "enam" }),
      SmokeRoom,
    );

    const res = await inst.fetch(new Request("https://do/ping"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "smoke-room" });
  });

  it("inject() resolves a service from the per-instance container", () => {
    class Counter extends FlareService {
      static override deps = [] as const;
      #n = 0;
      get n() { return this.#n; }
      bump() { return ++this.#n; }
    }

    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.scoped(Counter);
    host.http.get("/_", () => new FlareResponse(200));

    class CountRoom extends FlareDurableObject {
      static override deps = [Counter, DurableState] as const;
    }
    host.durableObject(CountRoom);
    host.build();

    const inst = composeDurableInstance(
      host,
      makeFakeDurableState({ name: "count-room" }),
      makeEnv(),
      CountRoom,
    );

    const counter = inst.inject([Counter], Counter) as Counter;
    counter.bump();
    counter.bump();
    expect(counter.n).toBe(2);
    // Same cached instance returned on second call.
    expect(inst.inject([Counter], Counter)).toBe(counter);
  });

  it("makeFakeStorage is a KV-only stub (get/put/delete/list round-trip)", async () => {
    const storage = makeFakeStorage();
    await storage.put("hello", "world");
    expect(await storage.get("hello")).toBe("world");
    const listed = await storage.list();
    expect(listed.get("hello")).toBe("world");
    await storage.delete("hello");
    expect(await storage.get("hello")).toBeUndefined();
  });

  it("makeFakeDurableState with custom storage shares the same storage reference", async () => {
    const storage = makeFakeStorage();
    const state = makeFakeDurableState({ name: "custom-storage", storage });
    expect(state.storage).toBe(storage);
    await state.storage.put("key", 42);
    expect(await storage.get("key")).toBe(42);
  });
});
