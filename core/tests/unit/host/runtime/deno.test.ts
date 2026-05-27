import { describe, it, expect, beforeAll } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import { Logger } from "../../../../src/lib/logger/logger.js";
import { ConsoleTransport } from "../../../../src/lib/logger/transports/console.js";
import { Container } from "../../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../../src/lib/services/registration-map.js";

// The deno.ts source module reads `Deno.env.toObject()` at module evaluation
// time. We must seed `globalThis.Deno` before the dynamic import below or the
// module body throws ReferenceError. The same goes for `Deno.cwd()` and
// `Deno.readTextFileSync` which back the `flareJsonFile` getter (covered by a
// deferred case in the spec — not exercised here).
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
let deno: typeof import("../../../../src/lib/host/runtime/deno.js")["deno"];

beforeAll(async () => {
  const mod = await import("../../../../src/lib/host/runtime/deno.js");
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

  it("createLogger(transports, container) returns a Logger instance", () => {
    const container = new Container(
      new FlareRegistrationMap(),
      new Map(),
      { log: { level: "info" } } as unknown as JsonObject,
    );
    const logger = deno.createLogger([], container);
    expect(logger).toBeInstanceOf(Logger);
  });
});
