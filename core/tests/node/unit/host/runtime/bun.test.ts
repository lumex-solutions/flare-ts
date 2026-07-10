/**
 * Executes on node deliberately: the placeholder adapter's contract is throwing loud OFF its
 * runtime, so the node pool is the honest home until a real bun adapter and pool exist.
 */
import { describe, it, expect } from "vitest";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { bun } from "../../../../../src/lib/host/runtime/bun/bun.js";
import { ConsoleTransport } from "../../../../../src/lib/logger/transports/console.js";

describe("bun adapter (module-scope constant)", () => {
  it("exposes runtime='bun', lifecycle='async', defaultLoggerTransports=[ConsoleTransport]", () => {
    expect(bun.runtime).toBe("bun");
    expect(bun.lifecycle).toBe("async");
    expect(bun.defaultLoggerTransports).toEqual([ConsoleTransport]);
    // defaultLoggerTransports is a single-element tuple referencing the imported class.
    expect(bun.defaultLoggerTransports.length).toBe(1);
    expect(bun.defaultLoggerTransports[0]).toBe(ConsoleTransport);
  });

  it("aliases env to process.env (same reference)", () => {
    expect(bun.env).toBe(process.env);
  });

  it("createApp() throws 'Bun runtime is not yet supported'", () => {
    expect(() => bun.createApp({} as never)).toThrow("Bun runtime is not yet supported");
  });

  it("createTestRequest() throws 'Bun runtime is not yet supported'", () => {
    expect(() => bun.createTestRequest({ method: "GET", url: "/" })).toThrow("Bun runtime is not yet supported");
  });

  it("satisfies HostRuntimeAdapter structurally: new FlareHost(bun) constructs without invoking the throwing entries", () => {
    // Construction reads adapter.env and registers config tokens only; createApp/createTestRequest
    // are invoked at build()/run(), so the placeholder's throws never fire here.
    expect(() => new FlareHost(bun)).not.toThrow();
  });
});
