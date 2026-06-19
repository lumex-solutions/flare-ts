// Regression tests for the Cloudflare terminal lifecycle: terminals are single-shot (one per built
// app — which is what keeps the DurableState gate from being defeated by call order), the worker's
// first-request init is failure-atomic, and a user singleton's onStart fires once per isolate.
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import { makeEnv, makeExecutionContext } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

function cfJson(host: JsonObject = {}): JsonObject {
  return {
    host: { env: "test", requestIdHeader: false, ...host },
    log: { level: "fatal", format: "json" },
  };
}

describe("CloudflareApp terminals are single-shot", () => {
  it("taking a second terminal from one built app throws", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/", () => new FlareResponse(200, { ok: true }));
    const app = host.build() as CloudflareApp;

    app.worker();
    expect(() => app.worker()).toThrow(/exactly one Cloudflare terminal/);
    expect(() => app.durableObject()).toThrow(/already produced \.worker\(\)/);
  });

  it("durableObject() then worker() is rejected — a Worker can never inherit the DurableState gate", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/", () => new FlareResponse(200, { ok: true }));
    const app = host.build() as CloudflareApp;

    app.durableObject(); // registers Bindings + DurableState onto the shared host
    // Single-shot prevents a second terminal, so the accumulated DurableState can never leak to a worker.
    expect(() => app.worker()).toThrow(/already produced \.durableObject\(\)/);
  });
});

describe("worker() first-request init is failure-atomic", () => {
  it("a throwing user-singleton onStart rejects every request and never re-runs prior onStarts", async () => {
    const starts: string[] = [];
    class Good extends FlareService {
      static override deps = [] as const;
      override onStart(): void {
        starts.push("good");
      }
    }
    class Bad extends FlareService {
      static override deps = [] as const;
      override onStart(): void {
        throw new Error("boom-onstart");
      }
    }

    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.singleton(Good); // registered first → its onStart runs before Bad's
    host.singleton(Bad);
    host.http.get("/", () => new FlareResponse(200, { ok: true }));

    const handle = (host.build() as CloudflareApp).worker();
    const send = (): Promise<Response> => handle.fetch(new Request("http://do/"), makeEnv(), makeExecutionContext());

    await expect(send()).rejects.toThrow("boom-onstart");
    await expect(send()).rejects.toThrow("boom-onstart");

    // Good.onStart ran exactly once: the latched failure short-circuits the retry instead of
    // re-running the partial seed + onStart (which would push "good" a second time).
    expect(starts).toEqual(["good"]);
  });
});

describe("worker() per-isolate singleton onStart", () => {
  it("a user singleton's onStart fires once per isolate, not per request", async () => {
    let starts = 0;
    class Booted extends FlareService {
      static override deps = [] as const;
      override onStart(): void {
        starts++;
      }
    }

    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.singleton(Booted);
    host.http.get("/", () => new FlareResponse(200, { ok: true }));

    const handle = (host.build() as CloudflareApp).worker();
    await handle.fetch(new Request("http://do/"), makeEnv(), makeExecutionContext());
    await handle.fetch(new Request("http://do/"), makeEnv(), makeExecutionContext());

    expect(starts).toBe(1);
  });
});
