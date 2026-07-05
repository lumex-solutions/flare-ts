/**
 * In-process integration tests for logging composition: transport registration order,
 * loggerTransports read-back, duplicate handling, and the freeze-at-bootstrap contract.
 */
process.env["FLARE_MODE"] = "test";

import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { LoggerTransportClass, LogRecord } from "../../../../../src/lib/logger/types.js";
import { FlareHost, LoggerTransport } from "../../../../../src/index.js";
import { nodeAdapter } from "../../../../node/helpers/node-adapter.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

/** Builds a node test adapter with no default logger transports. */
function makeNodeAdapter(config: JsonObject) {
  return nodeAdapter(config, { FLARE_MODE: "test" }, { defaultLoggerTransports: [] });
}

/** Recording stand-in for the runtime default transport; observes position in fan-out order. */
class DefaultRecordingTransport extends LoggerTransport {
  static override readonly transportName = "default-recording";
  static override deps: never[] = [];
  static records: LogRecord[] = [];
  write(record: LogRecord): void {
    DefaultRecordingTransport.records.push(record);
    fanout.push({ name: "default-recording", message: record.message });
  }
}

/** Builds a node test adapter whose default transport is `DefaultRecordingTransport`. */
function makeNodeAdapterWithRecordingDefault(config: JsonObject) {
  return nodeAdapter(config, { FLARE_MODE: "test" }, { defaultLoggerTransports: [DefaultRecordingTransport] });
}

const fanout: { name: string; message: string; }[] = [];

function resetFanout(): void {
  fanout.length = 0;
}

class TransportA extends LoggerTransport {
  static override readonly transportName = "user-a";
  static override deps: never[] = [];
  static records: LogRecord[] = [];
  write(record: LogRecord): void {
    TransportA.records.push(record);
    fanout.push({ name: "user-a", message: record.message });
  }
}

class TransportB extends LoggerTransport {
  static override readonly transportName = "user-b";
  static override deps: never[] = [];
  static records: LogRecord[] = [];
  write(record: LogRecord): void {
    TransportB.records.push(record);
    fanout.push({ name: "user-b", message: record.message });
  }
}

function resetRecords(): void {
  TransportA.records.length = 0;
  TransportB.records.length = 0;
  DefaultRecordingTransport.records.length = 0;
}

describe("Primary Behavior", () => {
  afterEach(() => {
    resetFanout();
    resetRecords();
  });

  it("fires the runtime default first, then user transports A and B in registration order, for each log record", async () => {
    const adapter = makeNodeAdapterWithRecordingDefault({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(TransportA);
    host.logging.transport(TransportB);

    const app = await host.build().test();
    try {
      resetFanout();
      resetRecords();

      host.logger.info("ordered-fanout");

      // Each of the three transports observed the call exactly once.
      const aWrites = TransportA.records.filter((r) => r.message === "ordered-fanout");
      const bWrites = TransportB.records.filter((r) => r.message === "ordered-fanout");
      const dWrites = DefaultRecordingTransport.records.filter((r) => r.message === "ordered-fanout");
      expect(aWrites).toHaveLength(1);
      expect(bWrites).toHaveLength(1);
      expect(dWrites).toHaveLength(1);

      // For the single log call, the fan-out order is default, then A, then B.
      const orderForCall = fanout
        .filter((e) => e.message === "ordered-fanout")
        .map((e) => e.name);
      expect(orderForCall).toEqual(["default-recording", "user-a", "user-b"]);
    } finally {
      await app.stop();
    }
  });

  it("loggerTransports reads back exactly the classes registered, in order", async () => {
    const adapter = makeNodeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);

    // Empty before any registration.
    expect(host.logging.loggerTransports).toEqual([]);

    host.logging.transport(TransportA);
    host.logging.transport(TransportB);

    // Reads back the exact classes, in registration order. The runtime
    // defaults are NOT part of this list; they live on the adapter and are
    // unioned with `loggerTransports` only at logger bootstrap.
    expect(host.logging.loggerTransports).toEqual([TransportA, TransportB]);

    // Build is still required to satisfy the lifecycle contract; verify
    // the read-back is identical post-build.
    const app = await host.build().test();
    try {
      expect(host.logging.loggerTransports).toEqual([TransportA, TransportB]);
    } finally {
      await app.stop();
    }
  });
});

describe("Edge Cases", () => {
  afterEach(() => {
    resetFanout();
    resetRecords();
  });

  it("registering the same transport class twice causes that transport to fire twice per log record (no dedupe)", async () => {
    const adapter = makeNodeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(TransportA);
    host.logging.transport(TransportA);

    // Composition-side read-back also preserves the duplicate.
    expect(host.logging.loggerTransports).toEqual([TransportA, TransportA]);

    const app = await host.build().test();
    try {
      resetFanout();
      resetRecords();

      host.logger.info("duplicate-transport");

      // The same class registered twice yields two distinct instances at
      // bootstrap, each of which records the write. We expect two writes
      // landing on the TransportA class-level store.
      const writes = TransportA.records.filter((r) => r.message === "duplicate-transport");
      expect(writes).toHaveLength(2);

      // Both fan-out entries are user-a (no dedupe at fan-out time either).
      const orderForCall = fanout
        .filter((e) => e.message === "duplicate-transport")
        .map((e) => e.name);
      expect(orderForCall).toEqual(["user-a", "user-a"]);
    } finally {
      await app.stop();
    }
  });

  it("registering zero user transports leaves the runtime defaults as the entire transport list", async () => {
    const adapter = makeNodeAdapterWithRecordingDefault({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);

    // No host.logging.transport(...) calls.
    expect(host.logging.loggerTransports).toEqual([]);

    const app = await host.build().test();
    try {
      resetFanout();
      resetRecords();

      host.logger.info("defaults-only");

      // The runtime default is the only transport to receive the call.
      const defaultWrites = DefaultRecordingTransport.records.filter(
        (r) => r.message === "defaults-only",
      );
      expect(defaultWrites).toHaveLength(1);

      const orderForCall = fanout
        .filter((e) => e.message === "defaults-only")
        .map((e) => e.name);
      expect(orderForCall).toEqual(["default-recording"]);
    } finally {
      await app.stop();
    }
  });
});

describe("Failure Modes", () => {
  afterEach(() => {
    resetFanout();
    resetRecords();
  });

  it("throws at logger bootstrap when a registered transport class's constructor cannot accept (container)", () => {
    // A "transport" class whose constructor cannot accept (container) in a
    // way that satisfies the LoggerTransport contract: a derived constructor
    // that takes zero parameters and never calls `super(...)`. When the host
    // does `new Transport(bootContainer)` during #compileLogger, the V8
    // [[Construct]] dispatch throws a ReferenceError about super before any
    // field can be touched; that is the bootstrap-time failure under test.
    //
    // The class is built through a `Function` factory so the TypeScript
    // checker does not have to reason about a missing-super constructor at
    // type-level. The runtime shape is identical to a hand-written
    // `class X extends LoggerTransport { constructor() {} }`.
    const buildBadCtor = new Function(
      "Base",
      `
      class BadCtorTransport extends Base {
        static transportName = "bad-ctor";
        static deps = [];
        constructor() {
          // intentionally NO super(container).
        }
        write(_record) {}
      }
      return BadCtorTransport;
      `,
    ) as (base: typeof LoggerTransport) => LoggerTransportClass;
    const BadCtorTransport = buildBadCtor(LoggerTransport);

    const adapter = makeNodeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(BadCtorTransport);

    // host.build() invokes #compileLogger synchronously, which calls
    // `new BadCtorTransport(bootContainer)`. The missing super call throws
    // a ReferenceError mentioning super; that is the bootstrap-time failure.
    expect(() => host.build()).toThrow(/super/);
  });
});

describe("Cross-Feature Interactions", () => {
  afterEach(() => {
    resetFanout();
    resetRecords();
  });

  it("transport list is frozen at bootstrap; further host.logging.transport(...) calls after build have no effect on the live logger (with host/logger-bootstrap)", async () => {
    const adapter = makeNodeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(TransportA);

    const app = await host.build().test();
    try {
      // Register a NEW transport after build. The live logger snapshotted
      // [TransportA] at bootstrap, so this late registration must not be
      // reflected in fan-out.
      host.logging.transport(TransportB);

      resetFanout();
      resetRecords();

      host.logger.info("post-build-register");

      const aWrites = TransportA.records.filter((r) => r.message === "post-build-register");
      const bWrites = TransportB.records.filter((r) => r.message === "post-build-register");

      // TransportA, registered before build, still fires.
      expect(aWrites).toHaveLength(1);
      // TransportB, registered after build, does NOT fire on the live
      // logger because the transport list is frozen at bootstrap.
      expect(bWrites).toHaveLength(0);

      const orderForCall = fanout
        .filter((e) => e.message === "post-build-register")
        .map((e) => e.name);
      expect(orderForCall).toEqual(["user-a"]);
    } finally {
      await app.stop();
    }
  });

  it("defaultLoggerTransports from the adapter run before any host.logging-registered transports (with host/runtime-adapter)", async () => {
    const adapter = makeNodeAdapterWithRecordingDefault({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(TransportA);
    host.logging.transport(TransportB);

    const app = await host.build().test();
    try {
      resetFanout();
      resetRecords();

      host.logger.info("adapter-defaults-first");

      // All three observed the call.
      expect(
        DefaultRecordingTransport.records.find((r) => r.message === "adapter-defaults-first"),
      ).toBeDefined();
      expect(TransportA.records.find((r) => r.message === "adapter-defaults-first")).toBeDefined();
      expect(TransportB.records.find((r) => r.message === "adapter-defaults-first")).toBeDefined();

      // The adapter's defaultLoggerTransports run first, then the
      // host.logging-registered transports in their registration order.
      const orderForCall = fanout
        .filter((e) => e.message === "adapter-defaults-first")
        .map((e) => e.name);
      expect(orderForCall).toEqual(["default-recording", "user-a", "user-b"]);
    } finally {
      await app.stop();
    }
  });
});
