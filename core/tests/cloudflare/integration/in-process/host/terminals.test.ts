/**
 * Regression tests for the Cloudflare terminal lifecycle: one host can register Durable Objects via
 * host.durableObject() and also take .export() without conflict (multi-DO coexistence), and a front-door
 * worker request does not attempt to resolve DurableState (HAZARD A regression guard).
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareApp } from "../../../../../src/cloudflare.js";
import { DurableState, FlareDurableObject } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse } from "../../../../../src/index.js";
import { makeEnv, makeExecutionContext } from "../../../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

function cfJson(host: JsonObject = {}): JsonObject {
  return {
    host: { env: "test", requestIdHeader: false, ...host },
    log: { level: "fatal", format: "json" },
  };
}

describe("CloudflareApp multi-DO coexistence and HAZARD A regression guard", () => {
  it(
    "regression: one host can register a DO and take .export() - DO registration before build does not prevent export terminal",
    async () => {
      // Register a DO class that declares DurableState as a dep.
      // This must not make DurableState available (or required) in the export's per-request graph.
      class Room extends FlareDurableObject {
        static override deps = [DurableState] as const;
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      // host.durableObject() must be called BEFORE host.build().
      host.durableObject(Room);
      host.http.get("/", () => new FlareResponse(200, { ok: true }));

      // .export() must not throw even though a DO is registered on the same host; a throw here
      // fails the test directly with its own stack.
      const handle = (host.build() as CloudflareApp).export();

      // HAZARD A regression guard: a front-door request to a route that does NOT inject
      // DurableState must return 200. If the worker's first-request init were to eagerly
      // resolve all registered services (including DurableState, which has no DurableObjectState
      // to seed it), this fetch would crash. It must not.
      const res = await handle.fetch(new Request("http://flare.test/"), makeEnv(), makeExecutionContext());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    },
  );
});
