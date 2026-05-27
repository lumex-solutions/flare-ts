import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { LogRecord } from "../../../src/lib/logger/types.js";
import { FlareHost } from "../../../src/index.js";
import { CFWLogger, Logger } from "../../../src/lib/logger/logger.js";
import { CFWLoggerTransport } from "../../../src/lib/logger/transport.js";
import { CFWConsoleTransport } from "../../../src/lib/logger/transports/console.js";
import { loggerALS } from "../../../src/lib/logger/types.js";
import { cfLoggerTestAdapter, cfTestAdapter } from "../helpers/cf-test-adapter.js";
import { registerMinimalPingRoute } from "../helpers/minimal-route.js";

// Adapter helpers. Inject test config; drop the default CFWConsoleTransport
// so each test only observes its own registered transports unless that
// default is being explicitly verified.

type LifecycleEvent =
  | { kind: "start"; name: string; }
  | { kind: "stop"; name: string; };

function makeCfAdapter(config: JsonObject): ReturnType<typeof cfTestAdapter> {
  return cfLoggerTestAdapter(config);
}

function makeCfAdapterKeepDefaults(config: JsonObject): ReturnType<typeof cfTestAdapter> {
  return cfTestAdapter(config);
}

const events: LifecycleEvent[] = [];

function resetEvents(): void {
  events.length = 0;
}

class SyncTransportA extends CFWLoggerTransport {
  static override readonly transportName = "sync-a";
  static override deps: never[] = [];
  static records: LogRecord[] = [];
  override onStart(): void {
    events.push({ kind: "start", name: "sync-a" });
  }
  override onStop(): void {
    events.push({ kind: "stop", name: "sync-a" });
  }
  write(record: LogRecord): void {
    SyncTransportA.records.push(record);
  }
}

class SyncTransportB extends CFWLoggerTransport {
  static override readonly transportName = "sync-b";
  static override deps: never[] = [];
  static records: LogRecord[] = [];
  override onStart(): void {
    events.push({ kind: "start", name: "sync-b" });
  }
  override onStop(): void {
    events.push({ kind: "stop", name: "sync-b" });
  }
  write(record: LogRecord): void {
    SyncTransportB.records.push(record);
  }
}

class SyncTransportC extends CFWLoggerTransport {
  static override readonly transportName = "sync-c";
  static override deps: never[] = [];
  static records: LogRecord[] = [];
  override onStart(): void {
    events.push({ kind: "start", name: "sync-c" });
  }
  override onStop(): void {
    events.push({ kind: "stop", name: "sync-c" });
  }
  write(record: LogRecord): void {
    SyncTransportC.records.push(record);
  }
}

function resetTransportRecords(): void {
  SyncTransportA.records.length = 0;
  SyncTransportB.records.length = 0;
  SyncTransportC.records.length = 0;
}

describe("Primary Behavior", () => {
  afterEach(() => {
    resetEvents();
    resetTransportRecords();
  });

  it("CFWLogger.onStart() returns undefined (not a Promise) and is observable as synchronous from the caller's perspective", async () => {
    const adapter = makeCfAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(SyncTransportA);

    // Build (which compiles the logger) but do not yet run the test app's
    // lifecycle so that we can directly invoke CFWLogger.onStart() and observe
    // its return value.
    host.build();
    const logger = host.logger;
    expect(logger).toBeInstanceOf(CFWLogger);

    // Synchronous semantics: the start event for our transport must already be
    // recorded immediately after the call returns, with no microtask boundary
    // in between. Capture the events length before invoking onStart so we can
    // assert the diff fired synchronously.
    const before = events.length;
    const ret = (logger as CFWLogger).onStart();
    const after = events.length;

    expect(ret).toBeUndefined();
    expect((ret as unknown) instanceof Promise).toBe(false);
    // The transport's start event fired synchronously inside the onStart call.
    expect(after).toBeGreaterThan(before);
    expect(events.some((e) => e.kind === "start" && e.name === "sync-a")).toBe(true);

    // Tear down via the test app handle so the rest of the suite stays clean.
    const app = await host.build().test();
    await app.stop();
  });

  it("CFWLogger.onStop() returns undefined and runs to completion synchronously", async () => {
    const adapter = makeCfAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(SyncTransportA);

    const app = await host.build().test();
    // The test app's startAsync already invoked logger.onStart, so our sync-a
    // transport is started. We invoke onStop directly to observe the sync
    // return value while the logger is still alive.
    resetEvents();
    const ret = (host.logger as CFWLogger).onStop();
    expect(ret).toBeUndefined();
    expect((ret as unknown) instanceof Promise).toBe(false);
    // The stop event for sync-a must already be recorded synchronously.
    expect(events.some((e) => e.kind === "stop" && e.name === "sync-a")).toBe(true);

    // Clean up via the handle. The handle will call logger.onStop() a second
    // time which is harmless for our transports (idempotent push to events).
    await app.stop();
  });

  it("Transports' synchronous onStart/onStop hooks are invoked in registration / reverse-registration order", async () => {
    const adapter = makeCfAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(SyncTransportA);
    host.logging.transport(SyncTransportB);
    host.logging.transport(SyncTransportC);

    resetEvents();
    const app = await host.build().test();

    // After test() / startAsync, every transport's onStart has fired in
    // registration order: A, B, C.
    const startOrder = events.filter((e) => e.kind === "start").map((e) => e.name);
    expect(startOrder).toEqual(["sync-a", "sync-b", "sync-c"]);

    resetEvents();
    await app.stop();
    // After stop, every transport's onStop fired in reverse registration order.
    const stopOrder = events.filter((e) => e.kind === "stop").map((e) => e.name);
    expect(stopOrder).toEqual(["sync-c", "sync-b", "sync-a"]);
  });

  it("Booting via the Cloudflare adapter (cf) wires CFWLogger + CFWConsoleTransport as the default stack", async () => {
    const adapter = makeCfAdapterKeepDefaults({
      host: { env: "test" },
      // fatal level keeps the console transport quiet during the test.
      log: { level: "fatal", format: "json" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);

    const app = await host.build().test();
    try {
      // The bootstrapped logger is a CFWLogger, not a plain Logger.
      expect(host.logger).toBeInstanceOf(CFWLogger);

      // The adapter's defaultLoggerTransports advertise CFWConsoleTransport.
      expect(adapter.defaultLoggerTransports).toEqual([CFWConsoleTransport]);

      // And the resulting logger holds a CFWConsoleTransport instance —
      // accessed through the protected `transports` getter by reflecting via
      // a tiny subclass-of-equal-shape (since the spec describes observable
      // wiring, we observe it through the logger's actual transport list).
      const transports = (host.logger as unknown as { transports: readonly object[]; }).transports;
      expect(transports.some((t) => t instanceof CFWConsoleTransport)).toBe(true);
    } finally {
      await app.stop();
    }
  });
});

describe("Edge Cases", () => {
  afterEach(() => {
    resetEvents();
    resetTransportRecords();
  });

  it("A CFWLoggerTransport subclass that declares onStart(): void runs as expected", async () => {
    let started = 0;
    class VoidStartTransport extends CFWLoggerTransport {
      static override readonly transportName = "void-start";
      static override deps: never[] = [];
      override onStart(): void {
        started++;
      }
      write(_record: LogRecord): void {}
    }

    const adapter = makeCfAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(VoidStartTransport);

    const app = await host.build().test();
    try {
      expect(started).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it("A CFWLoggerTransport whose onStart returns a Promise (structurally allowed via duck typing) is not awaited — startup proceeds and the returned Promise is dropped on the floor", async () => {
    const order: string[] = [];
    let resolveStart!: () => void;
    const startGate = new Promise<void>((res) => {
      resolveStart = res;
    });

    class PromiseStartTransport extends CFWLoggerTransport {
      static override readonly transportName = "promise-start";
      static override deps: never[] = [];
      write(_record: LogRecord): void {}
    }
    // TypeScript narrows CFWLoggerTransport.onStart to `(): void`. Assign a
    // Promise-returning function via the prototype with a cast: the duck-typed
    // override is structurally accepted at runtime but the framework does not
    // await it. This codifies the documented CFW gap.
    (PromiseStartTransport.prototype as unknown as { onStart: () => Promise<void>; }).onStart = function() {
      order.push("enter");
      return startGate.then(() => {
        order.push("after-await");
      });
    };

    const adapter = makeCfAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(PromiseStartTransport);

    const app = await host.build().test();
    try {
      // After test() resolves, the framework's startAsync awaited
      // CFWLogger.onStart, which itself did NOT await the transport's promise.
      // The "enter" sentinel is recorded; "after-await" is not, because the
      // gate has not been released yet.
      expect(order).toEqual(["enter"]);
      expect(order).not.toContain("after-await");

      // Release the orphan promise so the test does not leak unresolved work.
      resolveStart();
      await startGate;
    } finally {
      await app.stop();
    }
  });

  it("The bootstrap buffer is flushed synchronously inside CFWLogger.onStart() after all transports have started", async () => {
    // Framework boot emits trace-level "Lifecycle event" records via the
    // internal `_log` function before the Logger exists. Those records sit in
    // the bootstrap buffer and are drained at the end of CFWLogger.onStart(),
    // after every transport's onStart fired. Run at level=trace so the drain
    // is not filtered out, and use a recording transport with onStart that
    // snapshots its records length so we can prove the flush happened AFTER
    // its own start.
    class SnapshotTransport extends CFWLoggerTransport {
      static override readonly transportName = "snapshot";
      static override deps: never[] = [];
      static records: LogRecord[] = [];
      static recordCountAtStart: number | undefined;
      override onStart(): void {
        SnapshotTransport.recordCountAtStart = SnapshotTransport.records.length;
      }
      write(record: LogRecord): void {
        SnapshotTransport.records.push(record);
      }
    }

    const adapter = makeCfAdapter({
      host: { env: "test" },
      log: { level: "trace" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(SnapshotTransport);

    const app = await host.build().test();
    try {
      // The earliest buffered framework record is the `config:start` trace
      // emitted by host.build() before the Logger was compiled.
      const bufferedConfigStart = SnapshotTransport.records.find(
        (r) =>
          r.message === "Lifecycle event"
          && r.meta?.phase === "build"
          && r.meta.component === "host"
          && r.meta.event === "config:start",
      );
      expect(bufferedConfigStart).toBeDefined();

      // recordCountAtStart was captured at the moment of the transport's
      // onStart; the buffer drains AFTER all transports' onStart fire, so the
      // buffered record's index must be >= the snapshot taken at start.
      expect(SnapshotTransport.recordCountAtStart).toBeDefined();
      const configStartIdx = SnapshotTransport.records.findIndex(
        (r) =>
          r.message === "Lifecycle event"
          && r.meta?.phase === "build"
          && r.meta.event === "config:start",
      );
      expect(configStartIdx).toBeGreaterThanOrEqual(SnapshotTransport.recordCountAtStart!);
    } finally {
      await app.stop();
    }
  });
});

describe("Failure Modes", () => {
  afterEach(() => {
    resetEvents();
    resetTransportRecords();
  });

  it("A throw from a transport's synchronous onStart propagates synchronously and aborts host boot before any user-facing log call", async () => {
    class BrokenStartTransport extends CFWLoggerTransport {
      static override readonly transportName = "broken-start";
      static override deps: never[] = [];
      override onStart(): void {
        throw new Error("cfw startup boom");
      }
      write(_record: LogRecord): void {}
    }

    class TrailingTransport extends CFWLoggerTransport {
      static override readonly transportName = "trailing";
      static override deps: never[] = [];
      static started = false;
      static writes = 0;
      override onStart(): void {
        TrailingTransport.started = true;
      }
      write(_record: LogRecord): void {
        TrailingTransport.writes++;
      }
    }

    const adapter = makeCfAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(BrokenStartTransport);
    host.logging.transport(TrailingTransport);

    TrailingTransport.started = false;
    TrailingTransport.writes = 0;

    await expect(host.build().test()).rejects.toThrow("cfw startup boom");

    // Registration-order startup halts on the throwing transport: the trailing
    // transport never had its onStart called, and no user-facing log was
    // routed to it.
    expect(TrailingTransport.started).toBe(false);
    expect(TrailingTransport.writes).toBe(0);
  });

  // Spec bullet "A throw from a transport's synchronous onStop does not prevent
  // earlier transports from also stopping (best-effort drain)" is deferred —
  // the current CFWLogger.onStop() implementation does NOT wrap individual
  // `transport.onStop()` calls in try/catch (see core/src/lib/logger/logger.ts:
  // CFWLogger.onStop). A throwing onStop aborts the reverse-order loop and
  // earlier-registered transports do not get onStop invoked. Writing this as
  // a passing test would require either changing the implementation (out of
  // scope for the test writer) or codifying the current "first throw wins"
  // behaviour, which contradicts the spec. Listed in deferredCases.
});

describe("Cross-Feature Interactions", () => {
  afterEach(() => {
    resetEvents();
    resetTransportRecords();
  });

  it("Level filtering and per-transport overrides behave identically under CFWLogger as under Logger (with logger/leveled-logging)", async () => {
    // Two transports: sync-a only accepts >= warn (so trace/info are dropped),
    // sync-b accepts everything. Global level=trace lets every record flow
    // through emit; per-transport overrides decide who actually receives them.
    const adapter = makeCfAdapter({
      host: { env: "test" },
      log: {
        level: "trace",
        transports: {
          "sync-a": { level: "warn" },
          // sync-b: no override → inherits global trace
        },
      },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(SyncTransportA);
    host.logging.transport(SyncTransportB);

    const app = await host.build().test();
    try {
      resetTransportRecords();
      host.logger.info("under-warn");
      host.logger.warn("at-warn");
      host.logger.error("above-warn");

      const aMessages = SyncTransportA.records.filter((r) =>
        r.message === "under-warn" || r.message === "at-warn" || r.message === "above-warn"
      ).map((r) => r.message);
      const bMessages = SyncTransportB.records.filter((r) =>
        r.message === "under-warn" || r.message === "at-warn" || r.message === "above-warn"
      ).map((r) => r.message);

      // sync-a (warn override) only sees warn+ records.
      expect(aMessages).toEqual(["at-warn", "above-warn"]);
      // sync-b (inherits trace) sees every emitted record.
      expect(bMessages).toEqual(["under-warn", "at-warn", "above-warn"]);
    } finally {
      await app.stop();
    }
  });

  it("Request context capture (log.enableContext: true) works under CFW provided nodejs_compat is enabled (with logger/request-context)", async () => {
    // The vitest runtime provides node:async_hooks (the framework's note says
    // nodejs_compat must be enabled on CFW; under vitest this is always true).
    // With enableContext=true, the logger attaches the active loggerALS store's
    // `context` to every record it emits.
    const adapter = makeCfAdapter({
      host: { env: "test" },
      log: { level: "info", enableContext: true },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(SyncTransportA);

    const app = await host.build().test();
    try {
      resetTransportRecords();

      // Inside a loggerALS.run, every record's `context` field reflects the
      // active store. Use the HttpLogContext shape so the assertion exercises
      // the full payload, not just the source.
      loggerALS.run(
        {
          context: {
            source: "flare:http",
            requestId: "rid-cf-1",
            method: "GET",
            url: "/abc",
          },
          state: { who: "test" },
        },
        () => {
          host.logger.info("in-context");
        },
      );

      // Outside the run, no store is active, so no context is attached.
      host.logger.info("out-of-context");

      const inCtx = SyncTransportA.records.find((r) => r.message === "in-context");
      const outCtx = SyncTransportA.records.find((r) => r.message === "out-of-context");

      expect(inCtx).toBeDefined();
      expect(inCtx!.context).toEqual({
        source: "flare:http",
        requestId: "rid-cf-1",
        method: "GET",
        url: "/abc",
      });
      expect(inCtx!.state).toEqual({ who: "test" });

      expect(outCtx).toBeDefined();
      expect(outCtx!.context).toBeUndefined();
      expect(outCtx!.state).toBeUndefined();

      // The logger is a CFWLogger — confirm we exercised the CFW code path,
      // not the Node Logger, throughout. (The parent Logger class shares the
      // emit path; this assertion guards against accidental regressions where
      // the adapter no longer wires CFWLogger.)
      expect(host.logger).toBeInstanceOf(CFWLogger);
      expect(host.logger).toBeInstanceOf(Logger);
    } finally {
      await app.stop();
    }
  });
});
