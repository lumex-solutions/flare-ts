/**
 * Pins the logger bootstrap buffer: framework `_log` records emitted before
 * Logger construction are drained after all transport onStart hooks resolve.
 * Driven through the in-process `app.test()` harness with recording transports
 * so buffer flush timing is observable without binding a real port.
 * Ensure the host enters test mode before any FlareHost is constructed.
 */
process.env.FLARE_MODE = "test";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { FlareHost, LoggerTransport, type LogRecord } from "../../../../../src/index.js";
import { _log } from "../../../../../src/lib/logger/logger.js";
import { nodeAdapter } from "../../../../node/helpers/node-adapter.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

function newTestHost(adapter: ReturnType<typeof nodeAdapter>) {
  const host = new FlareHost(adapter);
  registerMinimalPingRoute(host);
  return host;
}

// Adapter helpers that inject test config and drop the default ConsoleTransport
// so each test observes only its own registered transports.

function makeNodeAdapter(config: JsonObject) {
  return nodeAdapter(config, { FLARE_MODE: "test" }, { defaultLoggerTransports: [] });
}

// Recording transport fixtures

class RecordingTransport extends LoggerTransport {
  static override readonly transportName = "rec";
  static override deps: never[] = [];
  static readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    RecordingTransport.records.push(record);
  }
}

class RecordingTransportB extends LoggerTransport {
  static override readonly transportName = "rec-b";
  static override deps: never[] = [];
  static readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    RecordingTransportB.records.push(record);
  }
}

function resetRecords(): void {
  RecordingTransport.records.length = 0;
  RecordingTransportB.records.length = 0;
}

// Builds and stops a tiny host whose only purpose is to drain whatever is
// currently sitting in the module-scope bootstrap `_buffer` so it does not
// leak into the next test. Use after any test that intentionally leaves
// records in the buffer (e.g. the throwing-transport failure test).
async function drainBootstrapBuffer(): Promise<void> {
  class Drainer extends LoggerTransport {
    static override readonly transportName = "drainer";
    static override deps: never[] = [];
    write(_record: LogRecord): void {}
  }
  const host = newTestHost(makeNodeAdapter({
    host: { env: "test" },
    log: { level: "trace" },
  }));
  host.logging.transport(Drainer);
  const app = await host.build().test();
  await app.stop();
}

// Primary Behavior

describe("Primary Behavior", () => {
  beforeEach(() => {
    resetRecords();
  });

  it('does not write _log("info", "early") to console before any Logger is constructed, then a recording transport receives the buffered record after Logger.onStart runs', async () => {
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      // Pre-host: _log("info", ...) must NOT touch console.
      _log("info", "bb-early-info-1");

      // Confirm console was not written to by the _log call. (The host build
      // we are about to run does write internal _log("trace", ...) lines for
      // its own lifecycle, but those go to the buffer too, never to console.)
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();

      const host = newTestHost(makeNodeAdapter({
        host: { env: "test" },
        log: { level: "trace" },
      }));
      host.logging.transport(RecordingTransport);
      const app = await host.build().test();
      try {
        const ours = RecordingTransport.records.filter((r) => r.message === "bb-early-info-1");
        expect(ours).toHaveLength(1);
        expect(ours[0]!.level).toBe("info");
        expect(ours[0]!.message).toBe("bb-early-info-1");
      } finally {
        await app.stop();
      }
    } finally {
      consoleSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    }
  });

  it("drains multiple early _log calls in FIFO order", async () => {
    _log("info", "bb-fifo-1");
    _log("warn", "bb-fifo-2");
    _log("debug", "bb-fifo-3");
    _log("info", "bb-fifo-4");

    const host = newTestHost(makeNodeAdapter({
      host: { env: "test" },
      log: { level: "trace" },
    }));
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      const ourMessages = RecordingTransport.records
        .map((r) => r.message)
        .filter((m) => m.startsWith("bb-fifo-"));
      expect(ourMessages).toEqual(["bb-fifo-1", "bb-fifo-2", "bb-fifo-3", "bb-fifo-4"]);
    } finally {
      await app.stop();
    }
  });

  it('_log("fatal", "boom") writes `[flare] FATAL: boom\\n` to console.error immediately and bypasses the buffer', async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      _log("fatal", "bb-fatal-only");

      // Immediate, exact format on stderr.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith("[flare] FATAL: bb-fatal-only\n");

      // The fatal must NOT appear in the buffer; verify by spinning up a host
      // and confirming no record with our fatal message reaches the transport.
      const host = newTestHost(makeNodeAdapter({
        host: { env: "test" },
        log: { level: "trace" },
      }));
      host.logging.transport(RecordingTransport);
      const app = await host.build().test();
      try {
        const fatalEcho = RecordingTransport.records.find(
          (r) => r.message === "bb-fatal-only",
        );
        expect(fatalEcho).toBeUndefined();
      } finally {
        await app.stop();
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('_log("fatal", "boom", { x: 1 }) appends ` {"x":1}` after the message on the stderr line', async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      _log("fatal", "bb-fatal-with-meta", { x: 1 });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        '[flare] FATAL: bb-fatal-with-meta {"x":1}\n',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// Edge Cases

describe("Edge Cases", () => {
  beforeEach(() => {
    resetRecords();
  });

  it("after flushBootstrapBuffer drains, subsequent _log calls re-buffer and only the next Logger.onStart drains them", async () => {
    // First host: drain anything currently in the buffer.
    const host1 = newTestHost(makeNodeAdapter({
      host: { env: "test" },
      log: { level: "trace" },
    }));
    host1.logging.transport(RecordingTransport);
    const app1 = await host1.build().test();

    // After host1 started, the buffer is empty (drained). Now push fresh records.
    _log("info", "bb-rebuf-1");
    _log("info", "bb-rebuf-2");

    // host1 has already drained, so those re-buffered records must not appear
    // in its recording transport.
    const seenByHost1 = RecordingTransport.records.filter((r) =>
      r.message === "bb-rebuf-1" || r.message === "bb-rebuf-2"
    );
    expect(seenByHost1).toHaveLength(0);

    await app1.stop();

    // Second host: its onStart drains the re-buffered records.
    const host2 = newTestHost(makeNodeAdapter({
      host: { env: "test" },
      log: { level: "trace" },
    }));
    host2.logging.transport(RecordingTransportB);
    const app2 = await host2.build().test();
    try {
      const seenByHost2 = RecordingTransportB.records
        .map((r) => r.message)
        .filter((m) => m === "bb-rebuf-1" || m === "bb-rebuf-2");
      expect(seenByHost2).toEqual(["bb-rebuf-1", "bb-rebuf-2"]);
    } finally {
      await app2.stop();
    }
  });

  it("buffered records carry no `context` field even when the real logger has enableContext: true (no ALS during boot)", async () => {
    _log("info", "bb-noctx-1");

    const host = newTestHost(makeNodeAdapter({
      host: { env: "test" },
      log: { level: "trace", enableContext: true },
    }));
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      const ours = RecordingTransport.records.find((r) => r.message === "bb-noctx-1");
      expect(ours).toBeDefined();
      expect(ours!.context).toBeUndefined();
      expect(ours!.state).toBeUndefined();
    } finally {
      await app.stop();
    }
  });
});

// Failure Modes

describe("Failure Modes", () => {
  beforeEach(() => {
    resetRecords();
  });

  afterEach(async () => {
    // The throwing-transport test intentionally leaves records in the
    // module-scope _buffer (the flush loop is aborted before _buffer.length=0
    // runs). Drain it so the next test starts clean.
    await drainBootstrapBuffer();
  });

  it("an exception thrown by a transport's write during flush aborts the loop and leaves unflushed records in the buffer (current behavior, since `_buffer.length = 0` runs only after the loop completes)", async () => {
    // Three early records: the throwing transport will throw on the first
    // attempted write, leaving the remaining two un-drained.
    _log("info", "bb-throw-A");
    _log("info", "bb-throw-B");
    _log("info", "bb-throw-C");

    class ThrowOnFirstFlush extends LoggerTransport {
      static override readonly transportName = "throw-on-flush";
      static override deps: never[] = [];
      static throws = 0;
      static seen: string[] = [];
      write(record: LogRecord): void {
        ThrowOnFirstFlush.seen.push(record.message);
        if (record.message === "bb-throw-A") {
          ThrowOnFirstFlush.throws++;
          throw new Error("flush boom");
        }
      }
    }
    ThrowOnFirstFlush.throws = 0;
    ThrowOnFirstFlush.seen = [];

    const host = newTestHost(makeNodeAdapter({
      host: { env: "test" },
      log: { level: "trace" },
    }));
    host.logging.transport(ThrowOnFirstFlush);

    // The throw inside flushBootstrapBuffer surfaces out of Logger.onStart,
    // which is awaited inside FlareTestApp.test() during host.build().test().
    await expect(host.build().test()).rejects.toThrow("flush boom");
    expect(ThrowOnFirstFlush.throws).toBeGreaterThanOrEqual(1);

    // The throw aborted the for-of loop; `_buffer.length = 0` was never
    // reached. The underlying array is iterated, not mutated, so every
    // record originally in the buffer, including bb-throw-A whose write
    // threw, is still present. Verify by standing up a second, non-throwing
    // host and asserting all three of our records are drained in original
    // FIFO order through the new transport.
    const host2 = newTestHost(makeNodeAdapter({
      host: { env: "test" },
      log: { level: "trace" },
    }));
    host2.logging.transport(RecordingTransport);
    const app2 = await host2.build().test();
    try {
      const ours = RecordingTransport.records
        .map((r) => r.message)
        .filter((m) => m === "bb-throw-A" || m === "bb-throw-B" || m === "bb-throw-C");
      expect(ours).toEqual(["bb-throw-A", "bb-throw-B", "bb-throw-C"]);
    } finally {
      await app2.stop();
    }
  });
});

// Cross-Feature Interactions

describe("Cross-Feature Interactions", () => {
  beforeEach(() => {
    resetRecords();
  });

  it("sequences the buffer flush after every transport's onStart completes; the first buffered record reaches a transport only after that transport's startup hook has run (with logger/transports)", async () => {
    const events: { kind: "start" | "write"; message?: string; }[] = [];

    class OrderedTransport extends LoggerTransport {
      static override readonly transportName = "ordered";
      static override deps: never[] = [];
      static records: LogRecord[] = [];
      override onStart(): void {
        events.push({ kind: "start" });
      }
      write(record: LogRecord): void {
        OrderedTransport.records.push(record);
        events.push({ kind: "write", message: record.message });
      }
    }
    OrderedTransport.records = [];

    _log("info", "bb-ordered-first");

    const host = newTestHost(makeNodeAdapter({
      host: { env: "test" },
      log: { level: "trace" },
    }));
    host.logging.transport(OrderedTransport);
    const app = await host.build().test();
    try {
      const ourMsg = OrderedTransport.records.find((r) => r.message === "bb-ordered-first");
      expect(ourMsg).toBeDefined();

      // The transport's onStart must have fired exactly once, and BEFORE the
      // first write of our buffered record.
      const firstStartIdx = events.findIndex((e) => e.kind === "start");
      const ourFirstWriteIdx = events.findIndex(
        (e) => e.kind === "write" && e.message === "bb-ordered-first",
      );
      expect(firstStartIdx).toBeGreaterThanOrEqual(0);
      expect(ourFirstWriteIdx).toBeGreaterThan(firstStartIdx);
    } finally {
      await app.stop();
    }
  });

  it("drained records are subject to the same level filter as live records (with logger/leveled-logging)", async () => {
    // Buffered records span trace, debug, info, warn, error. With the global
    // level set to warn, only warn/error should reach the transport during
    // drain, using exactly the same filter applied to live records.
    _log("trace", "bb-lvl-trace");
    _log("debug", "bb-lvl-debug");
    _log("info", "bb-lvl-info");
    _log("warn", "bb-lvl-warn");
    _log("error", "bb-lvl-error");

    const host = newTestHost(makeNodeAdapter({
      host: { env: "test" },
      log: { level: "warn" },
    }));
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      const ourLevels = RecordingTransport.records
        .filter((r) => r.message.startsWith("bb-lvl-"))
        .map((r) => ({ msg: r.message, level: r.level }));
      expect(ourLevels).toEqual([
        { msg: "bb-lvl-warn", level: "warn" },
        { msg: "bb-lvl-error", level: "error" },
      ]);
    } finally {
      await app.stop();
    }
  });
});

// File-level cleanup: ensure no orphaned records remain in the module-scope
// bootstrap _buffer that could pollute sibling test files run in the same
// vitest worker.

afterAll(async () => {
  await drainBootstrapBuffer();
});
