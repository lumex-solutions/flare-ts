import { describe, it, expect } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import { bun } from "../../../../src/lib/host/runtime/bun.js";
import { Logger } from "../../../../src/lib/logger/logger.js";
import { ConsoleTransport } from "../../../../src/lib/logger/transports/console.js";
import { Container } from "../../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../../src/lib/services/registration-map.js";

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

  it("createLogger(transports, container) returns a Logger instance composed from the supplied transports", () => {
    const container = new Container(
      new FlareRegistrationMap(),
      new Map(),
      { log: { level: "info" } } as unknown as JsonObject,
    );
    const logger = bun.createLogger([], container);
    expect(logger).toBeInstanceOf(Logger);
  });
});
