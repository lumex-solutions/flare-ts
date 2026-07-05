/**
 * Smoke-test for the white-box DO testing helpers on the @flare-ts/core/cloudflare entry.
 * Exercises composeDurableInstance and the makeFake* helpers via the monorepo src import path.
 */
import { describe, expect, it } from "vitest";
import {
  composeDurableInstance,
  DurableState,
  FlareDurableObject,
  makeEnv,
  makeFakeDurableState,
  makeFakeStorage,
} from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse, FlareService } from "../../../../../src/index.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

function cfJson() {
  return {
    host: { env: "test", requestIdHeader: false },
    log: { level: "fatal", format: "json" },
  };
}

describe("cloudflare entry testing helpers: composeDurableInstance + fakes", () => {
  it("the testing entry composes a durable instance that dispatches HTTP routes", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));

    class SmokeRoom extends FlareDurableObject {
      static override deps = [DurableState] as const;
    }
    const room = host.durableObject(SmokeRoom);
    room.http.get(
      "/ping",
      { inject: { ds: DurableState } },
      (_ctx, scope) => new FlareResponse(200, { id: scope.ds.id.toString() }),
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

  it("the composed instance resolves a scoped service from its per-instance container", () => {
    class Counter extends FlareService {
      static override deps = [] as const;
      #n = 0;
      get n() {
        return this.#n;
      }
      bump() {
        return ++this.#n;
      }
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

  it("the fake storage helper round-trips KV get, put, delete, and list", async () => {
    const storage = makeFakeStorage();
    await storage.put("hello", "world");
    expect(await storage.get("hello")).toBe("world");
    const listed = await storage.list();
    expect(listed.get("hello")).toBe("world");
    await storage.delete("hello");
    expect(await storage.get("hello")).toBeUndefined();
  });

  it("fake durable state accepts a custom storage object by reference", async () => {
    const storage = makeFakeStorage();
    const state = makeFakeDurableState({ name: "custom-storage", storage });
    expect(state.storage).toBe(storage);
    await state.storage.put("key", 42);
    expect(await storage.get("key")).toBe(42);
  });
});
