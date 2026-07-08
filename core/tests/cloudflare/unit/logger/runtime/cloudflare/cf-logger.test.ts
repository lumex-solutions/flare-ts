/**
 * Unit tests for {@link CfLogger}: the synchronous lifecycle over sync transports and
 * the shutdown transportLimit rule.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { LogRecord } from "../../../../../../src/lib/logger/types.js";
import type { Container } from "../../../../../../src/lib/services/container.js";
import { _log } from "../../../../../../src/lib/logger/bootstrap.js";
import { CfLogger } from "../../../../../../src/lib/logger/runtime/cloudflare/cf-logger.js";
import { CfLoggerTransport } from "../../../../../../src/lib/logger/runtime/cloudflare/cf-transport.js";
import { makeContainer, resetBootstrapBuffer } from "../../../../../portable/helpers/logger-fixtures.js";

/** Concrete sync Cloudflare transport that records lifecycle events. */
class CfLifecycleTransport extends CfLoggerTransport {
  static override readonly transportName = "cf-lifecycle";
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

  override onStart(): void {
    this.events.push(`${this.label}:onStart`);
  }

  override onStop(): void {
    this.events.push(`${this.label}:onStop`);
  }
}

beforeEach(async () => {
  await resetBootstrapBuffer();
});

describe("synchronous logger lifecycle", () => {
  // Primary Behavior
  it("onStart() returns undefined (synchronous, not a Promise)", () => {
    const container = makeContainer({ level: "info" });
    const logger = new CfLogger([], container);

    const ret = logger.onStart();
    expect(ret).toBeUndefined();
  });

  it("onStart() calls each transport's onStart synchronously in registration order, then flushes the buffer", () => {
    const events: string[] = [];
    const container = makeContainer({ level: "trace" });
    const t1 = new CfLifecycleTransport(events, "t1", container);
    const t2 = new CfLifecycleTransport(events, "t2", container);
    const logger = new CfLogger([t1, t2], container);

    _log("info", "cfw-buffered");

    logger.onStart();

    const i1 = events.indexOf("t1:onStart");
    const i2 = events.indexOf("t2:onStart");
    const buffered = events.indexOf("t1:write:info:cfw-buffered");

    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(buffered).toBeGreaterThan(i2);
  });

  it("onStop() returns undefined and calls transport onStop in reverse order", () => {
    const events: string[] = [];
    const container = makeContainer({ level: "trace" });
    const t1 = new CfLifecycleTransport(events, "t1", container);
    const t2 = new CfLifecycleTransport(events, "t2", container);
    const logger = new CfLogger([t1, t2], container);

    logger.onStart();
    events.length = 0;

    const ret = logger.onStop();
    expect(ret).toBeUndefined();

    const i2Stop = events.indexOf("t2:onStop");
    const i1Stop = events.indexOf("t1:onStop");
    expect(i2Stop).toBeGreaterThanOrEqual(0);
    expect(i1Stop).toBeGreaterThan(i2Stop);
  });

  it("CfLogger onStop: stopping transport does NOT receive its own shutdown-ready trace (transportLimit rule)", () => {
    // Use a sync Cloudflare-capable recording transport pair so we can inspect record meta directly.
    class CfRec extends CfLoggerTransport {
      static override readonly transportName = "cf-rec-a";
      static override deps: never[] = [];
      records: LogRecord[] = [];
      override write(record: LogRecord): void {
        this.records.push({ ...record });
      }
    }
    class CfRec2 extends CfLoggerTransport {
      static override readonly transportName = "cf-rec-b";
      static override deps: never[] = [];
      records: LogRecord[] = [];
      override write(record: LogRecord): void {
        this.records.push({ ...record });
      }
    }

    const container = makeContainer({ level: "trace" });
    const a = new CfRec(container);
    const b = new CfRec2(container);
    const logger = new CfLogger([a, b], container);

    logger.onStart();
    a.records.length = 0;
    b.records.length = 0;

    logger.onStop();

    // b stops first (reverse). The "ready" event for b is dispatched with transportLimit = 1,
    // so only a (index 0) receives it; b must NOT see its own ready trace.
    const bSawOwnReady = b.records.filter(
      (r) =>
        r.meta
        && r.meta["phase"] === "shutdown"
        && r.meta["event"] === "ready"
        && r.meta["name"] === "cf-rec-b",
    );
    expect(bSawOwnReady).toHaveLength(0);

    const aSawBReady = a.records.filter(
      (r) =>
        r.meta
        && r.meta["phase"] === "shutdown"
        && r.meta["event"] === "ready"
        && r.meta["name"] === "cf-rec-b",
    );
    expect(aSawBReady.length).toBeGreaterThan(0);
  });
});
