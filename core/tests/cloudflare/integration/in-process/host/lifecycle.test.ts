/**
 * Cloudflare sync lifecycle: http arc onStart/onStop callback order, CfLogger transport hooks,
 * and export()'s direct transition to host.state "ready". Drives via custom sync adapters and
 * cfProdAdapter.export() so the production terminal runs without the test-mode shim.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareApp } from "../../../../../src/cloudflare.js";
import type { HostRuntimeAdapter } from "../../../../../src/lib/host/types/adapter.js";
import { cf } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse, type LogRecord } from "../../../../../src/index.js";
import { CfLoggerTransport } from "../../../../../src/index.js";
import { CfLogger } from "../../../../../src/lib/logger/runtime/cloudflare/cf-logger.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";
import { registerMinimalPingRoute } from "../../../helpers/minimal-route.js";

type LifecycleEvent = string;

class SilentCFWTransport extends CfLoggerTransport {
  static override readonly transportName = "silent-cfw";
  static override deps = [];
  override write(_record: LogRecord): void {}
}

function buildSyncAdapter(): HostRuntimeAdapter<CloudflareApp, typeof SilentCFWTransport, "sync"> {
  return {
    runtime: "cloudflare",
    lifecycle: "sync",
    get flareJsonFile(): JsonObject {
      return {};
    },
    env: {},
    defaultLoggerTransports: [SilentCFWTransport],
    createApp: cf.createApp,
    createLogger(transports, container) {
      return new CfLogger(transports, container);
    },
    createTestRequest() {
      throw new Error("not used");
    },
  };
}

describe("Primary Behavior", () => {
  it(
    "Sync runtime: http arc callbacks walked top-to-bottom on start, registration order on stop; "
      + "Logger is started after the arc and stopped last",
    () => {
      const events: LifecycleEvent[] = [];

      // Http arc callbacks stand in for user-land singletons, which are not
      // supported on Cloudflare Workers. Registration order is A, B, C on
      // start; onStop callbacks fire in the same registration order.
      class RecordingTransport extends CfLoggerTransport {
        static override readonly transportName = "rec-cfw-1";
        static override deps = [];
        override write(_r: LogRecord): void {}
        override onStart(): void {
          events.push("start:Logger");
        }
        override onStop(): void {
          events.push("stop:Logger");
        }
      }

      const adapter: HostRuntimeAdapter<CloudflareApp, typeof RecordingTransport, "sync"> = {
        runtime: "cloudflare",
        lifecycle: "sync",
        get flareJsonFile(): JsonObject {
          return {};
        },
        env: {},
        defaultLoggerTransports: [RecordingTransport],
        createApp: cf.createApp,
        createLogger(transports, container) {
          return new CfLogger(transports, container);
        },
        createTestRequest() {
          throw new Error("not used");
        },
      };

      const host = new FlareHost(adapter);
      registerMinimalPingRoute(host);
      host.http.onStart(() => {
        events.push("start:A");
      });
      host.http.onStart(() => {
        events.push("start:B");
      });
      host.http.onStart(() => {
        events.push("start:C");
      });
      host.http.onStop(() => {
        events.push("stop:A");
      });
      host.http.onStop(() => {
        events.push("stop:B");
      });
      host.http.onStop(() => {
        events.push("stop:C");
      });

      const app = host.build();
      app.start();
      app.stop();

      expect(events).toEqual([
        "start:A",
        "start:B",
        "start:C",
        "start:Logger",
        "stop:A",
        "stop:B",
        "stop:C",
        "stop:Logger",
      ]);
    },
  );
});

describe("Edge Cases", () => {
  it(
    "on sync runtime, an http arc onStart callback that returns a Promise throws "
      + "`[flare] Sync runtime lifecycle callback returned a Promise.`",
    () => {
      const host = new FlareHost(buildSyncAdapter());
      registerMinimalPingRoute(host);
      host.http.onStart(() => Promise.resolve() as never);

      const app = host.build();
      expect(() => app.start()).toThrow(
        "[flare] Sync runtime lifecycle callback returned a Promise.",
      );
    },
  );
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with host/runtime-cloudflare) export() runs the http arc start then jumps host.state to "
      + "'ready' without an intermediate 'listening' event",
    () => {
      // CF runtime has no socket; it goes from "starting" straight to
      // "ready" inside export(). No intermediate "listening" event exists
      // because there is no TCP server to bind. Confirm by reading state
      // immediately after export() returns.
      const events: LifecycleEvent[] = [];

      const host = new FlareHost(cfProdAdapter({
        host: { env: "test" },
        log: { level: "fatal", format: "json" },
      }));
      host.http.onStart(() => {
        events.push("start:S");
      });
      host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

      expect(host.state).toBe("starting");
      const app = host.build();
      // Sanity: build alone does not flip state; only export() does.
      expect(host.state).toBe("starting");

      const handle = (app as CloudflareApp).export();
      expect(handle).not.toBeNull();
      // Synchronous transition: by the time export() has returned,
      // the http arc start has fully run (proven by the arc callback having
      // fired) and host.state is already "ready". No micro-task gap is needed.
      expect(events).toEqual(["start:S"]);
      expect(host.state).toBe("ready");
    },
  );
});
