process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { HostRuntimeAdapter } from "../../../src/lib/host/types/adapter.js";
import type { LogRecord } from "../../../src/lib/logger/types.js";
import { FlareHost } from "../../../src/index.js";
import { FlareAppCF } from "../../../src/lib/host/runtime/cloudflare.js";
import { CFWLogger } from "../../../src/lib/logger/logger.js";
import { CFWLoggerTransport } from "../../../src/lib/logger/transport.js";
import { registerMinimalPingRoute } from "../helpers/minimal-route.js";

class SilentCFWTransport extends CFWLoggerTransport {
  static override readonly transportName = "silent-cfw-arc-lifecycle";
  static override deps = [];
  override write(_record: LogRecord): void {}
}

function buildSyncAdapter(): HostRuntimeAdapter<FlareAppCF, typeof SilentCFWTransport, "sync"> {
  return {
    runtime: "cloudflare",
    lifecycle: "sync",
    get flareJsonFile(): JsonObject {
      return {};
    },
    env: {},
    defaultLoggerTransports: [SilentCFWTransport],
    createApp(host) {
      return new FlareAppCF(host);
    },
    createLogger(transports, container) {
      return new CFWLogger(transports, container);
    },
    createTestRequest() {
      throw new Error("not used");
    },
  };
}

describe("Primary Behavior", () => {
  it(
    "sync host: callbacks must be synchronous; an async callback aborts startup",
    () => {
      const host = new FlareHost(buildSyncAdapter());
      registerMinimalPingRoute(host);
      // A Promise-returning callback registered against a sync-lifecycle arc
      // must be rejected at start time. `as never` keeps the registration
      // call type-checkable against the sync `LifecycleCallback` signature.
      host.http.onStart(() => Promise.resolve() as never);

      const app = host.build();
      // app.start() (sync overload) walks the arc via [START_HTTP_ARC], which
      // detects the returned Promise and aborts before any singleton walk.
      expect(() => app.start()).toThrow(
        "[flare] Sync runtime lifecycle callback returned a Promise.",
      );
    },
  );
});

describe("Failure Modes", () => {
  it(
    "on a sync host, a callback that returns a Promise throws "
      + '"Sync runtime lifecycle callback returned a Promise."',
    () => {
      const host = new FlareHost(buildSyncAdapter());
      registerMinimalPingRoute(host);
      // Same shape as the Primary Behavior sync case but registered on onStop
      // to confirm both symbol-keyed entry points enforce the rule. The sync
      // start path walks cleanly (no onStart callbacks registered); the sync
      // stop path then hits the Promise-returning onStop and throws verbatim.
      host.http.onStop(() => Promise.resolve() as never);

      const app = host.build();
      app.start(); // no onStart callbacks — clean start
      expect(() => app.stop()).toThrow(
        "[flare] Sync runtime lifecycle callback returned a Promise.",
      );
    },
  );
});
