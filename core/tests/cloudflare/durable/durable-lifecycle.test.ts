// Per-instance durable lifecycle: user-singleton onStart firing per instance, init-rejection
// resilience, the sync-lifecycle guard, and Bindings identity. Drives the real per-instance core
// via composeDurableInstance (workerd's native DurableObject base rejects a fake ctx).
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { composeDurableInstance } from "../../../src/lib/host/runtime/cloudflare/app.js";
import { Bindings } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
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

describe("durable per-instance singleton onStart", () => {
  it("a user singleton's onStart fires exactly once per instance, independently across instances", async () => {
    class Booted extends FlareService {
      static override deps = [] as const;
      starts = 0;
      override onStart(): void {
        this.starts++;
      }
    }

    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.singleton(Booted);
    host.http.get(
      "/starts",
      { inject: { booted: Booted } },
      (_c, s) => new FlareResponse(200, { starts: s.booted.starts }),
    );
    (host.build() as CloudflareApp).durableObject(); // finalize: register framework services + revalidate

    const a = composeDurableInstance(host, makeFakeDurableState({ name: "A" }), makeEnv());
    const b = composeDurableInstance(host, makeFakeDurableState({ name: "B" }), makeEnv());

    // onStart fired once per instance at compose time; the two graphs are independent (each reads 1).
    expect(await (await doFetch(a, new Request("https://do/starts"))).json()).toEqual({ starts: 1 });
    expect(await (await doFetch(b, new Request("https://do/starts"))).json()).toEqual({ starts: 1 });
  });
});

describe("durable init / lifecycle error paths", () => {
  it("a rejecting init does not poison the instance — its container is disposed and later fetches still work", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/", () => new FlareResponse(200, { ok: true }));
    (host.build() as CloudflareApp).durableObject();
    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "init" }), makeEnv());

    await expect(inst.runScoped({}, () => {
      throw new Error("init-boom");
    })).rejects.toThrow("init-boom");

    // The failed scoped run disposed its own container; the instance still serves.
    expect((await doFetch(inst, new Request("https://do/"))).status).toBe(200);
  });

  it("a user singleton whose onStart returns a Promise is rejected on the sync Cloudflare lifecycle", () => {
    class AsyncBoot extends FlareService {
      static override deps = [] as const;
      override async onStart(): Promise<void> {}
    }

    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.singleton(AsyncBoot);
    host.http.get("/", () => new FlareResponse(200));
    (host.build() as CloudflareApp).durableObject();

    expect(() => composeDurableInstance(host, makeFakeDurableState({ name: "x" }), makeEnv()))
      .toThrow(/Promise on the Cloudflare runtime/);
  });
});

describe("durable Bindings identity", () => {
  it("inject(Bindings).env is the same object across requests within one instance", async () => {
    const envs: Cloudflare.Env[] = [];

    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/env", { inject: { bindings: Bindings } }, (_c, s) => {
      envs.push(s.bindings.env);
      return new FlareResponse(200, { ok: true });
    });
    (host.build() as CloudflareApp).durableObject();
    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "env" }), makeEnv({ X: "1" }));

    await doFetch(inst, new Request("https://do/env"));
    await doFetch(inst, new Request("https://do/env"));

    expect(envs.length).toBe(2);
    expect(envs[0]).toBe(envs[1]);
  });
});
