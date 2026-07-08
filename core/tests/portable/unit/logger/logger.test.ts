/**
 * Unit tests for {@link Logger}: emit levels, lifecycle, bootstrap buffer, and transport routing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { LogRecord, LogStore } from "../../../../src/lib/logger/types.js";
import type { Container } from "../../../../src/lib/services/container.js";
import { _log } from "../../../../src/lib/logger/bootstrap.js";
import { loggerALS } from "../../../../src/lib/logger/context.js";
import { Logger } from "../../../../src/lib/logger/logger.js";
import { LoggerTransport } from "../../../../src/lib/logger/transport.js";
import { makeContainer, RecordingTransport, resetBootstrapBuffer } from "../../../portable/helpers/logger-fixtures.js";

/** Secondary recording transport with a distinct name for per-transport override tests. */
class SecondTransport extends LoggerTransport {
  static override readonly transportName = "second";
  static override deps: never[] = [];

  records: LogRecord[] = [];

  override write(record: LogRecord): void {
    this.records.push({ ...record });
  }
}

/** Transport whose `transportName` static is missing, for undefined-key fallback tests. */
class NoNameTransport extends LoggerTransport {
  // Intentionally do not declare static transportName.
  static override deps: never[] = [];
  records: LogRecord[] = [];
  override write(record: LogRecord): void {
    this.records.push({ ...record });
  }
}

/** Lifecycle-recording async transport: pushes phase names onto a shared `events` array. */
class LifecycleTransport extends LoggerTransport {
  static override readonly transportName = "lifecycle";
  static override deps: never[] = [];

  constructor(
    private events: string[],
    private label: string,
    container: Container,
  ) {
    super(container);
  }

  override write(record: LogRecord): void {
    this.events.push(`${this.label}:write:${record.level}:${record.message}`);
  }

  override async onStart(): Promise<void> {
    this.events.push(`${this.label}:onStart`);
  }

  override async onStop(): Promise<void> {
    this.events.push(`${this.label}:onStop`);
  }
}

beforeEach(async () => {
  await resetBootstrapBuffer();
});

describe("log record emission and transport lifecycle", () => {
  // Primary Behavior
  it("constructs with empty transports array, call info(): no transport invoked, no throw", () => {
    const container = makeContainer({ level: "info" });
    const logger = new Logger([], container);
    expect(() => logger.info("msg")).not.toThrow();
  });

  it("after configure() via onStart, info('hi') delivers a record with level, message, timestamp and no meta/error/context/state", async () => {
    const container = makeContainer({ level: "info" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0; // ignore any lifecycle/bootstrap traces

    logger.info("hi");

    expect(transport.records).toHaveLength(1);
    const r = transport.records[0]!;
    expect(r.level).toBe("info");
    expect(r.message).toBe("hi");
    expect(r.meta).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(r.context).toBeUndefined();
    expect(r.state).toBeUndefined();
  });

  it("filters records below the configured global level (warn)", async () => {
    const container = makeContainer({ level: "warn" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0;

    logger.info("nope");
    logger.warn("yes-w");
    logger.error("yes-e");

    expect(transport.records.map((r) => r.level)).toEqual(["warn", "error"]);
  });

  it("applies a per-transport level override only to the transport it targets", async () => {
    const container = makeContainer({
      level: "info",
      transports: { recording: { level: "error" } },
    });
    const filtered = new RecordingTransport(container);
    const passthrough = new SecondTransport(container);
    const logger = new Logger([filtered, passthrough], container);

    await logger.onStart();
    filtered.records.length = 0;
    passthrough.records.length = 0;

    logger.info("hello");

    expect(filtered.records).toHaveLength(0);
    expect(passthrough.records.map((r) => r.message)).toEqual(["hello"]);
  });

  it("with enableContext: true and an active loggerALS.run, populates record.context and record.state", async () => {
    const container = makeContainer({ level: "info", enableContext: true });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0;

    const store: LogStore = {
      context: { source: "flare:host" },
      state: { rid: "abc" },
    };

    loggerALS.run(store, () => {
      logger.info("in-context");
    });

    expect(transport.records).toHaveLength(1);
    expect(transport.records[0]!.context).toEqual({ source: "flare:host" });
    expect(transport.records[0]!.state).toEqual({ rid: "abc" });
  });

  it("with enableContext: true but no active store, neither context nor state is set", async () => {
    const container = makeContainer({ level: "info", enableContext: true });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0;

    logger.info("no-ctx");

    expect(transport.records[0]!.context).toBeUndefined();
    expect(transport.records[0]!.state).toBeUndefined();
  });

  it("with enableContext: false, never populates context or state even inside loggerALS.run", async () => {
    const container = makeContainer({ level: "info", enableContext: false });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0;

    const store: LogStore = { context: { source: "flare:host" }, state: { x: 1 } };
    loggerALS.run(store, () => {
      logger.info("disabled");
    });

    expect(transport.records[0]!.context).toBeUndefined();
    expect(transport.records[0]!.state).toBeUndefined();
  });

  it("error(message) overload emits level error with no error field", async () => {
    const container = makeContainer({ level: "info" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0;

    logger.error("boom");

    expect(transport.records).toHaveLength(1);
    expect(transport.records[0]!.level).toBe("error");
    expect(transport.records[0]!.message).toBe("boom");
    expect(transport.records[0]!.error).toBeUndefined();
  });

  it("error(err, message) overload emits level error and attaches a structured error field via toErrorField", async () => {
    const container = makeContainer({ level: "info" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0;

    const err = new Error("kaboom");
    logger.error(err, "user-facing");

    const r = transport.records[0]!;
    expect(r.level).toBe("error");
    expect(r.message).toBe("user-facing");
    expect(r.error).toBeDefined();
    expect(r.error!.name).toBe("Error");
    expect(r.error!.message).toBe("kaboom");
    expect(typeof r.error!.stack).toBe("string");
  });

  it("error(err, message, meta) overload copies meta onto record", async () => {
    const container = makeContainer({ level: "info" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0;

    logger.error(new Error("e"), "msg", { userId: "u1" });

    const r = transport.records[0]!;
    expect(r.meta).toEqual({ userId: "u1" });
  });

  it("error(string, message) treats the first argument as the message overload", async () => {
    const container = makeContainer({ level: "info" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0;

    logger.error("just a string thrown" as unknown as Error, "wrapped");

    // First overload (string,string) wins by type guard: first arg is a string, so it is treated as the message.
    // That is the documented overload behavior; the (err, message) shape requires the first arg to be non-string.
    expect(transport.records[0]!.message).toBe("just a string thrown");
    expect(transport.records[0]!.error).toBeUndefined();
  });

  it("error(nonErrorObject, message) attaches toErrorField result for non-Error first argument", async () => {
    const container = makeContainer({ level: "info" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0;

    logger.error({ weird: true } as unknown as Error, "msg");

    expect(transport.records[0]!.error).toEqual({ message: "[object Object]" });
  });

  it("fatal(message) emits at fatal level", async () => {
    const container = makeContainer({ level: "info" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0;

    logger.fatal("very bad");

    expect(transport.records[0]!.level).toBe("fatal");
    expect(transport.records[0]!.message).toBe("very bad");
  });

  it("fatal(err) without an explicit message defaults to 'Fatal error', not 'Error'", async () => {
    const container = makeContainer({ level: "info" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0;

    logger.fatal(new Error("boom") as unknown as string);

    expect(transport.records[0]!.level).toBe("fatal");
    expect(transport.records[0]!.message).toBe("Fatal error");
    expect(transport.records[0]!.error!.message).toBe("boom");
  });

  it("error(err) without an explicit message defaults to 'Error'", async () => {
    const container = makeContainer({ level: "info" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0;

    logger.error(new Error("boom") as unknown as string);

    expect(transport.records[0]!.level).toBe("error");
    expect(transport.records[0]!.message).toBe("Error");
  });

  // Cross-Feature Interactions
  it("flushBootstrapBuffer drains records written by _log() before onStart in registration order", async () => {
    // Seed the buffer BEFORE the logger is started.
    _log("info", "boot-1");
    _log("debug", "boot-2", { z: 1 });

    const container = makeContainer({ level: "trace" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();

    // Filter to only the buffered records (transport.onStart traces emit through _log too,
    // but those happen *before* the buffer is drained; they are themselves part of the buffer).
    const drained = transport.records.map((r) => ({ level: r.level, message: r.message, meta: r.meta }));
    expect(drained).toContainEqual({ level: "info", message: "boot-1", meta: undefined });
    expect(drained).toContainEqual({ level: "debug", message: "boot-2", meta: { z: 1 } });

    // Order is preserved: boot-1 precedes boot-2.
    const i1 = drained.findIndex((r) => r.message === "boot-1");
    const i2 = drained.findIndex((r) => r.message === "boot-2");
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
  });

  it("onStart() lifecycle: configures, awaits each transport's onStart in registration order, then flushes buffer", async () => {
    const events: string[] = [];
    const container = makeContainer({ level: "trace" });
    const t1 = new LifecycleTransport(events, "t1", container);
    const t2 = new LifecycleTransport(events, "t2", container);
    const logger = new Logger([t1, t2], container);

    // Seed buffer to verify it is drained AFTER both onStart calls.
    _log("info", "buffered-after-start");

    await logger.onStart();

    const i1 = events.indexOf("t1:onStart");
    const i2 = events.indexOf("t2:onStart");
    const buffered = events.indexOf("t1:write:info:buffered-after-start");

    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(buffered).toBeGreaterThan(i2);
  });

  it("onStop() lifecycle: calls each transport's onStop in reverse registration order", async () => {
    const events: string[] = [];
    const container = makeContainer({ level: "trace" });
    const t1 = new LifecycleTransport(events, "t1", container);
    const t2 = new LifecycleTransport(events, "t2", container);
    const logger = new Logger([t1, t2], container);

    await logger.onStart();
    events.length = 0;

    await logger.onStop();

    const i1 = events.indexOf("t2:onStop");
    const i2 = events.indexOf("t1:onStop");
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
  });

  it("emits shutdown trace events with phase 'shutdown' around each transport stop", async () => {
    const container = makeContainer({ level: "trace" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();
    transport.records.length = 0;

    await logger.onStop();

    const shutdownStarts = transport.records.filter(
      (r) => r.meta && r.meta["phase"] === "shutdown" && r.meta["event"] === "start",
    );
    // For the single transport in this test, the "start" event is dispatched with transportLimit = i+1 = 1,
    // so the transport itself receives its own shutdown-start trace.
    expect(shutdownStarts.length).toBeGreaterThan(0);
  });

  it("transportLimit rule: the stopping transport does NOT receive its own shutdown-ready trace", async () => {
    const container = makeContainer({ level: "trace" });
    const t1 = new RecordingTransport(container);
    const t2 = new SecondTransport(container);
    const logger = new Logger([t1, t2], container);

    await logger.onStart();
    t1.records.length = 0;
    t2.records.length = 0;

    await logger.onStop();

    // t2 is stopped first (reverse order). emitTransportShutdownReady is called with transportLimit = i = 1,
    // so only the first (i=0) transport receives the ready record; t2 must NOT see its own ready trace.
    const t2ReadyForT2 = t2.records.filter(
      (r) =>
        r.meta
        && r.meta["phase"] === "shutdown"
        && r.meta["event"] === "ready"
        && r.meta["name"] === "second",
    );
    expect(t2ReadyForT2).toHaveLength(0);

    // t1 should still receive the ready event for t2 (since limit was 1, t1 is at index 0).
    const t1ReadyForT2 = t1.records.filter(
      (r) =>
        r.meta
        && r.meta["phase"] === "shutdown"
        && r.meta["event"] === "ready"
        && r.meta["name"] === "second",
    );
    expect(t1ReadyForT2.length).toBeGreaterThan(0);
  });

  it("configure() reads LOG_CONFIG and applies level + enableContext + per-transport overrides", async () => {
    const container = makeContainer({
      level: "warn",
      enableContext: true,
      transports: { recording: { level: "trace" } },
    });
    const t = new RecordingTransport(container);
    const logger = new Logger([t], container);

    await logger.onStart();
    t.records.length = 0;

    // Global level is warn, but recording transport has level trace; debug should reach it.
    logger.debug("dbg");

    expect(t.records.map((r) => ({ level: r.level, message: r.message }))).toEqual([
      { level: "debug", message: "dbg" },
    ]);
  });

  // Edge Cases
  it("configure() falls back to defaults (info, enableContext=false) when optional fields are missing", async () => {
    // Provide only `level`; the other LOG_CONFIG fields are missing from the resolved object.
    const container = makeContainer({ level: "info" });
    const t = new RecordingTransport(container);
    const logger = new Logger([t], container);

    await logger.onStart();
    t.records.length = 0;

    // enableContext defaults to false, so even an active store should not produce context.
    const store: LogStore = { context: { source: "flare:host" } };
    loggerALS.run(store, () => {
      logger.info("default-config");
    });
    expect(t.records[0]!.context).toBeUndefined();

    // Per-transport map is empty; debug (below info) is filtered.
    t.records.length = 0;
    logger.debug("dbg");
    expect(t.records).toHaveLength(0);
  });

  it("getTransportName reads the constructor's static transportName even on a mutated instance", async () => {
    const container = makeContainer({
      level: "info",
      transports: { recording: { level: "error" } },
    });
    const t = new RecordingTransport(container);

    // Mutate the instance after construction; class-static transportName must still drive the lookup.
    (t as unknown as { transportName?: string; }).transportName = "totally-different";

    const logger = new Logger([t], container);
    await logger.onStart();
    t.records.length = 0;

    logger.info("masked");
    expect(t.records).toHaveLength(0); // per-transport "recording" level=error still applied

    logger.error("kept");
    expect(t.records.map((r) => r.message)).toEqual(["kept"]);
  });

  it("with a transport whose class has no static transportName, undefined becomes the lookup key", async () => {
    // No per-transport override keyed under undefined; falls back to global level.
    const container = makeContainer({ level: "warn" });
    const t = new NoNameTransport(container);
    const logger = new Logger([t], container);

    await logger.onStart();
    t.records.length = 0;

    logger.info("nope");
    logger.warn("yes");

    expect(t.records.map((r) => r.message)).toEqual(["yes"]);
  });
});
