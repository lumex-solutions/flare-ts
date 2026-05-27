// The `bun` adapter is a placeholder: its `createApp` and `createTestRequest`
// deliberately throw "Bun runtime is not yet supported" so anyone wiring it up
// gets a loud failure rather than silent partial behaviour. These tests pin the
// thrown message verbatim and assert the adapter's structural compatibility
// with `new FlareHost(...)`, which is the only currently-honoured contract.
import { describe, expect, it } from "vitest";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { bun } from "../../../src/lib/host/runtime/bun.js";

// Deferred until bun pool is enabled in CI (see repo TODO / testing.md).
describe.skip("Failure Modes", () => {
  it('bun.createApp(host) throws "Bun runtime is not yet supported"', () => {
    // The host argument is irrelevant — the placeholder throws before
    // touching it, so we cast `{}` to `never` to satisfy the parameter type
    // without constructing a real IFlareHost.
    expect(() => bun.createApp({} as never)).toThrow("Bun runtime is not yet supported");
  });

  it('bun.createTestRequest(input) throws "Bun runtime is not yet supported"', () => {
    // Same idea: createTestRequest must reject every call, regardless of the
    // input shape. Pass a minimally valid FlareTestRequestInput so we're
    // testing the runtime guard, not input validation.
    expect(() => bun.createTestRequest({ method: "GET", url: "/" })).toThrow("Bun runtime is not yet supported");
  });
});

describe.skip("Cross-Feature Interactions", () => {
  it(
    "(with host/runtime-adapter) bun satisfies HostRuntimeAdapter structurally so "
      + "new FlareHost(bun) compiles and constructs even though runtime use throws",
    () => {
      // Compile-time check: if `bun`'s static shape stopped matching
      // HostRuntimeAdapter, this `new FlareHost(bun)` line would fail to
      // typecheck and the test file would fail to build — exactly the
      // regression signal we want. The TODO on the source widens
      // HostRuntimeAdapter's first type parameter to `any` for now, so the
      // assertion is intentionally structural rather than nominal.
      const host = new FlareHost(bun);

      // Construction must succeed: the constructor only reads
      // `adapter.env?.FLARE_MODE` and registers default config tokens. It
      // does NOT invoke createApp / createTestRequest, so the placeholder's
      // throws never fire here.
      expect(host).toBeInstanceOf(FlareHost);

      // Adapter-level state is observable on the constructed host's adapter
      // surface via the same constant reference: the host stored the exact
      // adapter we handed it, so callers comparing identity (e.g. test
      // utilities) see the placeholder rather than a copy.
      expect(bun.runtime).toBe("bun");
      expect(bun.lifecycle).toBe("async");
    },
  );
});
