/**
 * Integration tests for `host.http.health()`: liveness answers 200, readiness answers 200 only while
 * every check passes, and a failing check (false, a throw, or a timeout) answers 503 with a body that
 * never names it while the log does. Checks get their injected services and an abort signal, and
 * concurrent probes share one run. Uses in-process `app.test()` with a recording log transport;
 * transport framing is not the claim.
 */
process.env["FLARE_MODE"] = "test";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogRecord } from "../../../../../src/index.js";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { FlareService, LoggerTransport } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

class RecordingTransport extends LoggerTransport {
  static override readonly transportName = "recording";
  static override deps: never[] = [];
  static readonly records: LogRecord[] = [];

  override write(record: LogRecord): void {
    RecordingTransport.records.push(record);
  }
}

class SearchIndex extends FlareService {
  static override deps = [];
  warm = true;
}

let app: TestAppHandle | undefined;

beforeEach(() => {
  RecordingTransport.records.length = 0;
});

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

function host() {
  const h = testHost({ log: { level: "info" } });
  h.logging.transport(RecordingTransport);
  return h;
}

describe("Primary Behavior", () => {
  it("answers liveness and readiness with 200 and { status: ok } when the host is ready", async () => {
    const h = host();
    h.http.health();
    app = await h.build().test();

    const live = await app.fetch("GET /health/live");
    const ready = await app.fetch("GET /health/ready");

    expect([live.status, await live.json()]).toEqual([200, { status: "ok" }]);
    expect([ready.status, await ready.json()]).toEqual([200, { status: "ok" }]);
  });

  it("runs readiness checks with their injected services, and passes when each returns true or nothing", async () => {
    const h = host();
    h.scoped(SearchIndex);
    h.http.health()
      .check("search-index", { inject: { search: SearchIndex } }, ({ search }) => search.warm === true)
      .check("warm-cache", () => {});
    app = await h.build().test();

    expect((await app.fetch("GET /health/ready")).status).toBe(200);
  });
});

describe("Error Handling", () => {
  it("answers 503 with only { status: down } when a check returns false, and logs which one", async () => {
    const h = host();
    h.http.health().check("payments-gateway", () => false);
    app = await h.build().test();

    const res = await app.fetch("GET /health/ready");

    expect([res.status, await res.json()]).toEqual([503, { status: "down" }]);
    expect(RecordingTransport.records.find((record) => record.message === "Health check failed")?.meta).toEqual({
      check: "payments-gateway",
      reason: "returned false",
    });
  });

  it("fails a check that throws, logging the error", async () => {
    const h = host();
    h.http.health().check("database", () => {
      throw new Error("connect ECONNREFUSED");
    });
    app = await h.build().test();

    expect((await app.fetch("GET /health/ready")).status).toBe(503);
    expect(RecordingTransport.records.find((record) => record.message === "Health check failed")?.meta).toMatchObject({
      check: "database",
      reason: "threw",
      error: { message: "connect ECONNREFUSED" },
    });
  });

  it("fails a check that runs past the timeout, aborting the signal it was given", async () => {
    let aborted = false;
    const h = host();
    h.http.health({ checkTimeout: 20 }).check("slow-replica", (_scope, signal) =>
      new Promise<boolean>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(true);
        });
      }));
    app = await h.build().test();

    expect((await app.fetch("GET /health/ready")).status).toBe(503);
    expect(aborted).toBe(true);
    expect(RecordingTransport.records.find((record) => record.message === "Health check failed")?.meta).toEqual({
      check: "slow-replica",
      reason: "timeout",
      timeoutMs: 20,
    });
  });
});

describe("Concurrency", () => {
  it("shares one run of the checks between concurrent probes", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = host();
    h.http.health().check("search-index", async () => {
      runs++;
      await gate;
    });
    app = await h.build().test();

    const probes = [app.fetch("GET /health/ready"), app.fetch("GET /health/ready")];
    release();
    const statuses = (await Promise.all(probes)).map((res) => res.status);

    expect(statuses).toEqual([200, 200]);
    expect(runs).toBe(1);
  });
});
