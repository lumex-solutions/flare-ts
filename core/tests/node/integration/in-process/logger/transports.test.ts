/**
 * Pins LoggerTransport lifecycle and fan-out: onStart/onStop ordering,
 * registration-order delivery, inject rejection, and bootstrap-buffer flush
 * timing. Driven through the in-process `app.test()` harness with synthetic
 * recording transports so lifecycle events are observable without binding a
 * real port; console rendering is not the claim under test.
 * Ensure the host enters test mode before any FlareHost is constructed.
 */
process.env.FLARE_MODE = "test";

import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import {
  FlareHost,
  FlareService,
  LoggerTransport,
  type LogRecord,
  type ServiceToken,
} from "../../../../../src/index.js";
import { Container } from "../../../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../../../src/lib/services/registration-map.js";
import { nodeAdapter } from "../../../../node/helpers/node-adapter.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

type LifecycleEvent =
  | { kind: "start"; name: string; }
  | { kind: "stop"; name: string; }
  | { kind: "write"; name: string; message: string; level: string; };

// Adapter helpers: inject test config and drop the default ConsoleTransport
// so each test observes only its own registered transports.

function newTestHost(adapter: ReturnType<typeof nodeAdapter>) {
  const host = new FlareHost(adapter);
  registerMinimalPingRoute(host);
  return host;
}

function makeNodeAdapter(config: JsonObject) {
  return nodeAdapter(config, { FLARE_MODE: "test" }, { defaultLoggerTransports: [] });
}

// Lifecycle-tracking transport fixtures. Each class records the order in
// which `onStart` / `onStop` (and `write`) fire on a shared events list, so
// tests can assert ordering across multiple transports.

const events: LifecycleEvent[] = [];

function resetEvents(): void {
  events.length = 0;
}

class LifecycleTransportA extends LoggerTransport {
  static override readonly transportName = "life-a";
  static override deps: never[] = [];
  static records: LogRecord[] = [];
  static recordIndexAtStart: number | undefined;
  override onStart(): void {
    LifecycleTransportA.recordIndexAtStart = LifecycleTransportA.records.length;
    events.push({ kind: "start", name: "life-a" });
  }
  override onStop(): void {
    events.push({ kind: "stop", name: "life-a" });
  }
  write(record: LogRecord): void {
    LifecycleTransportA.records.push(record);
    events.push({ kind: "write", name: "life-a", message: record.message, level: record.level });
  }
}

class LifecycleTransportB extends LoggerTransport {
  static override readonly transportName = "life-b";
  static override deps: never[] = [];
  static records: LogRecord[] = [];
  override onStart(): void {
    events.push({ kind: "start", name: "life-b" });
  }
  override onStop(): void {
    events.push({ kind: "stop", name: "life-b" });
  }
  write(record: LogRecord): void {
    LifecycleTransportB.records.push(record);
    events.push({ kind: "write", name: "life-b", message: record.message, level: record.level });
  }
}

class LifecycleTransportC extends LoggerTransport {
  static override readonly transportName = "life-c";
  static override deps: never[] = [];
  static records: LogRecord[] = [];
  override onStart(): void {
    events.push({ kind: "start", name: "life-c" });
  }
  override onStop(): void {
    events.push({ kind: "stop", name: "life-c" });
  }
  write(record: LogRecord): void {
    LifecycleTransportC.records.push(record);
    events.push({ kind: "write", name: "life-c", message: record.message, level: record.level });
  }
}

function resetLifecycleRecords(): void {
  LifecycleTransportA.records.length = 0;
  LifecycleTransportB.records.length = 0;
  LifecycleTransportC.records.length = 0;
  LifecycleTransportA.recordIndexAtStart = undefined;
}

// Primary Behavior

describe("Primary Behavior", () => {
  afterEach(() => {
    resetEvents();
    resetLifecycleRecords();
  });

  it("invokes a transport's onStart exactly once during host startup, before the first user-facing log call is routed to it", async () => {
    const adapter = makeNodeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(LifecycleTransportA);
    const app = await host.build().test();
    try {
      // Capture the pre-log event tape: at this point only `start` should
      // have fired for life-a (writes from buffered framework boot records
      // may also be present, but no user-facing write yet).
      const startCount = events.filter((e) => e.kind === "start" && e.name === "life-a").length;
      expect(startCount).toBe(1);

      // Drop any framework startup writes so the only `write` we measure is
      // ours.
      LifecycleTransportA.records.length = 0;
      host.logger.info("user-facing");

      const writes = LifecycleTransportA.records.filter((r) => r.message === "user-facing");
      expect(writes).toHaveLength(1);

      // The first life-a start event must precede the user-facing write.
      const firstStart = events.findIndex((e) => e.kind === "start" && e.name === "life-a");
      const firstWrite = events.findIndex(
        (e) => e.kind === "write" && e.name === "life-a" && e.message === "user-facing",
      );
      expect(firstStart).toBeGreaterThanOrEqual(0);
      expect(firstWrite).toBeGreaterThan(firstStart);
    } finally {
      await app.stop();
    }

    // After full stop, onStart still fired exactly once.
    const totalStarts = events.filter((e) => e.kind === "start" && e.name === "life-a").length;
    expect(totalStarts).toBe(1);
  });

  it("invokes a transport's onStop exactly once during host shutdown, after the last user-facing log call has been routed to it", async () => {
    const adapter = makeNodeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(LifecycleTransportA);
    const app = await host.build().test();

    LifecycleTransportA.records.length = 0;
    host.logger.info("last-user-call");
    const lastWriteIdx = events.findIndex(
      (e) => e.kind === "write" && e.name === "life-a" && e.message === "last-user-call",
    );
    expect(lastWriteIdx).toBeGreaterThanOrEqual(0);

    await app.stop();

    const stopCount = events.filter((e) => e.kind === "stop" && e.name === "life-a").length;
    expect(stopCount).toBe(1);

    const stopIdx = events.findIndex((e) => e.kind === "stop" && e.name === "life-a");
    expect(stopIdx).toBeGreaterThan(lastWriteIdx);
  });

  it("delivers a single log call to two registered transports in registration order", async () => {
    const adapter = makeNodeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(LifecycleTransportA);
    host.logging.transport(LifecycleTransportB);
    const app = await host.build().test();
    try {
      resetEvents();
      resetLifecycleRecords();
      host.logger.info("multi-transport");

      // Both transports received the call.
      expect(LifecycleTransportA.records.find((r) => r.message === "multi-transport")).toBeDefined();
      expect(LifecycleTransportB.records.find((r) => r.message === "multi-transport")).toBeDefined();

      // The write order matches registration order: A before B.
      const writes = events.filter(
        (e) => e.kind === "write" && e.message === "multi-transport",
      );
      expect(writes.map((e) => e.name)).toEqual(["life-a", "life-b"]);
    } finally {
      await app.stop();
    }
  });
});

// Edge Cases

describe("Edge Cases", () => {
  afterEach(() => {
    resetEvents();
    resetLifecycleRecords();
  });

  it("reverses shutdown order: registering [A, B, C] yields onStop order C, B, A", async () => {
    const adapter = makeNodeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(LifecycleTransportA);
    host.logging.transport(LifecycleTransportB);
    host.logging.transport(LifecycleTransportC);
    const app = await host.build().test();

    resetEvents();
    await app.stop();

    const stopOrder = events.filter((e) => e.kind === "stop").map((e) => e.name);
    expect(stopOrder).toEqual(["life-c", "life-b", "life-a"]);
  });

  it("starts and stops a transport with no onStart/onStop without throwing", async () => {
    class NoHooksTransport extends LoggerTransport {
      static override readonly transportName = "no-hooks";
      static override deps: never[] = [];
      static writeCount = 0;
      write(_record: LogRecord): void {
        NoHooksTransport.writeCount++;
      }
    }

    const adapter = makeNodeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(NoHooksTransport);

    // Build + start must not throw despite missing hooks.
    const app = await host.build().test();
    NoHooksTransport.writeCount = 0;
    host.logger.info("hookless");
    expect(NoHooksTransport.writeCount).toBeGreaterThanOrEqual(1);
    await app.stop();
  });

  it("delivers the shutdown ready-trace for transport i only to transports 0..i-1; the just-stopped transport does not see its own shutdown trace", async () => {
    const adapter = makeNodeAdapter({
      host: { env: "test" },
      // trace level so the shutdown trace event is not filtered out
      log: { level: "trace" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(LifecycleTransportA);
    host.logging.transport(LifecycleTransportB);
    host.logging.transport(LifecycleTransportC);
    const app = await host.build().test();

    resetLifecycleRecords();
    resetEvents();
    await app.stop();

    // The "ready" trace for stopping transport i is emitted with
    // transportLimit = i, so transport i itself does NOT see its own ready
    // trace. (The "start" trace uses transportLimit = i + 1 and is therefore
    // also delivered to transport i; filter on event=ready here because that
    // is the shutdown trace under test.)
    const shutdownReadyNames = (records: LogRecord[]) =>
      records
        .filter(
          (r) =>
            r.level === "trace"
            && r.message === "Lifecycle event"
            && r.meta?.phase === "shutdown"
            && r.meta.component === "transport"
            && r.meta.event === "ready",
        )
        .map((r) => r.meta!["name"]);

    const aReadies = shutdownReadyNames(LifecycleTransportA.records);
    const bReadies = shutdownReadyNames(LifecycleTransportB.records);
    const cReadies = shutdownReadyNames(LifecycleTransportC.records);

    // Reverse-order stop: C (i=2), then B (i=1), then A (i=0).
    // ready trace for C goes to [0..1] = A, B ("life-c" seen by A and B)
    // ready trace for B goes to [0..0] = A ("life-b" seen by A only)
    // ready trace for A goes to [0..-1] = no one ("life-a" seen by no one)
    expect(aReadies).toEqual(["life-c", "life-b"]);
    expect(bReadies).toEqual(["life-c"]);
    expect(cReadies).toEqual([]);
  });

  it("awaits a transport's Promise-returning onStart before starting the next transport (under Logger, not CFWLogger)", async () => {
    const order: string[] = [];

    class AsyncFirstTransport extends LoggerTransport {
      static override readonly transportName = "async-first";
      static override deps: never[] = [];
      async onStart(): Promise<void> {
        order.push("first:start");
        // Two microtask hops to ensure that if the logger did NOT await, the
        // next transport's synchronous onStart would slip in first.
        await Promise.resolve();
        await Promise.resolve();
        order.push("first:ready");
      }
      write(_record: LogRecord): void {}
    }

    class SyncSecondTransport extends LoggerTransport {
      static override readonly transportName = "sync-second";
      static override deps: never[] = [];
      override onStart(): void {
        order.push("second:start");
      }
      write(_record: LogRecord): void {}
    }

    const adapter = makeNodeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(AsyncFirstTransport);
    host.logging.transport(SyncSecondTransport);

    const app = await host.build().test();
    try {
      // The Promise from the first transport must fully resolve before the
      // second's onStart runs.
      expect(order).toEqual(["first:start", "first:ready", "second:start"]);
    } finally {
      await app.stop();
    }
  });
});

// Failure Modes

describe("Failure Modes", () => {
  afterEach(() => {
    resetEvents();
    resetLifecycleRecords();
  });

  it("throws from inject(token) inside a transport, including the transport's constructor name and the attempted token name", () => {
    class SomeService extends FlareService {
      static override readonly deps = [];
    }
    const someToken = SomeService as unknown as ServiceToken<SomeService>;

    class InjectingTransport extends LoggerTransport {
      static override readonly transportName = "injector";
      static override deps: never[] = [];
      write(_record: LogRecord): void {}
    }

    // Build a minimal bootstrap container the same way the host does for
    // transports: empty registrations, empty singletons, empty config.
    const container = new Container(new FlareRegistrationMap(), new Map(), {});
    const transport = new InjectingTransport(container);

    expect(() => transport.inject(someToken)).toThrow("InjectingTransport");
    expect(() => transport.inject(someToken)).toThrow("SomeService");
    expect(() => transport.inject(someToken)).toThrow("transports cannot inject services");
  });

  it("fails host startup with a clear error when a transport's onStart throws, and does not proceed to user-facing routing", async () => {
    class BrokenStartTransport extends LoggerTransport {
      static override readonly transportName = "broken-start";
      static override deps: never[] = [];
      override onStart(): void {
        throw new Error("startup boom");
      }
      write(_record: LogRecord): void {}
    }

    class TrailingTransport extends LoggerTransport {
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

    const adapter = makeNodeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(BrokenStartTransport);
    host.logging.transport(TrailingTransport);

    TrailingTransport.started = false;
    TrailingTransport.writes = 0;

    await expect(host.build().test()).rejects.toThrow("startup boom");

    // The trailing transport's onStart never ran (registration-order start
    // halts on the throwing one) and no user-facing log call was routed.
    expect(TrailingTransport.started).toBe(false);
    expect(TrailingTransport.writes).toBe(0);
  });
});
// Cross-Feature Interactions

describe("Cross-Feature Interactions", () => {
  afterEach(() => {
    resetEvents();
    resetLifecycleRecords();
  });

  it("flushes the bootstrap buffer through transports after all of them have started (with logger/bootstrap-buffer)", async () => {
    // Framework boot emits trace-level "Lifecycle event" records via _log
    // before the Logger is constructed. Those records sit in the bootstrap
    // buffer and are drained at the end of Logger.onStart(), after every
    // transport's onStart has resolved. Run at level=trace so the drain is
    // not filtered out.
    const adapter = makeNodeAdapter({
      host: { env: "test" },
      log: { level: "trace" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(LifecycleTransportA);

    const app = await host.build().test();
    try {
      // The buffer flush surfaces framework "Lifecycle event" records emitted
      // by host.build() *before* the Logger existed. The earliest of these is
      // `phase: "build", component: "host", event: "config:start"`, which is
      // emitted via _log() before #compileLogger() runs.
      const bufferedConfigStart = LifecycleTransportA.records.find(
        (r) =>
          r.message === "Lifecycle event"
          && r.meta?.phase === "build"
          && r.meta.component === "host"
          && r.meta.event === "config:start",
      );
      expect(bufferedConfigStart).toBeDefined();

      // Buffered records carry no context (no ALS store during framework
      // boot before logger compile).
      expect(bufferedConfigStart!.context).toBeUndefined();

      // The flushed config:start record reaches life-a only after life-a's
      // onStart fired (the buffer is drained at the end of Logger.onStart()).
      // recordIndexAtStart is the records.length snapshot taken at the moment
      // of life-a.onStart; the config:start record must appear at an index
      // >= that snapshot, because the buffer flush runs *after* onStart.
      expect(LifecycleTransportA.recordIndexAtStart).toBeGreaterThanOrEqual(0);
      const configStartIdx = LifecycleTransportA.records.findIndex(
        (r) =>
          r.message === "Lifecycle event"
          && r.meta?.phase === "build"
          && r.meta.event === "config:start",
      );
      expect(configStartIdx).toBeGreaterThanOrEqual(LifecycleTransportA.recordIndexAtStart!);
    } finally {
      await app.stop();
    }
  });

  it("filters a transport's shutdown trace through every other transport's per-transport level (with logger/leveled-logging)", async () => {
    // Two transports: life-a only accepts >= warn (so trace lifecycle events
    // are dropped), life-b accepts all (trace+). When life-c is stopped
    // (registered last, stopped first), its shutdown trace is routed with
    // transportLimit=2 (life-a, life-b). life-a filters out the trace via
    // its per-transport level; life-b sees it.
    const adapter = makeNodeAdapter({
      host: { env: "test" },
      log: {
        level: "trace",
        transports: {
          "life-a": { level: "warn" },
          // life-b: no override, inherits global trace
          // life-c: no override, inherits global trace
        },
      },
    });
    const host = newTestHost(adapter);
    host.logging.transport(LifecycleTransportA);
    host.logging.transport(LifecycleTransportB);
    host.logging.transport(LifecycleTransportC);

    const app = await host.build().test();

    resetLifecycleRecords();
    await app.stop();

    const cShutdownInA = LifecycleTransportA.records.filter(
      (r) =>
        r.message === "Lifecycle event"
        && r.meta?.phase === "shutdown"
        && r.meta.component === "transport"
        && r.meta.name === "life-c"
        && r.meta.event === "start",
    );
    const cShutdownInB = LifecycleTransportB.records.filter(
      (r) =>
        r.message === "Lifecycle event"
        && r.meta?.phase === "shutdown"
        && r.meta.component === "transport"
        && r.meta.name === "life-c"
        && r.meta.event === "start",
    );

    // life-a filters trace-level shutdown notes via its per-transport level.
    expect(cShutdownInA).toHaveLength(0);
    // life-b inherits trace from global and is included in life-c's
    // transportLimit (= 2), so it sees the shutdown start trace.
    expect(cShutdownInB.length).toBeGreaterThanOrEqual(1);
  });
});
