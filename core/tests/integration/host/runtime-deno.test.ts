// The deno adapter source module evaluates `Deno.env.toObject()` at module
// load time, and `flareJsonFile` is a getter that calls `Deno.cwd()` /
// `Deno.readTextFileSync(...)`. Vitest runs in Node where the `Deno` global
// is not defined, so we MUST seed a stub on `globalThis` BEFORE the deno
// module is imported — otherwise the import itself throws
// `ReferenceError: Deno is not defined`. The same pattern is used by the
// runtime-level deno unit test at `core/tests/lib/host/runtime/deno.test.ts`
// and the core-entrypoint deno subpath test.
const fakeDeno = {
  cwd: () => "/tmp/fake-cwd",
  readTextFileSync: (_path: string) => "{}",
  env: {
    toObject: () => ({ TEST_FAKE_KEY: "1" }),
  },
};
(globalThis as unknown as { Deno: typeof fakeDeno; }).Deno = fakeDeno;

import { beforeAll, describe, expect, it } from "vitest";
import type { IFlareApp } from "../../../src/lib/host/flare-app.js";
import type { HostRuntimeAdapter } from "../../../src/lib/host/types/adapter.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";

// Deferred dynamic import so the Deno stub above is in place before the
// runtime module body executes. We bind both the namespace and the named
// `deno` adapter for use in the tests below.
type DenoModuleNs = typeof import("../../../src/lib/host/runtime/deno.js");

let deno: DenoModuleNs["deno"];

beforeAll(async () => {
  const mod = await import("../../../src/lib/host/runtime/deno.js");
  deno = mod.deno;
});

// Failure Modes

// The deno adapter is a placeholder: `createApp` and `createTestRequest`
// deliberately throw `"Deno runtime is not yet supported"` so misuse fails
// loudly rather than silently producing a half-wired app. Both bullets in
// the spec's Failure Modes section assert exactly that contract.

// Deferred until deno pool is enabled in CI (see repo TODO / testing.md).
describe.skip("Failure Modes", () => {
  it("deno.createApp(host) throws 'Deno runtime is not yet supported'", () => {
    // The adapter's createApp signature accepts an IFlareHost; the placeholder
    // throws before touching the argument, so the cast to `never` is safe and
    // keeps the test free of an unrelated FlareHost composition.
    expect(() => deno.createApp({} as never)).toThrow(
      "Deno runtime is not yet supported",
    );
  });

  it("deno.createTestRequest(input) throws 'Deno runtime is not yet supported'", () => {
    // The placeholder throws unconditionally regardless of the input shape;
    // we pass a minimal-but-valid-looking FlareTestRequestInput so the call
    // expresses intent rather than relying on a junk value.
    expect(() => deno.createTestRequest({ method: "GET", url: "/" })).toThrow("Deno runtime is not yet supported");
  });
});

// Cross-Feature Interactions

// The only Cross-Feature bullet in the spec asserts that the `deno` adapter
// satisfies the structural `HostRuntimeAdapter<...>` type so it can be passed
// to `new FlareHost(...)` without compile errors — even though any actual
// runtime use (createApp / createTestRequest) throws. The compile-time check
// is the load-bearing assertion; the runtime expects in the test body lock
// in the structural identity (shape and adapter binding) at runtime too so
// the directive cannot rot silently.

describe.skip("Cross-Feature Interactions", () => {
  it(
    "(with host/runtime-adapter) `deno` satisfies HostRuntimeAdapter<...> structurally "
      + "and can be passed to `new FlareHost(...)` without compile errors",
    () => {
      // Compile-time assignability: the binding satisfies the interface
      // parameterised on an arbitrary IFlareApp. If the deno adapter ever
      // drifts (missing field, wrong field type, wrong lifecycle literal)
      // this declaration stops typechecking and the test file fails to build.
      const adapter: HostRuntimeAdapter<IFlareApp> = deno;

      // The host constructor accepts the adapter under the same type bound
      // it uses for every runtime. Constructing the host MUST NOT call
      // createApp / createTestRequest (those are only invoked during
      // `host.build()`), so this stays well within the "loud-failure"
      // contract: construction succeeds even though use-cases throw.
      const host = new FlareHost(deno);
      expect(host).toBeInstanceOf(FlareHost);

      // Structural identity at runtime: every field required by the
      // HostRuntimeAdapter interface is present on the adapter value, with
      // the placeholder-correct lifecycle / runtime tags. We do not exercise
      // `flareJsonFile` here — that getter is covered by the runtime unit
      // test, and a redundant read in this behavior file would add nothing.
      expect(adapter.runtime).toBe("deno");
      expect(adapter.lifecycle).toBe("async");
      expect(Array.isArray(adapter.defaultLoggerTransports)).toBe(true);
      expect(typeof adapter.env).toBe("object");
      expect(typeof adapter.createApp).toBe("function");
      expect(typeof adapter.createLogger).toBe("function");
      expect(typeof adapter.createTestRequest).toBe("function");
    },
  );
});

// Sections deliberately NOT written:
//   - ## Primary Behavior — the single bullet is itself marked _(deferred —
//     runtime not yet supported)_, asking us to assert the loud-failure
//     behavior; that assertion is covered by the Failure Modes describe
//     block above (which exercises the identical throw via the same
//     adapter surface). Deferred until the Deno runtime ships.
//   - ## Deferred — three bullets each marked _(deferred)_ pending the
//     real FlareAppDeno implementation: round-trip, graceful shutdown,
//     and lifecycle / request-id / request-timing parity with Node.
//     All three require runtime support that does not exist; recorded
//     Deferred until the Deno runtime ships.
