/**
 * Integration tests for HTTP arc lifecycle hooks: `host.http.onStart(fn)` and
 * `host.http.onStop(fn)` callback registration order, async awaiting, and
 * startup abort on throw. Each test builds its own host with custom adapters.
 * FLARE_MODE is set at module load so default adapters see test mode; custom
 * adapters pass FLARE_MODE through their own `env` field.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { RequestAdapter } from "../../../../../src/lib/arcs/http/transport/types/adapter.js";
import type { HostRuntimeAdapter } from "../../../../../src/lib/host/types/adapter.js";
import type { LogRecord } from "../../../../../src/lib/logger/types.js";
import { FlareHost, FlareResponse } from "../../../../../src/index.js";
import { FlareHttpContext } from "../../../../../src/lib/arcs/http/transport/flare-http-context.js";
import { FlareRequest } from "../../../../../src/lib/arcs/http/transport/flare-request.js";
import { FlareAppBase } from "../../../../../src/lib/host/flare-app.js";
import { Logger } from "../../../../../src/lib/logger/logger.js";
import { LoggerTransport } from "../../../../../src/lib/logger/transport.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

class SilentTransport extends LoggerTransport {
  static override readonly transportName = "silent-arc-lifecycle";
  static override deps = [];
  override write(_record: LogRecord): void {
    /* swallow */
  }
}

/** Builds an async lifecycle adapter with in-memory flare.json and a silent logger transport. */
function buildAsyncAdapter(): HostRuntimeAdapter<FlareAppBase> {
  return {
    runtime: "node",
    lifecycle: "async",
    get flareJsonFile(): JsonObject {
      return {};
    },
    env: { FLARE_MODE: "test" },
    defaultLoggerTransports: [SilentTransport],
    createApp(host) {
      // FlareAppBase has no abstract members at runtime; start/stop/startAsync/
      // stopAsync are concrete. The anonymous subclass is purely a TS hop.
      return new (class extends FlareAppBase {})(host);
    },
    createLogger(transports, container) {
      return new Logger(transports, container);
    },
    createTestRequest() {
      throw new Error("not used by these tests");
    },
  };
}

/**
 * Minimal {@link RequestAdapter} for hand-rolled FlareRequest construction.
 * Used by the cross-feature tests that need to call `host.http.fetch(ctx)`
 * without the help of TestAppHandle (we are observing arc state from inside
 * a lifecycle callback, before any TestAppHandle has been issued).
 */
const probeAdapter: RequestAdapter = {
  rawHeaders: () => new Headers(),
  signal: () => new AbortController().signal,
  background: () => {},
};

/** Builds a minimal FlareHttpContext for fetch probes inside lifecycle callbacks. */
function probeCtx(method: string, url: string): FlareHttpContext {
  return new FlareHttpContext(new FlareRequest(probeAdapter, method, url, "probe", null));
}

describe("Primary Behavior", () => {
  it(
    "app.onStart(fn) callbacks run when the host starts, in registration order",
    async () => {
      const events: string[] = [];

      const host = new FlareHost(buildAsyncAdapter());
      // Registration order: first, second, third. The arc's internal callback
      // array is a plain push-and-iterate, so observation order equals
      // registration order.
      host.http.onStart(() => {
        events.push("first");
      });
      host.http.onStart(() => {
        events.push("second");
      });
      host.http.onStart(() => {
        events.push("third");
      });
      registerMinimalPingRoute(host);

      const app = host.build();
      await app.startAsync();
      try {
        expect(events).toEqual(["first", "second", "third"]);
      } finally {
        await app.stopAsync();
      }
    },
  );

  it(
    "app.onStop(fn) callbacks run during graceful shutdown, in registration order",
    async () => {
      const events: string[] = [];

      const host = new FlareHost(buildAsyncAdapter());
      host.http.onStop(() => {
        events.push("first");
      });
      host.http.onStop(() => {
        events.push("second");
      });
      host.http.onStop(() => {
        events.push("third");
      });
      registerMinimalPingRoute(host);

      const app = host.build();
      await app.startAsync();
      // Sanity: only onStop is registered, so startAsync produces no events.
      expect(events).toEqual([]);
      await app.stopAsync();
      // Registration order, not reverse: http-arc onStop callbacks are walked
      // in registration order. Reverse-order teardown is a singleton-service
      // property documented under host/lifecycle, a separate feature.
      expect(events).toEqual(["first", "second", "third"]);
    },
  );

  it(
    "async host: callbacks return Promises and are awaited",
    async () => {
      const events: string[] = [];

      const host = new FlareHost(buildAsyncAdapter());
      // Each callback inserts a `before` marker, awaits a few microtasks, then
      // inserts an `after` marker. If the runtime fired callbacks in parallel
      // the before-markers would interleave; serial awaiting forces every
      // pair to appear contiguously.
      host.http.onStart(async () => {
        events.push("a:before");
        await Promise.resolve();
        await Promise.resolve();
        events.push("a:after");
      });
      host.http.onStart(async () => {
        events.push("b:before");
        await Promise.resolve();
        events.push("b:after");
      });
      registerMinimalPingRoute(host);

      const app = host.build();
      await app.startAsync();
      try {
        expect(events).toEqual(["a:before", "a:after", "b:before", "b:after"]);
      } finally {
        await app.stopAsync();
      }
    },
  );

  it(
    "a start callback that throws (sync) aborts startup; later callbacks do not run",
    async () => {
      const events: string[] = [];

      const host = new FlareHost(buildAsyncAdapter());
      host.http.onStart(() => {
        events.push("first");
      });
      host.http.onStart(() => {
        events.push("second:before-throw");
        throw new Error("startup aborted");
      });
      // The third callback must NEVER run; if it does, the spec invariant
      // (a throwing callback aborts the walk) is violated.
      host.http.onStart(() => {
        events.push("third:should-not-run");
      });
      registerMinimalPingRoute(host);

      const app = host.build();
      // startAsync re-throws synchronously inside the for-of loop, so the
      // rejection carries the same message the callback threw.
      await expect(app.startAsync()).rejects.toThrow("startup aborted");

      expect(events).toEqual(["first", "second:before-throw"]);
      // Cleanup: arc state has no pending work; stopAsync must still be a
      // no-op even after a partially-completed start.
      await app.stopAsync();
    },
  );
});

describe("Failure Modes", () => {
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with http-arc/composition) compilation ([COMPILE_HTTP_ARC]) happens before onStart runs",
    async () => {
      // The arc is compiled inside host.build(); onStart fires inside
      // app.startAsync(). Observed from inside the onStart callback, the
      // compiled artifacts must already be in place: registering a controller
      // route and asking the arc to fetch() it from within onStart must
      // route through the compiled router and return the handler's response.
      // If compilation happened AFTER onStart, the arc would still be in its
      // pre-compile state and fetch() would return a 503 ("Application not
      // ready. Call host.build() before handling requests.").
      const observedStatuses: number[] = [];

      const host = new FlareHost(buildAsyncAdapter());
      host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

      host.http.onStart(async () => {
        const ctx = probeCtx("GET", "/ping");
        const result = host.http.fetch(ctx);
        const resolved = result instanceof Promise ? await result : result;
        observedStatuses.push((resolved as FlareResponse).status);
      });

      const app = host.build();
      await app.startAsync();
      try {
        // The compiled router resolved /ping through the handler to 200. Had compilation
        // been deferred past startup, this would have been 503.
        expect(observedStatuses).toEqual([200]);
      } finally {
        await app.stopAsync();
      }
    },
  );

  it(
    "(with http-arc/composition) host.build() invokes [COMPILE_HTTP_ARC] before any app starts",
    async () => {
      // Sibling assertion to the previous case, from the opposite direction:
      // before app.startAsync() is ever called, host.build() must have
      // already compiled the arc, so a freshly-built (but not started)
      // arc can serve a fetch() against a registered route without erroring.
      const host = new FlareHost(buildAsyncAdapter());
      host.http.get("/built", () => new FlareResponse(200, { built: true }));

      // No onStart callback registered yet; nothing has fired. But the arc
      // is compiled because host.build() called this.http[COMPILE_HTTP_ARC]()
      // unconditionally at the end of its build pass.
      const app = host.build();

      // Walk the same minimal-context construction path: the arc must route
      // /built and produce a 200, proving compile completed at build time
      // (i.e. before any onStart could possibly run, since startAsync has
      // not been called).
      const ctx = probeCtx("GET", "/built");
      const result = host.http.fetch(ctx);
      const resolved = result instanceof Promise ? await result : result;
      expect(resolved).toBeInstanceOf(FlareResponse);
      expect((resolved as FlareResponse).status).toBe(200);

      // Tidy up: start and stop so the lifecycle is honoured and no warnings
      // surface from a half-built host.
      await app.startAsync();
      await app.stopAsync();
    },
  );
});
