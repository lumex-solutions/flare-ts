import { describe, expect, it } from "vitest";
import type { FlareRequestExtension } from "../../../../src/lib/host/composition/extensions.js";
import type { HostRuntime } from "../../../../src/lib/host/types/types.js";
import { registerRequestExtension, requestExtensionsFor } from "../../../../src/lib/host/composition/extensions.js";

const ext = (name: string): FlareRequestExtension => ({ name, onRequest() {} });

describe("request extension registry", () => {
  it("resolves extensions registered for a runtime, scoped to that runtime", () => {
    const fake = "__test_runtime__" as HostRuntime;
    const e = ext("probe");
    registerRequestExtension(fake, e);

    expect(requestExtensionsFor(fake)).toContain(e);
    // Scoped: a different runtime does not see it.
    expect(requestExtensionsFor("node")).not.toContain(e);
  });

  it("is idempotent per (runtime, extension) pair", () => {
    const fake = "__test_runtime_idem__" as HostRuntime;
    const e = ext("once");
    registerRequestExtension(fake, e);
    registerRequestExtension(fake, e);
    expect(requestExtensionsFor(fake).filter((x) => x === e)).toHaveLength(1);
  });

  it("returns an empty list for an unregistered runtime", () => {
    expect(requestExtensionsFor("__never_registered__" as HostRuntime)).toEqual([]);
  });

  it("preserves registration order", () => {
    const fake = "__test_runtime_order__" as HostRuntime;
    const a = ext("a");
    const b = ext("b");
    registerRequestExtension(fake, a);
    registerRequestExtension(fake, b);
    expect(requestExtensionsFor(fake).map((e) => e.name)).toEqual(["a", "b"]);
  });
});
