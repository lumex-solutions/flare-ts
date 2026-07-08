/**
 * Pins logger level filtering: global level gating and per-transport level
 * overrides on lifecycle trace records. Driven through the in-process
 * `app.test()` harness with recording transports so filtered records are
 * observable without binding a real port.
 * Ensure the host enters test mode before any FlareHost is constructed.
 */
process.env.FLARE_MODE = "test";

import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { LogContext } from "../../../../../src/lib/logger/types.js";
import { FlareHost, LoggerTransport, type LogRecord } from "../../../../../src/index.js";
import { runWithLogStore } from "../../../../../src/index.js";
import { nodeAdapter } from "../../../../node/helpers/node-adapter.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

function newTestHost(adapter: ReturnType<typeof nodeAdapter>) {
  const host = new FlareHost(adapter);
  registerMinimalPingRoute(host);
  return host;
}

// Recording transport fixtures (defined once, instances reused across tests).
// Each test resets the static records arrays before/during the test.

class RecordingTransportA extends LoggerTransport {
  static override readonly transportName = "rec-a";
  static override deps: never[] = [];
  static readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    RecordingTransportA.records.push(record);
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

class ThrowingTransport extends LoggerTransport {
  static override readonly transportName = "thrower";
  static override deps: never[] = [];
  static throwCount = 0;
  write(_record: LogRecord): void {
    ThrowingTransport.throwCount++;
    throw new Error("transport boom");
  }
}

// Adapter helper: inject test config and drop the default ConsoleTransport so
// the test only observes records routed through its registered transports.
function makeAdapter(config: JsonObject) {
  return nodeAdapter(config, { FLARE_MODE: "test" }, { defaultLoggerTransports: [] });
}

function resetRecorders(): void {
  RecordingTransportA.records.length = 0;
  RecordingTransportB.records.length = 0;
  ThrowingTransport.throwCount = 0;
}

// Primary Behavior

describe("Primary Behavior", () => {
  afterEach(() => {
    resetRecorders();
  });

  it("emits a single record to the transport with the expected fields when info() is called", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransportA);
    const app = await host.build().test();
    try {
      resetRecorders();
      host.logger.info("hi");
      const ours = RecordingTransportA.records.filter((r) => r.message === "hi");
      expect(ours).toHaveLength(1);
      const rec = ours[0]!;
      expect(rec.level).toBe("info");
      expect(rec.message).toBe("hi");
    } finally {
      await app.stop();
    }
  });

  it("routes each of trace/debug/info/warn/error/fatal to a record with the matching level field", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "trace" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransportA);
    const app = await host.build().test();
    try {
      resetRecorders();
      host.logger.trace("t");
      host.logger.debug("d");
      host.logger.info("i");
      host.logger.warn("w");
      host.logger.error("e");
      host.logger.fatal("f");
      const ours = RecordingTransportA.records.filter((r) => ["t", "d", "i", "w", "e", "f"].includes(r.message));
      expect(ours.map((r) => r.level)).toEqual([
        "trace",
        "debug",
        "info",
        "warn",
        "error",
        "fatal",
      ]);
    } finally {
      await app.stop();
    }
  });

  it("includes timestamp, level, message, and meta exactly as passed in by the caller", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransportA);
    const app = await host.build().test();
    try {
      resetRecorders();
      const meta = { userId: "u-123", attempt: 2 };
      const before = Date.now();
      host.logger.info("did-the-thing", meta);
      const after = Date.now();
      const rec = RecordingTransportA.records.find((r) => r.message === "did-the-thing");
      expect(rec).toBeDefined();
      expect(rec!.level).toBe("info");
      expect(rec!.message).toBe("did-the-thing");
      // meta is attached by-reference, exactly as passed in.
      expect(rec!.meta).toBe(meta);
      expect(rec!.timestamp).toBeGreaterThanOrEqual(before);
      expect(rec!.timestamp).toBeLessThanOrEqual(after);
    } finally {
      await app.stop();
    }
  });
});

// Edge Cases

describe("Edge Cases", () => {
  afterEach(() => {
    resetRecorders();
  });

  it("filters info and debug when global level is warn; warn/error/fatal reach the transport", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "warn" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransportA);
    const app = await host.build().test();
    try {
      resetRecorders();
      host.logger.info("nope-info");
      host.logger.debug("nope-debug");
      host.logger.warn("yes-warn");
      host.logger.error("yes-error");
      host.logger.fatal("yes-fatal");
      const ourMessages = RecordingTransportA.records
        .filter((r) => ["nope-info", "nope-debug", "yes-warn", "yes-error", "yes-fatal"].includes(r.message))
        .map((r) => r.message);
      expect(ourMessages).toEqual(["yes-warn", "yes-error", "yes-fatal"]);
    } finally {
      await app.stop();
    }
  });

  it("per-transport override: rec-a.level=error and no override for rec-b => info reaches only rec-b, error reaches both", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: {
        level: "info",
        transports: {
          "rec-a": { level: "error" },
        },
      },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransportA);
    host.logging.transport(RecordingTransportB);
    const app = await host.build().test();
    try {
      resetRecorders();
      host.logger.info("info-msg");
      host.logger.error("error-msg");

      const aMsgs = RecordingTransportA.records
        .filter((r) => r.message === "info-msg" || r.message === "error-msg")
        .map((r) => r.message);
      const bMsgs = RecordingTransportB.records
        .filter((r) => r.message === "info-msg" || r.message === "error-msg")
        .map((r) => r.message);
      expect(aMsgs).toEqual(["error-msg"]);
      expect(bMsgs).toEqual(["info-msg", "error-msg"]);
    } finally {
      await app.stop();
    }
  });

  it("delivers the same record reference to every transport (single allocation per emit)", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransportA);
    host.logging.transport(RecordingTransportB);
    const app = await host.build().test();
    try {
      resetRecorders();
      host.logger.info("same-ref");
      const a = RecordingTransportA.records.find((r) => r.message === "same-ref");
      const b = RecordingTransportB.records.find((r) => r.message === "same-ref");
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a).toBe(b);
    } finally {
      await app.stop();
    }
  });

  it("produces a record without a meta field (not meta: undefined) when no meta arg is passed", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransportA);
    const app = await host.build().test();
    try {
      resetRecorders();
      host.logger.info("no-meta-here");
      const rec = RecordingTransportA.records.find((r) => r.message === "no-meta-here");
      expect(rec).toBeDefined();
      expect("meta" in rec!).toBe(false);
    } finally {
      await app.stop();
    }
  });
});

// Failure Modes

describe("Failure Modes", () => {
  afterEach(() => {
    resetRecorders();
  });

  it("a transport whose write throws currently aborts dispatch to later transports (no try/catch guard around write)", async () => {
    // The spec acknowledges this as the documented current behaviour: the
    // implementation does not guard transport.write, so the first throwing
    // transport raises out of logger.info() and later transports never see
    // the record.
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(ThrowingTransport);
    host.logging.transport(RecordingTransportB);
    const app = await host.build().test();
    try {
      resetRecorders();
      expect(() => host.logger.info("after-throw")).toThrow("transport boom");
      const bGot = RecordingTransportB.records.find((r) => r.message === "after-throw");
      expect(bGot).toBeUndefined();
      expect(ThrowingTransport.throwCount).toBeGreaterThanOrEqual(1);
    } finally {
      await app.stop();
    }
  });
});

// Cross-Feature Interactions

describe("Cross-Feature Interactions", () => {
  afterEach(() => {
    resetRecorders();
  });

  it("with log.enableContext=true, a record emitted inside runWithLogStore carries context and state to every transport", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info", enableContext: true },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransportA);
    host.logging.transport(RecordingTransportB);
    const app = await host.build().test();
    try {
      resetRecorders();
      const ctx: LogContext = {
        source: "flare:http",
        requestId: "rid-xyz",
        method: "GET",
        url: "/ping",
      };
      const state = { tenantId: "tnt-9" };
      runWithLogStore({ context: ctx, state }, () => {
        host.logger.info("with-ctx");
      });

      const a = RecordingTransportA.records.find((r) => r.message === "with-ctx");
      const b = RecordingTransportB.records.find((r) => r.message === "with-ctx");
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a!.context).toEqual(ctx);
      expect(a!.state).toEqual({ tenantId: "tnt-9" });
      expect(b!.context).toEqual(ctx);
      expect(b!.state).toEqual({ tenantId: "tnt-9" });
    } finally {
      await app.stop();
    }
  });

  it("error(err, msg) composes through toErrorField to attach a structured error field on the record", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransportA);
    const app = await host.build().test();
    try {
      resetRecorders();
      const cause = new Error("kaboom");
      host.logger.error(cause, "wrapping-message");
      const rec = RecordingTransportA.records.find((r) => r.message === "wrapping-message");
      expect(rec).toBeDefined();
      expect(rec!.level).toBe("error");
      expect(rec!.error).toBeDefined();
      expect(rec!.error!.name).toBe("Error");
      expect(rec!.error!.message).toBe("kaboom");
      expect(typeof rec!.error!.stack).toBe("string");
    } finally {
      await app.stop();
    }
  });
});
