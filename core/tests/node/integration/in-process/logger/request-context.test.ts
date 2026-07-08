/**
 * Pins logger AsyncLocalStorage context propagation: enableContext gating, nested
 * runWithLogStore scopes, captureLogStore/runWithLogStore re-entry, and per-request
 * HttpLogContext from the Node runtime.
 * FLARE_MODE must be set before any FlareHost is constructed so the host enters test mode.
 */
process.env["FLARE_MODE"] = "test";

import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import {
  captureLogStore,
  FlareHost,
  LoggerTransport,
  runWithLogStore,
  type LogRecord,
} from "../../../../../src/index.js";
import { ConsoleTransport } from "../../../../../src/lib/logger/transports/console.js";
import { type HostLogContext, type HttpLogContext, type LogContext } from "../../../../../src/lib/logger/types.js";
import { nodeAdapter } from "../../../../node/helpers/node-adapter.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

/** Captures every log record; per-test reset keeps assertions scoped to one call. */
class RecordingTransport extends LoggerTransport {
  static override readonly transportName = "rec";
  static override deps: never[] = [];
  static readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    RecordingTransport.records.push(record);
  }
}

function resetRecords(): void {
  RecordingTransport.records.length = 0;
}

/** Strips ANSI escapes so pretty-mode strings can be matched against visible content. */
function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Builds a node adapter with test config and optionally drops the default ConsoleTransport. */
function makeAdapter(config: JsonObject, options?: { keepDefaultTransports?: boolean; }) {
  return nodeAdapter(
    config,
    { FLARE_MODE: "test" },
    options?.keepDefaultTransports ? {} : { defaultLoggerTransports: [] },
  );
}

function newTestHost(adapter: ReturnType<typeof nodeAdapter>) {
  const host = new FlareHost(adapter);
  registerMinimalPingRoute(host);
  return host;
}

describe("Primary Behavior", () => {
  afterEach(() => {
    resetRecords();
  });

  it("with log.enableContext: true, calling logger.info inside runWithLogStore produces a record whose context deep-equals the store's context", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info", enableContext: true },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      const ctx: HttpLogContext = {
        source: "flare:http",
        requestId: "rid-primary-1",
        method: "GET",
        url: "/things",
      };
      runWithLogStore({ context: ctx }, () => {
        host.logger.info("hi");
      });

      const rec = RecordingTransport.records.find((r) => r.message === "hi");
      expect(rec).toBeDefined();
      // Deep equal to the store's context, exactly what was set.
      expect(rec!.context).toEqual(ctx);
    } finally {
      await app.stop();
    }
  });

  it("with log.enableContext: true, a store carrying state produces a record with both context and state populated", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info", enableContext: true },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      const ctx: HttpLogContext = {
        source: "flare:http",
        requestId: "rid-primary-2",
        method: "POST",
        url: "/things",
      };
      const state = { tenantId: "tnt-7", userId: "u-2" };
      runWithLogStore({ context: ctx, state }, () => {
        host.logger.info("hello");
      });

      const rec = RecordingTransport.records.find((r) => r.message === "hello");
      expect(rec).toBeDefined();
      expect(rec!.context).toEqual(ctx);
      expect(rec!.state).toEqual(state);
    } finally {
      await app.stop();
    }
  });

  it("with log.enableContext: true but no active store (top-of-process call), records carry neither context nor state", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info", enableContext: true },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      // No surrounding runWithLogStore: emitted at "top of process".
      host.logger.info("naked");

      const rec = RecordingTransport.records.find((r) => r.message === "naked");
      expect(rec).toBeDefined();
      expect("context" in rec!).toBe(false);
      expect("state" in rec!).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it("with log.enableContext: false, records never carry context or state even inside an active runWithLogStore", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      // enableContext omitted (defaults to false).
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      const ctx: HttpLogContext = {
        source: "flare:http",
        requestId: "rid-primary-disabled",
        method: "GET",
        url: "/nope",
      };
      runWithLogStore({ context: ctx, state: { tenantId: "t-x" } }, () => {
        host.logger.info("inside-but-disabled");
      });

      const rec = RecordingTransport.records.find((r) => r.message === "inside-but-disabled");
      expect(rec).toBeDefined();
      // The logger never reads the store when enableContext is false.
      expect("context" in rec!).toBe(false);
      expect("state" in rec!).toBe(false);
    } finally {
      await app.stop();
    }
  });
});

describe("Edge Cases", () => {
  afterEach(() => {
    resetRecords();
  });

  it("nested runWithLogStore calls: the innermost store wins", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info", enableContext: true },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      const outer: HttpLogContext = {
        source: "flare:http",
        requestId: "rid-outer",
        method: "GET",
        url: "/outer",
      };
      const inner: HttpLogContext = {
        source: "flare:http",
        requestId: "rid-inner",
        method: "POST",
        url: "/inner",
      };

      runWithLogStore({ context: outer }, () => {
        host.logger.info("at-outer");
        runWithLogStore({ context: inner }, () => {
          host.logger.info("at-inner");
        });
        host.logger.info("after-inner");
      });

      const atOuter = RecordingTransport.records.find((r) => r.message === "at-outer");
      const atInner = RecordingTransport.records.find((r) => r.message === "at-inner");
      const afterInner = RecordingTransport.records.find((r) => r.message === "after-inner");

      expect(atOuter!.context).toEqual(outer);
      // Innermost wins while the inner run is on the stack.
      expect(atInner!.context).toEqual(inner);
      // After the inner run returns, the outer store is restored.
      expect(afterInner!.context).toEqual(outer);
    } finally {
      await app.stop();
    }
  });

  it("a record emitted in pretty mode whose context has method and url causes the inline summary to surface them", async () => {
    const adapter = makeAdapter({
      host: { env: "development" }, // 'development' picks pretty format by default.
      log: { level: "info", enableContext: true },
    }, { keepDefaultTransports: true });
    const host = newTestHost(adapter);
    const app = await host.build().test();
    try {
      const captured: string[] = [];
      const originalLog = console.log;
      console.log = (line?: unknown) => {
        captured.push(String(line));
      };
      try {
        const ctx: HttpLogContext = {
          source: "flare:http",
          requestId: "rid-pretty-1",
          method: "GET",
          url: "/users/42",
        };
        runWithLogStore({ context: ctx }, () => {
          host.logger.info("served");
        });
      } finally {
        console.log = originalLog;
      }

      const line = captured.find((l) => l.includes("served")) ?? "";
      const plain = stripAnsi(line);
      // Inline summary surfaces method and url alongside the message.
      expect(plain).toContain("GET");
      expect(plain).toContain("/users/42");
      expect(plain).toContain("served");
      // Sanity: the registered console transport is the one rendering this.
      expect(ConsoleTransport.transportName).toBe("console");
    } finally {
      await app.stop();
    }
  });

  it("an HTTP context with requestId produces request_id=<id> in the inline summary; a host context (no requestId) does not", async () => {
    const adapter = makeAdapter({
      host: { env: "development" },
      log: { level: "info", enableContext: true },
    }, { keepDefaultTransports: true });
    const host = newTestHost(adapter);
    const app = await host.build().test();
    try {
      const captured: string[] = [];
      const originalLog = console.log;
      console.log = (line?: unknown) => {
        captured.push(String(line));
      };
      try {
        const httpCtx: HttpLogContext = {
          source: "flare:http",
          requestId: "rid-summary-1",
          method: "GET",
          url: "/x",
        };
        runWithLogStore({ context: httpCtx }, () => {
          host.logger.info("with-http-ctx");
        });

        const hostCtx: HostLogContext = { source: "flare:host" };
        runWithLogStore({ context: hostCtx }, () => {
          host.logger.info("with-host-ctx");
        });
      } finally {
        console.log = originalLog;
      }

      const httpLine = stripAnsi(captured.find((l) => l.includes("with-http-ctx")) ?? "");
      const hostLine = stripAnsi(captured.find((l) => l.includes("with-host-ctx")) ?? "");

      // HTTP context: request_id token is in the inline summary.
      expect(httpLine).toContain("request_id=rid-summary-1");
      // Host context: no requestId field present, so the inline summary omits it.
      expect(hostLine).not.toContain("request_id=");
    } finally {
      await app.stop();
    }
  });

  it("a context with extra fields (beyond the typed shape) is passed through to the transport unchanged", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info", enableContext: true },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      // Add extra fields on top of HttpLogContext: the logger should not
      // strip or rename them; the transport sees them exactly.
      const ctx = {
        source: "flare:http",
        requestId: "rid-extras",
        method: "GET",
        url: "/extras",
        tenantId: "tnt-extras",
        traceId: "trace-abc",
      } as unknown as LogContext;

      runWithLogStore({ context: ctx }, () => {
        host.logger.info("extras");
      });

      const rec = RecordingTransport.records.find((r) => r.message === "extras");
      expect(rec).toBeDefined();
      // Pass-through: every key the caller put on the context survives.
      expect(rec!.context).toEqual(ctx);
      // And specifically, the extra keys are present (sanity-check the
      // pass-through claim, not just the deep-equal).
      expect((rec!.context as Record<string, unknown>).tenantId).toBe("tnt-extras");
      expect((rec!.context as Record<string, unknown>).traceId).toBe("trace-abc");
    } finally {
      await app.stop();
    }
  });
});

describe("Failure Modes", () => {
  afterEach(() => {
    resetRecords();
  });

  it("ALS does NOT flow into a callback invoked outside the original runWithLogStore scope; captureLogStore + runWithLogStore restores context", async () => {
    // The spec calls out CF's `ctx.waitUntil` as the platform constraint:
    // work scheduled there does not inherit the ALS store. The underlying
    // mechanism is generic: any callback invoked OUTSIDE an active
    // `runWithLogStore` frame sees no store, regardless of how it was captured.
    //
    // Node + Cloudflare workerd both implement `AsyncLocalStorage` such that
    // the store is bound to the synchronous execution of the `.run(...)`
    // callback (plus async continuations spawned from inside it). To
    // faithfully simulate the CF constraint without depending on a real CF
    // runtime, we capture the callback from inside the `.run` block and
    // invoke it from the outer scope after the run returns, matching the
    // observable shape for detached callbacks such as `waitUntil`.
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info", enableContext: true },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      const ctx: HttpLogContext = {
        source: "flare:http",
        requestId: "rid-detach",
        method: "GET",
        url: "/detach",
      };

      // Captured-from-inside, invoked-from-outside callback. This is the
      // documented platform-constraint shape for CFW `waitUntil`: the
      // callback's execution stack sits outside `runWithLogStore`.
      let deferred: (() => void) | undefined;
      let snapshot: ReturnType<typeof captureLogStore>;

      runWithLogStore({ context: ctx }, () => {
        // Sanity: inside the run, the store is visible to the logger.
        host.logger.info("inside-run");
        snapshot = captureLogStore();
        deferred = () => {
          // No surrounding runWithLogStore when this fires, so no store is visible.
          host.logger.info("detached-no-ctx");

          // Documented mitigation: snapshot and re-run.
          runWithLogStore(snapshot, () => {
            host.logger.info("detached-re-entered");
          });
        };
      });

      // Execute the captured callback from the outer scope, with no ALS
      // frame on the stack. Mirrors `waitUntil(fn)` running its argument
      // after the request handler returns.
      deferred!();

      const inside = RecordingTransport.records.find((r) => r.message === "inside-run");
      const detached = RecordingTransport.records.find((r) => r.message === "detached-no-ctx");
      const reentered = RecordingTransport.records.find((r) => r.message === "detached-re-entered");

      // Inside the original scope: context is attached.
      expect(inside!.context).toEqual(ctx);
      // Detached callback: ALS does not flow, so the logger sees no store and
      // the record carries no context (matches the documented constraint).
      expect("context" in detached!).toBe(false);
      // Once the caller re-enters via runWithLogStore, the context is restored.
      expect(reentered!.context).toEqual(ctx);
    } finally {
      await app.stop();
    }
  });
});

describe("Cross-Feature Interactions", () => {
  afterEach(() => {
    resetRecords();
  });

  it("an error record emitted inside the HTTP scope renders a pretty error block whose context section lists method, url, and request_id", async () => {
    // Combines: logger/request-context + logger/console-transport (pretty
    // error block) + logger/error-records (error normalization). We render
    // through the real ConsoleTransport in pretty mode and inspect the
    // captured output for the context section rows.
    const adapter = makeAdapter({
      host: { env: "development" },
      log: { level: "info", enableContext: true },
    }, { keepDefaultTransports: true });
    const host = newTestHost(adapter);
    const app = await host.build().test();
    try {
      const captured: string[] = [];
      const originalError = console.error;
      console.error = (line?: unknown) => {
        captured.push(String(line));
      };
      try {
        const ctx: HttpLogContext = {
          source: "flare:http",
          requestId: "rid-err-ctx",
          method: "POST",
          url: "/widgets",
        };
        runWithLogStore({ context: ctx }, () => {
          host.logger.error(new Error("boom-in-scope"), "while-handling");
        });
      } finally {
        console.error = originalError;
      }

      const block = captured.find((line) => line.includes("while-handling")) ?? "";
      const plain = stripAnsi(block);

      // Pretty error block header is present (logger/console-transport).
      expect(plain).toMatch(/┌─\s+Error/);
      expect(plain).toMatch(/│\s+boom-in-scope/);
      // HTTP context appears in the inline summary row (method, url, request_id).
      expect(plain).toMatch(/POST/);
      expect(plain).toContain("/widgets");
      expect(plain).toMatch(/request_id[= ]rid-err-ctx/);
    } finally {
      await app.stop();
    }
  });
});
