/**
 * Unit tests for the deno HostRuntimeAdapter placeholder: runtime identity, throwing
 * createApp/createTestRequest, and structural FlareHost construction. Executes on the
 * node pool because the placeholder throws off its runtime. globalThis.Deno must be
 * seeded before the dynamic import or the module body throws.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { ConsoleTransport } from "../../../../../src/lib/logger/transports/console.js";

const fakeEnv: Record<string, string> = { TEST_FAKE_KEY: "1" };
const denoStub = {
  cwd: () => "/tmp/fake-cwd",
  readTextFileSync: (_path: string) => "{}",
  env: {
    toObject: () => ({ ...fakeEnv }),
  },
};

(globalThis as unknown as { Deno: typeof denoStub; }).Deno = denoStub;

// Defer the import so the global is in place when the module body runs.
let deno: typeof import("../../../../../src/lib/host/runtime/deno/deno.js")["deno"];

beforeAll(async () => {
  const mod = await import("../../../../../src/lib/host/runtime/deno/deno.js");
  deno = mod.deno;
});

describe("deno adapter (module-scope constant)", () => {
  it("exposes runtime='deno', lifecycle='async', defaultLoggerTransports=[ConsoleTransport]", () => {
    expect(deno.runtime).toBe("deno");
    expect(deno.lifecycle).toBe("async");
    expect(deno.defaultLoggerTransports).toEqual([ConsoleTransport]);
  });

  it("createApp() throws 'Deno runtime is not yet supported'", () => {
    expect(() => deno.createApp({} as never)).toThrow("Deno runtime is not yet supported");
  });

  it("createTestRequest() throws 'Deno runtime is not yet supported'", () => {
    expect(() => deno.createTestRequest({ method: "GET", url: "/" })).toThrow("Deno runtime is not yet supported");
  });

  it("satisfies HostRuntimeAdapter structurally: new FlareHost(deno) constructs without invoking the throwing entries", () => {
    // Construction reads adapter.env and registers config tokens only; createApp/createTestRequest
    // are invoked at build()/run(), so the placeholder's throws never fire here.
    expect(() => new FlareHost(deno)).not.toThrow();
  });
});
