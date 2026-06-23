process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import type { CloudflareAdapter, CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import type { LogRecord } from "../../../src/lib/logger/types.js";
import { FlareHost } from "../../../src/index.js";
import { CFWLoggerTransport } from "../../../src/lib/logger/transport.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";
import { registerMinimalPingRoute } from "../helpers/minimal-route.js";

class SilentCFWTransport extends CFWLoggerTransport {
  static override readonly transportName = "silent-cfw-arc-lifecycle";
  static override deps = [];
  override write(_record: LogRecord): void {}
}

// Production-path CF adapter (env has no FLARE_MODE → not test mode), so
// `host.build()` returns a real `CloudflareApp` whose `start()` / `stop()`
// walk the http arc and enforce the sync-lifecycle Promise rule. The single
// CF adapter is `lifecycle: "sync"`, so a Promise-returning lifecycle callback
// must abort. Override the default transports with a silent one to keep the
// lifecycle trace logs out of the test output.
function buildSyncAdapter(): CloudflareAdapter {
  return {
    ...cfProdAdapter({}),
    defaultLoggerTransports: [SilentCFWTransport],
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

      const app = host.build() as CloudflareApp;
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

      const app = host.build() as CloudflareApp;
      app.start(); // no onStart callbacks — clean start
      expect(() => app.stop()).toThrow(
        "[flare] Sync runtime lifecycle callback returned a Promise.",
      );
    },
  );
});
