/**
 * Integration suite for the logger bootstrap buffer on Cloudflare. Pins that framework records
 * emitted before the logger exists are held in the bootstrap buffer and drained when the Cloudflare
 * logger starts, under the in-process test harness with the Cloudflare adapter.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { LogRecord } from "../../../../../src/index.js";
import { CFWLoggerTransport, FlareHost } from "../../../../../src/index.js";
import { _log } from "../../../../../src/lib/logger/logger.js";
import { cfLoggerTestAdapter } from "../../../helpers/cf-test-adapter.js";
import { registerMinimalPingRoute } from "../../../helpers/minimal-route.js";

class CFWRecordingTransport extends CFWLoggerTransport {
  static override readonly transportName = "cfw-rec";
  static override deps: never[] = [];
  static readonly records: LogRecord[] = [];
  static recordsAtStart = 0;
  override onStart(): void {
    CFWRecordingTransport.recordsAtStart = CFWRecordingTransport.records.length;
  }
  write(record: LogRecord): void {
    CFWRecordingTransport.records.push(record);
  }
}

function resetRecords(): void {
  CFWRecordingTransport.records.length = 0;
  CFWRecordingTransport.recordsAtStart = 0;
}

describe("Cross-Feature Interactions", () => {
  beforeEach(() => {
    resetRecords();
  });

  it("CFWLogger.onStart flushes the buffer synchronously after starting transports synchronously (with logger/cfw-sync-lifecycle)", async () => {
    _log("info", "bb-cfw-sync-1");
    _log("info", "bb-cfw-sync-2");

    const host = new FlareHost(cfLoggerTestAdapter({
      host: { env: "test" },
      log: { level: "trace" },
    }));
    registerMinimalPingRoute(host);
    host.logging.transport(CFWRecordingTransport);

    const app = await host.build().test();
    try {
      const ourMessages = CFWRecordingTransport.records
        .map((r) => r.message)
        .filter((m) => m === "bb-cfw-sync-1" || m === "bb-cfw-sync-2");
      expect(ourMessages).toEqual(["bb-cfw-sync-1", "bb-cfw-sync-2"]);

      for (const msg of ["bb-cfw-sync-1", "bb-cfw-sync-2"]) {
        const idx = CFWRecordingTransport.records.findIndex((r) => r.message === msg);
        expect(idx).toBeGreaterThanOrEqual(CFWRecordingTransport.recordsAtStart);
      }
    } finally {
      await app.stop();
    }
  });
});
