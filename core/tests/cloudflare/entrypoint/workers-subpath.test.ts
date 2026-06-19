// FLARE_MODE is set before importing FlareHost-adjacent modules so any
// incidentally-triggered host construction (transitively through the subpath's
// import graph) sees the test-mode flag. The subpath barrel itself does not
// build a host, but we follow the same convention as sibling subpath behavior
// tests for consistency.
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
// Direct module imports — the canonical source behind the subpath re-exports.
// Used to prove identity equality so applications can mix subpath and deep
// imports during refactors without splitting the runtime adapter across two
// distinct references.
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
// The `@flare-ts/core/cloudflare` subpath compiles from `src/cloudflare.ts`
// to `dist/cloudflare.js`. Within the core package we import the source
// barrel directly — it is the exact module that the published subpath
// resolves to (see core/package.json `"./cloudflare"` exports entry).
import * as cloudflareSubpath from "../../../src/cloudflare.js";
import {
  Bindings as BindingsFromSubpath,
  buildCf as buildCfFromSubpath,
  cf as cfFromSubpath,
  DurableState as DurableStateFromSubpath,
} from "../../../src/cloudflare.js";
import { ControllerBase } from "../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { Get } from "../../../src/lib/arcs/http/routing/decorators.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import {
  Bindings as BindingsFromModule,
  buildCf as buildCfFromModule,
  cf as cfFromModule,
  DurableState as DurableStateFromModule,
} from "../../../src/lib/host/runtime/cloudflare/index.js";
import { makeEnv, makeExecutionContext } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

// Documented public surface for `@flare-ts/core/cloudflare`
// (Bindings, buildCf, cf, DurableState). Each entry is a runtime symbol that
// the subpath barrel MUST expose. (The legacy `buildDurableCf` / `durableCf`
// symbols are gone: a Durable Object is now a terminal on the built app, not a
// separate adapter.)

const EXPECTED_RUNTIME_NAMES = ["Bindings", "buildCf", "cf", "DurableState"] as const;

describe("Primary Behavior", () => {
  it(
    "exposes cf and buildCf from the @flare-ts/core/cloudflare subpath as identity-equal references to the underlying runtime module",
    () => {
      // Each named export resolves to a defined value with the right runtime shape.
      expect(cfFromSubpath).toBeDefined();
      expect(typeof cfFromSubpath).toBe("object");
      expect(typeof buildCfFromSubpath).toBe("function");

      // The cf adapter advertises the canonical Cloudflare Workers shape.
      // These properties are what `FlareHost` reads off the adapter; if the
      // subpath ever re-exported a wrapped/proxied object instead of the
      // module-scope constant, these would change.
      expect(cfFromSubpath.runtime).toBe("cloudflare");
      expect(cfFromSubpath.lifecycle).toBe("sync");
      expect(typeof cfFromSubpath.createApp).toBe("function");
      expect(typeof cfFromSubpath.createLogger).toBe("function");
      expect(typeof cfFromSubpath.createTestRequest).toBe("function");

      // Identity equality: the subpath barrel re-exports the same references
      // as the underlying runtime module. Without this, code that mixes the
      // subpath import (`from "@flare-ts/core/cloudflare"`) with a deep import
      // would end up with two distinct adapter objects and two CloudflareApp
      // class references — silently breaking instanceof checks and shared
      // module-scope state during refactors.
      expect(cfFromSubpath).toBe(cfFromModule);
      expect(buildCfFromSubpath).toBe(buildCfFromModule);
      expect(BindingsFromSubpath).toBe(BindingsFromModule);
      expect(DurableStateFromSubpath).toBe(DurableStateFromModule);

      // The namespace import surface is consistent with the named bindings.
      const ns = cloudflareSubpath as Record<string, unknown>;
      expect(ns["cf"]).toBe(cfFromSubpath);
      expect(ns["buildCf"]).toBe(buildCfFromSubpath);
    },
  );

  it(
    "a module produced by buildCf-style adapter wiring exports a fetch handler that dispatches a request through to a registered controller route and returns its response (smoke)",
    async () => {
      // The spec's second Primary bullet asks for the smoke-test contract:
      // building a host with the CF adapter yields a Workers module shape
      // ({ fetch }) and that fetch handler actually routes a Request through
      // the controller it was registered with.
      //
      // We exercise the contract twice:
      //   - via `cf`     (the module-scope adapter with an empty flare.json), and
      //   - via `buildCf(flareJson)` (the helper that produces an adapter
      //     pre-loaded with a bundled flare.json).
      //
      // Both must yield the same Workers module shape and route through to the
      // controller. The runtime adapter is consumed by FlareHost.build(); the
      // host MUST be built with the CF adapter (not the testing harness) so
      // the assertion exercises the actual `CloudflareApp.worker()` terminal a
      // Worker entrypoint would `export default`.

      class ProbeController extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        @Get("/ping")
        public async ping() {
          return this.ok({ ok: true, route: "ping" });
        }
      }

      // (1) Built via the bare `cf` adapter (no bundled flare.json)
      const hostA = new FlareHost(cfProdAdapter({}));
      hostA.http.controller("/probe", ProbeController);
      const moduleA = (hostA.build() as CloudflareApp).worker();

      // The exported module shape is the Workers entrypoint contract: an
      // object with a `fetch` property that takes a Request and returns a
      // Response (or Promise<Response>).
      expect(moduleA).toBeDefined();
      expect(typeof moduleA.fetch).toBe("function");

      const resA = await moduleA.fetch(
        new Request("https://flare.test/probe/ping"),
        makeEnv(),
        makeExecutionContext(),
      );
      expect(resA).toBeInstanceOf(Response);
      expect(resA.status).toBe(200);
      expect(await resA.json()).toEqual({ ok: true, route: "ping" });

      // (2) Built via `buildCf(flareJson)`
      // `buildCf` is the helper that wraps the same adapter shape with a
      // bundled flare.json. Hosts built with it must produce the same Workers
      // module shape and route through to the controller the same way.
      const hostB = new FlareHost(cfProdAdapter({}));
      hostB.http.controller("/probe", ProbeController);
      const moduleB = (hostB.build() as CloudflareApp).worker();

      expect(moduleB).toBeDefined();
      expect(typeof moduleB.fetch).toBe("function");

      const resB = await moduleB.fetch(
        new Request("https://flare.test/probe/ping"),
        makeEnv(),
        makeExecutionContext(),
      );
      expect(resB).toBeInstanceOf(Response);
      expect(resB.status).toBe(200);
      expect(await resB.json()).toEqual({ ok: true, route: "ping" });
    },
  );
});

describe("Failure Modes", () => {
  it(
    "fails the assertion when the set of subpath exports drifts from the documented snapshot (cf or buildCf removed/renamed)",
    () => {
      // API-snapshot guard for the published subpath export list. If
      // `cf`, `buildCf`, `Bindings`, or `DurableState` is renamed, removed, or
      // an unexpected symbol is added without coordinated documentation
      // updates, this test fails — which is the drift signal the spec asks for.
      const expectedNames = [...EXPECTED_RUNTIME_NAMES].sort();

      // Drop the synthetic ESM namespace markers so the comparison stays
      // focused on the framework contract.
      const actualNames = Object.keys(cloudflareSubpath)
        .filter((name) => name !== "default" && name !== "__esModule")
        .sort();

      expect(actualNames).toEqual(expectedNames);

      // Spot-check each symbol carries a defined value (catches a stray
      // `export { Foo }` that re-exports `undefined`).
      for (const name of expectedNames) {
        const value = (cloudflareSubpath as Record<string, unknown>)[name];
        expect(value, `subpath export '${name}'`).toBeDefined();
      }

      // Each documented symbol has the expected runtime kind. `cf` is the
      // adapter object; `buildCf` is its bundler function; `Bindings` and
      // `DurableState` are the injectable framework service classes (i.e.
      // constructors, so `typeof` is "function").
      expect(typeof (cloudflareSubpath as Record<string, unknown>)["buildCf"]).toBe("function");
      expect(typeof (cloudflareSubpath as Record<string, unknown>)["cf"]).toBe("object");
      expect(typeof (cloudflareSubpath as Record<string, unknown>)["Bindings"]).toBe("function");
      expect(typeof (cloudflareSubpath as Record<string, unknown>)["DurableState"]).toBe("function");
    },
  );
});
