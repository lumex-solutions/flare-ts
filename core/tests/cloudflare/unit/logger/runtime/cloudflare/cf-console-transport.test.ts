/**
 * Unit tests for {@link CfConsoleTransport}: format selection and output routing.
 * The wrangler frame-width behavior is a node console concern covered in the node
 * root's console suites.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import type { LogLevel, LogRecord } from "../../../../../../src/lib/logger/types.js";
import { HOST_CONFIG, LOG_CONFIG } from "../../../../../../src/lib/config/flare-config.js";
import { CfConsoleTransport } from "../../../../../../src/lib/logger/runtime/cloudflare/cf-console-transport.js";
import { Container } from "../../../../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../../../../src/lib/services/registration-map.js";
import { captureConsole, type ConsoleCapture } from "../../../../../portable/helpers/console-capture.js";

/**
 * Builds a Container seeded with `host` and `log` config sections.
 * The transport calls `this.config(HOST_CONFIG)` / `this.config(LOG_CONFIG)`
 * which in turn delegate to `container.resolveCfg`.
 */
function makeContainer(
  host: Record<string, unknown> = { env: "development" },
  log: Record<string, unknown> = {},
): Container {
  return new Container(new FlareRegistrationMap(), new Map(), { host, log } as unknown as JsonObject);
}

function makeRecord(partial: Partial<LogRecord> & { level: LogLevel; message: string; }): LogRecord {
  return {
    timestamp: partial.timestamp ?? 0,
    level: partial.level,
    message: partial.message,
    ...(partial.context !== undefined ? { context: partial.context } : {}),
    ...(partial.state !== undefined ? { state: partial.state } : {}),
    ...(partial.meta !== undefined ? { meta: partial.meta } : {}),
    ...(partial.error !== undefined ? { error: partial.error } : {}),
  };
}

describe("synchronous console transport output", () => {
  let capture: ConsoleCapture;

  beforeEach(() => {
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
  });

  // Primary Behavior
  it('transportName static is "console"', () => {
    expect(CfConsoleTransport.transportName).toBe("console");
  });

  it("static config declares [LOG_CONFIG, HOST_CONFIG]", () => {
    expect(CfConsoleTransport.config).toEqual([LOG_CONFIG, HOST_CONFIG]);
  });

  it('onStart() selects json format when log.format is unset and host.env !== "development"', () => {
    const t = new CfConsoleTransport(makeContainer({ env: "production" }, {}));
    t.onStart();
    t.write(makeRecord({ level: "info", message: "hi" }));
    expect(() => JSON.parse(capture.log[0]!)).not.toThrow();
  });

  it('onStart() selects pretty format when log.format is unset and host.env === "development"', () => {
    const t = new CfConsoleTransport(makeContainer({ env: "development" }, {}));
    t.onStart();
    t.write(makeRecord({ level: "info", message: "hi" }));
    expect(capture.log[0]).toContain("\x1b[");
    expect(() => JSON.parse(capture.log[0]!)).toThrow();
  });

  it('onStart() explicit log.format = "json" overrides host.env = "development"', () => {
    const t = new CfConsoleTransport(makeContainer({ env: "development" }, { format: "json" }));
    t.onStart();
    t.write(makeRecord({ level: "info", message: "hi" }));
    expect(() => JSON.parse(capture.log[0]!)).not.toThrow();
  });

  it('onStart() explicit log.format = "pretty" overrides host.env = "production"', () => {
    const t = new CfConsoleTransport(makeContainer({ env: "production" }, { format: "pretty" }));
    t.onStart();
    t.write(makeRecord({ level: "info", message: "hi" }));
    expect(capture.log[0]).toContain("\x1b[");
  });

  describe("level routing", () => {
    function prettyTransport(): CfConsoleTransport {
      const t = new CfConsoleTransport(makeContainer({ env: "development" }, { format: "pretty" }));
      t.onStart();
      return t;
    }

    it("routes warn to console.warn, error/fatal to console.error, everything else to console.log", () => {
      const t = prettyTransport();
      t.write(makeRecord({ level: "trace", message: "x" }));
      t.write(makeRecord({ level: "debug", message: "x" }));
      t.write(makeRecord({ level: "info", message: "x" }));
      t.write(makeRecord({ level: "warn", message: "x" }));
      t.write(makeRecord({ level: "error", message: "x" }));
      t.write(makeRecord({ level: "fatal", message: "x" }));
      expect(capture.log).toHaveLength(3);
      expect(capture.warn).toHaveLength(1);
      expect(capture.error).toHaveLength(2);
    });
  });
});
