/**
 * In-process integration tests for log config resolution, logger bootstrap effects,
 * and ALS context propagation. Requires FLARE_MODE=test before adapter imports.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { SingletonExtension } from "../../../../../src/lib/host/extensions/singleton.js";
import type { FlareAppNode } from "../../../../../src/lib/host/runtime/node.js";
import type { HostRuntimeAdapter } from "../../../../../src/lib/host/types/adapter.js";
import type { LoggerTransportClass } from "../../../../../src/lib/logger/types.js";
import { FlareHost, FlareService, LOG_CONFIG, LoggerTransport, type FlareLogConfig } from "../../../../../src/index.js";
import { loggerALS, type LogRecord } from "../../../../../src/lib/logger/types.js";
// FlareLogConfig used in the cross-feature test's `observed` typing below.
import { node } from "../../../../../src/node.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

// Helpers

/**
 * Builds a HostRuntimeAdapter that mirrors the production `node` adapter but
 * injects a synthetic `flare.json` and `env` map. The real adapter reads
 * `flare.json` from `process.cwd()` via a getter, which would trigger a real
 * filesystem read if we spread `...node`. Constructing the object explicitly
 * (and pulling only the safe fields off `node`) keeps the test hermetic.
 */
function adapterWith(
  opts: { flareJson?: JsonObject; env?: Record<string, string | undefined>; },
): HostRuntimeAdapter<FlareAppNode, LoggerTransportClass, "async", SingletonExtension> {
  return {
    runtime: node.runtime,
    lifecycle: node.lifecycle,
    flareJsonFile: opts.flareJson ?? {},
    env: { FLARE_MODE: "test", ...(opts.env ?? {}) },
    defaultLoggerTransports: node.defaultLoggerTransports,
    createApp: node.createApp,
    createLogger: node.createLogger,
    createTestRequest: node.createTestRequest,
    extendHost: node.extendHost!,
  };
}

// Return type is inferred from `new FlareHost(adapterWith(opts))` so the
// downstream `.build().test()` chain (which depends on the precise
// HostRuntimeAdapter type) typechecks. An explicit `FlareHost<FlareAppNode>`
// annotation collapses the generic to `never` because the type parameter is
// supposed to be the adapter, not the app.
function testHost(opts: { flareJson?: JsonObject; env?: Record<string, string | undefined>; }) {
  const host = new FlareHost(adapterWith(opts));
  registerMinimalPingRoute(host);
  return host;
}

/**
 * In-memory transport: captures every `LogRecord` it receives so tests can
 * assert filtering, context stamping, and per-transport overrides without
 * driving the console transport's formatting code paths.
 */
class CapturingTransport extends LoggerTransport {
  static override readonly transportName = "capture";
  static override deps: never[] = [];

  // Static because the Logger instantiates transports itself; instances are
  // not retrievable from outside via DI. A per-class static buffer is the
  // simplest accessible record sink.
  static records: LogRecord[] = [];

  override write(record: LogRecord): void {
    CapturingTransport.records.push(record);
  }

  static reset(): void {
    CapturingTransport.records = [];
  }
}

/**
 * Pretty-mode-friendly capturer: distinct `transportName` so a config block
 * like `transports: { capture: { level: "warn" } }` doesn't collide with
 * other tests that share the suite. (Kept separate from CapturingTransport
 * so per-transport overrides can target one without affecting the other.)
 */
class SecondCapturingTransport extends LoggerTransport {
  static override readonly transportName = "capture-2";
  static override deps: never[] = [];
  static records: LogRecord[] = [];

  override write(record: LogRecord): void {
    SecondCapturingTransport.records.push(record);
  }

  static reset(): void {
    SecondCapturingTransport.records = [];
  }
}

/**
 * Captures the formatted lines that `ConsoleTransport` writes via console.log.
 * The pretty-vs-json behavior is observable by inspecting whether the emitted
 * line is a JSON object (json mode) or a colorized human block (pretty mode).
 */
function captureConsole(): { logs: string[]; warns: string[]; errors: string[]; restore: () => void; } {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  return {
    logs,
    warns,
    errors,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

// Primary Behavior

describe("Primary Behavior", () => {
  it("resolves log to documented defaults when flare.json and FLARE__LOG__ env vars are absent", async () => {
    const host = testHost({ flareJson: {}, env: {} });
    const app = await host.build().test();
    try {
      const log = host.config.log!;
      expect(log.level).toBe("info");
      expect(log.format).toBe("json");
      expect(log.enableContext).toBe(false);
      expect(log.transports).toBeUndefined();
    } finally {
      await app.stop();
    }
  });

  it("drops every transport's effective threshold to debug when log.level=debug and no per-transport override is set", async () => {
    CapturingTransport.reset();
    SecondCapturingTransport.reset();
    const host = testHost({ flareJson: { log: { level: "debug" } }, env: {} });
    host.logging.transport(CapturingTransport);
    host.logging.transport(SecondCapturingTransport);

    const app = await host.build().test();
    // Discard framework-internal bootstrap records emitted during build; we only
    // care about what the logger does with the calls *we* drive below.
    CapturingTransport.reset();
    SecondCapturingTransport.reset();
    try {
      host.logger.debug("debug-msg");
      host.logger.trace("trace-msg");
      host.logger.info("info-msg");

      // Both transports without overrides should accept debug; trace is below.
      const capDebugs = CapturingTransport.records.filter((r) => r.message === "debug-msg");
      const capInfos = CapturingTransport.records.filter((r) => r.message === "info-msg");
      const capTraces = CapturingTransport.records.filter((r) => r.message === "trace-msg");
      const sndDebugs = SecondCapturingTransport.records.filter((r) => r.message === "debug-msg");
      const sndInfos = SecondCapturingTransport.records.filter((r) => r.message === "info-msg");
      const sndTraces = SecondCapturingTransport.records.filter((r) => r.message === "trace-msg");

      expect(capDebugs).toHaveLength(1);
      expect(capInfos).toHaveLength(1);
      expect(capTraces).toHaveLength(0);
      expect(sndDebugs).toHaveLength(1);
      expect(sndInfos).toHaveLength(1);
      expect(sndTraces).toHaveLength(0);
    } finally {
      await app.stop();
    }
  });

  it("emits human-readable (pretty) output from ConsoleTransport when log.format=pretty", async () => {
    const captured = captureConsole();
    const host = testHost({ flareJson: { log: { format: "pretty", level: "info" } }, env: {} });
    const app = await host.build().test();
    try {
      host.logger.info("hello-pretty");
      // Pretty output is not a JSON object; it includes the colorized "INFO" badge
      // and the message somewhere in the line. JSON mode would emit a string
      // starting with '{"timestamp":'.
      const line = captured.logs.find((l) => l.includes("hello-pretty"));
      expect(line).toBeDefined();
      expect(line!.startsWith('{"timestamp":')).toBe(false);
      expect(line!).toContain("INFO");
      expect(line!).toContain("hello-pretty");
    } finally {
      await app.stop();
      captured.restore();
    }
  });

  it("emits JSON-line output from ConsoleTransport when log.format=json (default)", async () => {
    const captured = captureConsole();
    const host = testHost({ flareJson: { log: { format: "json", level: "info" } }, env: {} });
    const app = await host.build().test();
    try {
      host.logger.info("hello-json");
      const line = captured.logs.find((l) => l.includes("hello-json"));
      expect(line).toBeDefined();
      expect(line!.startsWith("{")).toBe(true);
      // The JSON object should parse and carry level, message at top level.
      const parsed = JSON.parse(line!);
      expect(parsed.level).toBe("info");
      expect(parsed.message).toBe("hello-json");
    } finally {
      await app.stop();
      captured.restore();
    }
  });

  it("stamps every LogRecord with the loggerALS context when enableContext=true", async () => {
    CapturingTransport.reset();
    const host = testHost({ flareJson: { log: { enableContext: true, level: "trace" } }, env: {} });
    host.logging.transport(CapturingTransport);

    const app = await host.build().test();
    // Discard framework-internal bootstrap records emitted during build.
    CapturingTransport.reset();
    try {
      // Run a log emission inside an explicit loggerALS scope so the record
      // picks up the store contents.
      loggerALS.run(
        { context: { source: "flare:host" }, state: { tag: "scoped-emit" } },
        () => {
          host.logger.info("inside-als");
        },
      );

      // Outside the scope, no store exists; record should carry no context.
      host.logger.info("outside-als");

      const inside = CapturingTransport.records.find((r) => r.message === "inside-als");
      const outside = CapturingTransport.records.find((r) => r.message === "outside-als");
      expect(inside).toBeDefined();
      expect(outside).toBeDefined();
      expect(inside!.context).toEqual({ source: "flare:host" });
      expect(inside!.state).toEqual({ tag: "scoped-emit" });
      // With enableContext=true but no store on this call, the logger writes
      // no context (the ALS getStore() returns undefined and the branch falls
      // through).
      expect(outside!.context).toBeUndefined();
      expect(outside!.state).toBeUndefined();
    } finally {
      await app.stop();
    }
  });
});

// Edge Cases

describe("Edge Cases", () => {
  it("per-transport override (transports.capture.level=warn) raises one transport's threshold without changing the global level for other transports", async () => {
    CapturingTransport.reset();
    SecondCapturingTransport.reset();
    const host = testHost({
      flareJson: {
        log: {
          level: "info",
          transports: { capture: { level: "warn" } },
        },
      },
      env: {},
    });
    host.logging.transport(CapturingTransport);
    host.logging.transport(SecondCapturingTransport);

    const app = await host.build().test();
    // Discard framework-internal bootstrap records emitted during build.
    CapturingTransport.reset();
    SecondCapturingTransport.reset();
    try {
      host.logger.info("info-line");
      host.logger.warn("warn-line");

      // capture (overridden to warn): info dropped, warn kept.
      const capInfo = CapturingTransport.records.filter((r) => r.message === "info-line");
      const capWarn = CapturingTransport.records.filter((r) => r.message === "warn-line");
      expect(capInfo).toHaveLength(0);
      expect(capWarn).toHaveLength(1);

      // capture-2 (no override): global level "info" applies; both records kept.
      const sndInfo = SecondCapturingTransport.records.filter((r) => r.message === "info-line");
      const sndWarn = SecondCapturingTransport.records.filter((r) => r.message === "warn-line");
      expect(sndInfo).toHaveLength(1);
      expect(sndWarn).toHaveLength(1);
    } finally {
      await app.stop();
    }
  });

  it("parses both `transports` omitted and `transports: {}` cleanly with no per-transport overrides", async () => {
    // Case 1: transports omitted entirely
    {
      const host = testHost({ flareJson: { log: { level: "info" } }, env: {} });
      const app = await host.build().test();
      try {
        const log = host.config.log!;
        expect(log.transports).toBeUndefined();
      } finally {
        await app.stop();
      }
    }

    // Case 2: transports present but empty object
    {
      const host = testHost({ flareJson: { log: { level: "info", transports: {} } }, env: {} });
      const app = await host.build().test();
      try {
        const log = host.config.log!;
        expect(log.transports).toEqual({});
      } finally {
        await app.stop();
      }
    }
  });

  it("resolves FLARE__LOG__LEVEL=debug to the canonical `level` field (env-var case folding)", async () => {
    const host = testHost({
      flareJson: {},
      env: { FLARE__LOG__LEVEL: "debug" },
    });
    const app = await host.build().test();
    try {
      const log = host.config.log!;
      expect(log.level).toBe("debug");
    } finally {
      await app.stop();
    }
  });
});

// Failure Modes

describe("Failure Modes", () => {
  it('raises on unknown `level` value ("verbose") rather than defaulting silently', async () => {
    const host = testHost({ flareJson: { log: { level: "verbose" } }, env: {} });
    expect(() => host.build()).toThrow(/verbose/);
  });

  it('raises on unknown `format` value ("yaml") rather than defaulting silently', async () => {
    const host = testHost({ flareJson: { log: { format: "yaml" } }, env: {} });
    expect(() => host.build()).toThrow(/yaml/);
  });

  it("rejects `transports` set to a non-object (e.g. a string)", async () => {
    const host = testHost({ flareJson: { log: { transports: "console" as unknown as JsonObject } }, env: {} });
    expect(() => host.build()).toThrow();
  });
});

// Cross-Feature Interactions

describe("Cross-Feature Interactions", () => {
  it("auto-registers LOG_CONFIG alongside HOST_CONFIG so a service can declare static config = [LOG_CONFIG] without host.cfg(LOG_CONFIG)", async () => {
    let observed: FlareLogConfig | undefined;

    class LogConsumer extends FlareService {
      static override readonly deps = [];
      static override readonly config = [LOG_CONFIG] as const;

      override onStart(): void {
        observed = this.config(LOG_CONFIG);
      }
    }

    const host = testHost({ flareJson: { log: { level: "warn" } }, env: {} });
    // Intentionally NOT calling host.cfg(LOG_CONFIG): the auto-registration in
    // FlareHost's constructor is the behavior under test.
    host.singleton(LogConsumer);

    const app = await host.build().test();
    try {
      expect(observed).toBeDefined();
      expect(observed!.level).toBe("warn");
      expect(observed!.format).toBe("json");
      expect(observed!.enableContext).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it("filters every Logger.log(...) call against the resolved level, with per-transport overrides taking precedence over the global threshold", async () => {
    CapturingTransport.reset();
    SecondCapturingTransport.reset();
    const host = testHost({
      flareJson: {
        log: {
          level: "error", // global gate is strict by default
          transports: { capture: { level: "trace" } }, // capture overrides to trace
        },
      },
      env: {},
    });
    host.logging.transport(CapturingTransport);
    host.logging.transport(SecondCapturingTransport);

    const app = await host.build().test();
    // Discard framework-internal bootstrap records emitted during build.
    CapturingTransport.reset();
    SecondCapturingTransport.reset();
    try {
      host.logger.trace("t");
      host.logger.debug("d");
      host.logger.info("i");
      host.logger.warn("w");
      host.logger.error("e");

      // capture overridden to trace: receives all five.
      expect(CapturingTransport.records.map((r) => r.message)).toEqual(["t", "d", "i", "w", "e"]);
      // capture-2 has no override: global "error" applies; only "e" survives.
      expect(SecondCapturingTransport.records.map((r) => r.message)).toEqual(["e"]);
    } finally {
      await app.stop();
    }
  });
});
