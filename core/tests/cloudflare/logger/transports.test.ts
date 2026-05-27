process.env.FLARE_MODE = "test";

import { describe, expect, it } from "vitest";
import type { LogRecord } from "../../../src/lib/logger/types.js";
import { FlareHost } from "../../../src/index.js";
import { CFWLoggerTransport } from "../../../src/lib/logger/transport.js";
import { cfLoggerTestAdapter } from "../helpers/cf-test-adapter.js";
import { registerMinimalPingRoute } from "../helpers/minimal-route.js";

describe("Cross-Feature Interactions", () => {
  it("structurally allows Promise-returning onStart/onStop on a CFW transport without awaiting them (with logger/cfw-sync-lifecycle, known gap)", async () => {
    const order: string[] = [];
    let resolveStart!: () => void;
    const startGate = new Promise<void>((res) => {
      resolveStart = res;
    });

    class CfPromiseTransport extends CFWLoggerTransport {
      static override readonly transportName = "cfw-promise";
      static override deps: never[] = [];
      write(_record: LogRecord): void {}
    }
    (CfPromiseTransport.prototype as unknown as { onStart: () => Promise<void>; }).onStart = function() {
      order.push("cfw:start:enter");
      return startGate.then(() => {
        order.push("cfw:start:after-await");
      });
    };

    const adapter = cfLoggerTestAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.logging.transport(CfPromiseTransport);

    const app = await host.build().test();
    try {
      expect(order).toEqual(["cfw:start:enter"]);
      expect(order).not.toContain("cfw:start:after-await");

      resolveStart();
      await startGate;
    } finally {
      await app.stop();
    }
  });
});
