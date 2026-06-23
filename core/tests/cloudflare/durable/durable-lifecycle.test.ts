// Per-instance durable lifecycle: request-error isolation and Bindings identity.
// Drives the real per-instance core via composeDurableInstance (workerd's native
// DurableObject base rejects a fake ctx).
//
// Removed cases from the original file:
// - "a user singleton's onStart fires exactly once per instance" (Booted): the
//   singleton onStart lifecycle does not exist on Cloudflare. host.singleton()
//   throws; there is nothing to test here.
// - "a user singleton whose onStart returns a Promise is rejected" (AsyncBoot):
//   same reason - singleton registration is forbidden on CF, so the async-onStart
//   guard is unreachable via the public API.
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { composeDurableInstance, FlareDurableObject } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { Bindings, DurableState } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { makeEnv, makeFakeDurableState } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

type Instance = ReturnType<typeof composeDurableInstance>;

function cfJson(host: JsonObject = {}): JsonObject {
  return {
    host: { env: "test", requestIdHeader: false, ...host },
    log: { level: "fatal", format: "json" },
  };
}
function doFetch(inst: Instance, request: Request): Promise<Response> {
  return inst.fetch(request);
}

describe("durable init / lifecycle error paths", () => {
  it("a throwing request handler does not poison the instance; later fetches still work", async () => {
    // A handler that throws yields a 500 response but does not corrupt the instance's
    // container. Subsequent requests to the same instance are served normally,
    // demonstrating request-error isolation in fetch().
    const host = new FlareHost(cfProdAdapter(cfJson()));

    class TestLifecycleDo extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(TestLifecycleDo);
    room.http.get("/boom", () => {
      throw new Error("request-boom");
    });
    room.http.get("/", () => new FlareResponse(200, { ok: true }));
    host.http.get("/_", () => new FlareResponse(200));
    host.build();

    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "inst" }), makeEnv(), TestLifecycleDo);

    // A request that throws returns 500 but does not poison the instance.
    expect((await doFetch(inst, new Request("https://do/boom"))).status).toBe(500);

    // The instance still serves subsequent requests correctly.
    expect((await doFetch(inst, new Request("https://do/"))).status).toBe(200);
  });
});

describe("durable Bindings identity", () => {
  it("inject(Bindings).env is the same object across requests within one instance", async () => {
    const envs: Cloudflare.Env[] = [];

    const host = new FlareHost(cfProdAdapter(cfJson()));

    class TestBindingsDo extends FlareDurableObject {
      static override deps = [Bindings, DurableState];
    }
    const room = host.durableObject(TestBindingsDo);
    room.http.get("/env", { inject: { bindings: Bindings } }, (_c, s) => {
      envs.push(s.bindings.env);
      return new FlareResponse(200, { ok: true });
    });
    host.http.get("/_", () => new FlareResponse(200));
    host.build();

    const inst = composeDurableInstance(
      host,
      makeFakeDurableState({ name: "env" }),
      makeEnv({ X: "1" }),
      TestBindingsDo,
    );

    await doFetch(inst, new Request("https://do/env"));
    await doFetch(inst, new Request("https://do/env"));

    expect(envs.length).toBe(2);
    expect(envs[0]).toBe(envs[1]);
  });
});
