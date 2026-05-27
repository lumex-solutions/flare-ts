// Graceful Shutdown (Node) — Behavior tests.
//
// Drive the *real* FlareAppNode against a loopback socket (port 0) so the
// production `#shutdown` path runs end-to-end: signal handlers, server.close,
// drain gate, force-exit timer, stopAsync, and process.exit. To keep vitest
// alive across the suite, `process.exit` is captured into a recorder and never
// allowed to terminate the runner. Signal listeners installed by `run()` are
// snapshotted and torn down between tests so SIGTERM/SIGINT emitted by one
// case never bleeds into another.
//
// FLARE_MODE is intentionally NOT set: every test in this file exercises the
// production FlareAppNode (not the FlareTestApp shim), because graceful
// shutdown is a runtime concern with no test-mode equivalent.

import type { AddressInfo } from "node:net";
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { FlareAppBase } from "../../../src/lib/host/flare-app.js";
import type { HostRuntimeAdapter } from "../../../src/lib/host/types/adapter.js";
import type { LogRecord } from "../../../src/lib/logger/types.js";
import type { LoggerTransportClass } from "../../../src/lib/logger/types.js";
import { FlareHost, FlareResponse, Logger, LoggerTransport } from "../../../src/index.js";
import { node, type FlareAppNode } from "../../../src/lib/host/runtime/node.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";

// Shared scaffolding

/** Snapshot signal/process listeners, restore in afterEach. */
type ListenerSnapshot = {
  SIGTERM: NodeJS.SignalsListener[];
  SIGINT: NodeJS.SignalsListener[];
  uncaughtException: NodeJS.UncaughtExceptionListener[];
  unhandledRejection: NodeJS.UnhandledRejectionListener[];
};

type RunCtx = {
  host: FlareHost<HostRuntimeAdapter<FlareAppBase>>;
  app: FlareAppNode;
  handle: ReturnType<FlareAppNode["run"]>;
  port: number;
  records: LogRecord[];
};

/**
 * Build a recorder transport class plus a shared records array. Each call
 * produces a fresh class so multiple tests in the same module do not share
 * a static records buffer.
 */
function makeRecorder(): {
  TransportClass: LoggerTransportClass;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  class Recorder extends LoggerTransport {
    static override readonly transportName = "graceful-shutdown-recorder";
    static override deps = [];
    override write(record: LogRecord): void {
      records.push(record);
    }
  }
  return { TransportClass: Recorder, records };
}

/**
 * Build an async Node-style adapter whose only difference from the default
 * `node` adapter is (a) no FS read for flare.json, (b) a custom recorder
 * transport so tests can inspect framework logs, (c) empty env so FLARE_MODE
 * is never picked up. Uses `node.createApp` so the real `FlareAppNode` is
 * the produced app — the only path that exercises `#shutdown`.
 */
function buildNodeAdapter(
  TransportClass: LoggerTransportClass,
): HostRuntimeAdapter<FlareAppBase> {
  return {
    runtime: "node",
    lifecycle: "async",
    get flareJsonFile(): JsonObject {
      return {};
    },
    env: {},
    defaultLoggerTransports: [TransportClass],
    createApp(host) {
      return node.createApp(host);
    },
    createLogger(transports, container) {
      return new Logger(transports, container);
    },
    createTestRequest(input) {
      return node.createTestRequest(input);
    },
  };
}

function snapshotListeners(): ListenerSnapshot {
  return {
    SIGTERM: process.listeners("SIGTERM").slice(),
    SIGINT: process.listeners("SIGINT").slice(),
    uncaughtException: process.listeners("uncaughtException").slice(),
    unhandledRejection: process.listeners("unhandledRejection").slice(),
  };
}

function restoreListeners(snap: ListenerSnapshot): void {
  process.removeAllListeners("SIGTERM");
  for (const l of snap.SIGTERM) process.on("SIGTERM", l);
  process.removeAllListeners("SIGINT");
  for (const l of snap.SIGINT) process.on("SIGINT", l);
  process.removeAllListeners("uncaughtException");
  for (const l of snap.uncaughtException) process.on("uncaughtException", l);
  process.removeAllListeners("unhandledRejection");
  for (const l of snap.unhandledRejection) process.on("unhandledRejection", l);
}

/**
 * Pick out the LAST listener installed for an event — by construction this
 * is the one added by FlareAppNode.#bindProcessHandlers during `run()`.
 * Invoking it directly is safer than `process.emit(...)` because it bypasses
 * every other listener (including vitest's own) — only the framework's
 * handler runs.
 */
function frameworkSignalListener(event: "SIGTERM" | "SIGINT"): NodeJS.SignalsListener {
  const list = process.listeners(event);
  return list[list.length - 1] as NodeJS.SignalsListener;
}

function frameworkUncaughtListener(): NodeJS.UncaughtExceptionListener {
  const list = process.listeners("uncaughtException");
  return list[list.length - 1] as NodeJS.UncaughtExceptionListener;
}

function frameworkUnhandledRejectionListener(): NodeJS.UnhandledRejectionListener {
  const list = process.listeners("unhandledRejection");
  return list[list.length - 1] as NodeJS.UnhandledRejectionListener;
}

/** Hijack process.exit. Returns a [restore, getCalls] pair. */
function captureExit(): {
  restore: () => void;
  getCalls: () => Array<number | undefined>;
} {
  const original = process.exit;
  const calls: Array<number | undefined> = [];
  // Capture the exit code but DO NOT throw or actually exit. The framework's
  // #shutdown path issues a single process.exit() at the end of the async
  // IIFE; subsequent code is either a `throw new Error(...)` guarded on
  // `shutdownTimedOut === true` (only reachable via the explicit-stop
  // timeout path which sets exitProcess=false) or a no-op. Treating exit
  // as a no-op record keeps the test runner alive.
  (process as { exit: (code?: number) => void; }).exit = ((code?: number) => {
    calls.push(code);
  }) as typeof process.exit;
  return {
    restore: () => {
      (process as { exit: typeof process.exit; }).exit = original;
    },
    getCalls: () => calls,
  };
}

/** Hit the running server with a real HTTP request. */
function httpGet(
  port: number,
  path: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { connection: "close" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Wait for `server.listening` to flip true. */
function awaitListening(server: { listening: boolean; once: (event: string, fn: () => void) => void; }): Promise<void> {
  return new Promise((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", () => resolve());
  });
}

async function startApp(opts: {
  routes?: (host: FlareHost<HostRuntimeAdapter<FlareAppBase>>) => void;
  singletons?: (host: FlareHost<HostRuntimeAdapter<FlareAppBase>>) => void;
  shutdownTimeout?: number;
} = {}): Promise<RunCtx> {
  const { TransportClass, records } = makeRecorder();
  const host = new FlareHost(buildNodeAdapter(TransportClass));
  opts.singletons?.(host);
  // Always register /ping so drain tests can probe 503 while custom routes exist.
  host.http.get("/ping", () => new FlareResponse(200, { ok: true }));
  opts.routes?.(host);
  const app = host.build() as FlareAppNode;
  const handle = app.run({
    port: 0,
    host: "127.0.0.1",
    ...(opts.shutdownTimeout !== undefined ? { shutdownTimeout: opts.shutdownTimeout } : {}),
  });
  await awaitListening(handle.server);
  await Promise.resolve();
  const port = (handle.server.address() as AddressInfo).port;
  return { host, app, handle, port, records };
}

// Per-test setup / teardown

let listenerSnap: ListenerSnapshot;
let exitCapture: ReturnType<typeof captureExit>;

beforeEach(() => {
  listenerSnap = snapshotListeners();
  exitCapture = captureExit();
});

afterEach(() => {
  exitCapture.restore();
  restoreListeners(listenerSnap);
});

// ===========================================================================
// Primary Behavior
// ===========================================================================

describe("Primary Behavior", () => {
  it(
    "SIGTERM triggers #shutdown({ exitCode: 0, exitProcess: true }): state advances to "
      + "'draining', in-flight requests complete, stopAsync runs, state advances to 'stopped', "
      + "process exits 0",
    async () => {
      const events: string[] = [];
      class Probe extends FlareService {
        public static override deps = [];
        public override async onStop(): Promise<void> {
          events.push("probe:onStop");
        }
      }

      const ctx = await startApp({
        singletons: (h) => h.singleton(Probe),
      });
      expect(ctx.host.state).toBe("ready");

      // Invoke the framework's SIGTERM listener directly (the last one
      // installed on `process` — by construction the one #bindProcessHandlers
      // just added). Direct invocation avoids triggering any other process-
      // level listeners the test runner has installed.
      frameworkSignalListener("SIGTERM")("SIGTERM");

      // The signal listener fires #shutdown without awaiting it; poll the
      // captured exit list to detect when the IIFE has reached process.exit.
      for (let i = 0; i < 200 && exitCapture.getCalls().length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(exitCapture.getCalls()).toEqual([0]);
      expect(events).toContain("probe:onStop");
      expect(ctx.host.state).toBe("stopped");
    },
  );

  it("SIGINT mirrors SIGTERM (state -> stopped, exit code 0)", async () => {
    const ctx = await startApp();

    frameworkSignalListener("SIGINT")("SIGINT");

    for (let i = 0; i < 200 && exitCapture.getCalls().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(exitCapture.getCalls()).toEqual([0]);
    expect(ctx.host.state).toBe("stopped");
  });

  it(
    "NodeRunHandle.stop() triggers shutdown with exitProcess: false; the host process keeps running",
    async () => {
      const ctx = await startApp();

      await ctx.handle.stop();

      // process.exit was NOT called — the test runner is alive precisely
      // because handle.stop() uses exitProcess: false.
      expect(exitCapture.getCalls()).toEqual([]);
      expect(ctx.host.state).toBe("stopped");
      // The server has closed; subsequent connects must be refused.
      await expect(httpGet(ctx.port, "/ping")).rejects.toThrow();
    },
  );
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge Cases", () => {
  it(
    "drain timeout fires when in-flight requests exceed host.shutdownTimeout: "
      + "closeAllConnections() is invoked, waiter resolves immediately, exit code becomes 1",
    async () => {
      // Build an app with a route that never completes. The drain gate
      // therefore never resolves on its own; the timeout must trip and
      // force-close.
      let serverCloseAllInvoked = false;
      const neverResolve = new Promise<FlareResponse>(() => {});

      const ctx = await startApp({
        // /ping is already registered by startApp; only add the hang route.
        routes: (h) => {
          h.http.get("/hang", () => neverResolve);
        },
        shutdownTimeout: 50,
      });

      // Wrap server.closeAllConnections so we can verify the timer invoked it.
      const original = ctx.handle.server.closeAllConnections?.bind(ctx.handle.server);
      ctx.handle.server.closeAllConnections = function() {
        serverCloseAllInvoked = true;
        return original?.();
      };

      // Fire the hanging request and DO NOT await it (it never completes).
      // Allow Node to actually dispatch the request through the socket.
      const hung = httpGet(ctx.port, "/hang").catch(() => null);
      await new Promise((r) => setTimeout(r, 30));

      // Trigger shutdown via handle.stop(). exitProcess=false so the timeout
      // path throws "Graceful shutdown timeout exceeded..." instead of exiting.
      const stop = ctx.handle.stop();
      await expect(stop).rejects.toThrow(/Graceful shutdown timeout exceeded after 50ms\./);

      expect(serverCloseAllInvoked).toBe(true);
      expect(ctx.host.state).toBe("stopped");

      await hung;
    },
  );

  it(
    "#shutdown invoked twice returns the same #shutdownPromise; the second caller does not "
      + "re-run side effects",
    async () => {
      let onStopCount = 0;
      class CountingStop extends FlareService {
        public static override deps = [];
        public override async onStop(): Promise<void> {
          onStopCount++;
        }
      }

      const ctx = await startApp({
        singletons: (h) => h.singleton(CountingStop),
      });

      const first = ctx.handle.stop();
      const second = ctx.handle.stop();

      // Both promises resolve from the same underlying #shutdownPromise.
      await Promise.all([first, second]);
      expect(onStopCount).toBe(1);
    },
  );

  it(
    "force-exit timer is .unref()-ed so it does not keep the loop alive on its own",
    async () => {
      // White-box: spy on setTimeout to capture the timer the runtime creates,
      // then assert .unref was called on it. The default `setTimeout` returns
      // a Timeout instance whose unref method the framework invokes; if the
      // call were missing the loop would hang for `shutdownTimeout` ms after
      // a clean drain.
      const originalSetTimeout = globalThis.setTimeout;
      let unrefCalled = false;
      // Only intercept the very first setTimeout call AFTER stop() is invoked,
      // and only for the framework's exact timeout (shutdownTimeout). We use
      // a sentinel value that no other concurrent code is likely to request.
      const SENTINEL = 7777;
      let captured = false;
      // Use Parameters<> instead of the DOM-lib `TimerHandler` alias so this
      // file does not require `lib: ["DOM"]` in tsconfig.
      const spy: typeof globalThis.setTimeout =
        ((handler: Parameters<typeof setTimeout>[0], timeoutMs?: number, ...rest: unknown[]) => {
          const timer = originalSetTimeout(handler as never, timeoutMs as never, ...rest as never[]);
          if (!captured && timeoutMs === SENTINEL) {
            captured = true;
            const originalUnref = (timer as unknown as { unref: () => void; }).unref?.bind(timer);
            (timer as unknown as { unref: () => void; }).unref = () => {
              unrefCalled = true;
              originalUnref?.();
            };
          }
          return timer;
        }) as typeof globalThis.setTimeout;
      globalThis.setTimeout = spy;

      try {
        const ctx = await startApp({ shutdownTimeout: SENTINEL });
        await ctx.handle.stop();
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }

      expect(captured).toBe(true);
      expect(unrefCalled).toBe(true);
    },
  );

  it(
    "new requests during drain return 503 Service Unavailable with connection: close",
    async () => {
      // A handler that gates on a manually resolved Promise. While we hold
      // that gate, the request is in flight, shutdown is blocked, and any
      // *new* request that arrives must be rejected with 503.
      let releaseInFlight!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseInFlight = resolve;
      });

      const ctx = await startApp({
        routes: (h) => {
          h.http.get("/slow", async () => {
            await gate;
            return new FlareResponse(200, { ok: true });
          });
        },
        shutdownTimeout: 5_000,
      });

      // Start the slow request; do not await.
      const slow = httpGet(ctx.port, "/slow");
      // Ensure the request has actually been accepted by the server.
      await new Promise((r) => setTimeout(r, 30));

      // Begin shutdown; do not await.
      const shutdown = ctx.handle.stop();
      for (let i = 0; i < 200 && ctx.host.state !== "draining"; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(ctx.host.state).toBe("draining");

      // A new request while draining: must be 503, connection close. Retry while
      // the server may still be accepting connections during drain.
      let rejected: Awaited<ReturnType<typeof httpGet>> | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          rejected = await httpGet(ctx.port, "/ping");
          if (rejected.status === 503) break;
        } catch (err) {
          if (ctx.host.state !== "draining") throw err;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(rejected?.status).toBe(503);
      // `expect` doesn't narrow `rejected`; assert non-null for the follow-on
      // assertions (we've just asserted .status === 503, so it must exist).
      expect(rejected!.headers["connection"]).toBe("close");
      expect(rejected!.body).toContain("Service Unavailable");

      // Release the gate so drain completes and shutdown finishes cleanly.
      releaseInFlight();
      const ok = await slow;
      expect(ok.status).toBe(200);
      await shutdown;
    },
  );
});

// ===========================================================================
// Failure Modes
// ===========================================================================

describe("Failure Modes", () => {
  it(
    "uncaughtException triggers shutdown with exit code 1; logger logs the exception with fatal severity",
    async () => {
      const ctx = await startApp();

      // Synthesize the exact event Node would dispatch for an uncaught throw.
      // The framework registered a handler via `process.on('uncaughtException', ...)`.
      // Invoke that handler directly (last registered = ours).
      const fakeErr = new Error("synthetic uncaught");
      frameworkUncaughtListener()(fakeErr, "uncaughtException");

      for (let i = 0; i < 200 && exitCapture.getCalls().length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(exitCapture.getCalls()).toEqual([1]);

      // A fatal-level record carrying the synthetic error must have been
      // emitted to the recorder transport.
      const fatals = ctx.records.filter((r) => r.level === "fatal");
      expect(fatals.length).toBeGreaterThan(0);
      const carryingError = fatals.find(
        (r) => r.error && r.error.message === "synthetic uncaught",
      );
      expect(carryingError).toBeDefined();
    },
  );

  it("unhandledRejection triggers shutdown with exit code 1", async () => {
    await startApp();

    // Node would normally pass (reason, promise). The framework only reads
    // `reason`; the second arg is unused. Invoke directly to bypass other
    // listeners (including vitest's).
    frameworkUnhandledRejectionListener()(new Error("synthetic rejection"), Promise.resolve());

    for (let i = 0; i < 200 && exitCapture.getCalls().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(exitCapture.getCalls()).toEqual([1]);
  });

  it(
    "stopAsync rejection during shutdown still produces a final state of 'stopped'; exit code becomes 1",
    async () => {
      class FailingStop extends FlareService {
        public static override deps = [];
        public override async onStop(): Promise<void> {
          throw new Error("onStop blew up");
        }
      }
      const ctx = await startApp({
        singletons: (h) => h.singleton(FailingStop),
      });

      // exitProcess: true path: the runtime swallows the stopAsync rejection
      // internally (logged as "Error during shutdown") and calls process.exit(1).
      frameworkSignalListener("SIGTERM")("SIGTERM");
      for (let i = 0; i < 200 && exitCapture.getCalls().length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }

      expect(exitCapture.getCalls()).toEqual([1]);
      expect(ctx.host.state).toBe("stopped");

      const errors = ctx.records.filter((r) => r.level === "error");
      expect(errors.some((r) => r.message === "Error during shutdown")).toBe(true);
    },
  );

  it(
    "when timeout fires AND exitProcess === false, #shutdown throws "
      + "'Graceful shutdown timeout exceeded after <N>ms.'",
    async () => {
      const neverResolve = new Promise<FlareResponse>(() => {});
      const ctx = await startApp({
        // /ping is already registered by startApp; only add the hang route.
        routes: (h) => {
          h.http.get("/hang", () => neverResolve);
        },
        shutdownTimeout: 30,
      });

      // Start the hanging request and let it land on the server.
      const hung = httpGet(ctx.port, "/hang").catch(() => null);
      await new Promise((r) => setTimeout(r, 20));

      // exitProcess === false because handle.stop() supplies it.
      await expect(ctx.handle.stop()).rejects.toThrow(
        "Graceful shutdown timeout exceeded after 30ms.",
      );

      await hung;
    },
  );
});

// ===========================================================================
// Cross-Feature Interactions
// ===========================================================================

describe("Cross-Feature Interactions", () => {
  it(
    "(with host/state) The state sequence 'starting -> ready -> draining -> stopped' is "
      + "observable end-to-end",
    async () => {
      const observed: string[] = [];

      const { TransportClass } = makeRecorder();
      const host = new FlareHost(buildNodeAdapter(TransportClass));
      class Probe extends FlareService {
        public static override deps = [];
        public override async onStop(): Promise<void> {
          observed.push(host.state); // captured mid-shutdown -> "draining"
        }
      }
      host.singleton(Probe);
      host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

      observed.push(host.state); // "starting"
      const app = host.build() as FlareAppNode;
      const handle = app.run({ port: 0, host: "127.0.0.1" });
      await awaitListening(handle.server);
      await Promise.resolve();
      observed.push(host.state); // "ready"

      await handle.stop();
      observed.push(host.state); // "stopped"

      expect(observed).toEqual(["starting", "ready", "draining", "stopped"]);
    },
  );

  it(
    "(with host/lifecycle) stopAsync walks singleton onStop in reverse order; "
      + "Logger.onStop runs last",
    async () => {
      const events: string[] = [];

      class A extends FlareService {
        public static override deps = [];
        public override async onStop(): Promise<void> {
          events.push("stop:A");
        }
      }
      class B extends FlareService {
        public static override deps = [];
        public override async onStop(): Promise<void> {
          events.push("stop:B");
        }
      }
      class C extends FlareService {
        public static override deps = [];
        public override async onStop(): Promise<void> {
          events.push("stop:C");
        }
      }

      // Logger.onStop is observable via a transport whose onStop is part of
      // the Logger shutdown sequence (Logger.onStop drives its transports).
      class LoggerProbeTransport extends LoggerTransport {
        static override readonly transportName = "logger-probe";
        static override deps = [];
        override write(_r: LogRecord): void {}
        override async onStop(): Promise<void> {
          events.push("stop:Logger");
        }
      }

      const host = new FlareHost({
        runtime: "node",
        lifecycle: "async",
        get flareJsonFile(): JsonObject {
          return {};
        },
        env: {},
        defaultLoggerTransports: [LoggerProbeTransport],
        createApp(h) {
          return node.createApp(h);
        },
        createLogger(transports, container) {
          return new Logger(transports, container);
        },
        createTestRequest(input) {
          return node.createTestRequest(input);
        },
      });
      host.singleton(A);
      host.singleton(B);
      host.singleton(C);
      host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

      const app = host.build() as FlareAppNode;
      const handle = app.run({ port: 0, host: "127.0.0.1" });
      await awaitListening(handle.server);
      await Promise.resolve();

      await handle.stop();

      // Reverse order C, B, A — then Logger last.
      expect(events).toEqual(["stop:C", "stop:B", "stop:A", "stop:Logger"]);
    },
  );

  it(
    "(with host/runtime-node) Server keeps listening through drain so new requests get 503; close runs after drain",
    async () => {
      // The Node runtime defers `server.close()` until after the drain wait
      // completes. This is what lets `#handleIncomingRequest` answer new
      // arrivals with 503 + Connection: close during drain (instead of
      // letting the OS reject the TCP connection). Assert the inverse here:
      // while the drain gate is held, `server.listening` is still true.
      let releaseInFlight!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseInFlight = resolve;
      });

      const ctx = await startApp({
        routes: (h) => {
          h.http.get("/slow", async () => {
            await gate;
            return new FlareResponse(200, { ok: true });
          });
        },
        shutdownTimeout: 5_000,
      });

      // In-flight request; do not await.
      const slow = httpGet(ctx.port, "/slow");
      await new Promise((r) => setTimeout(r, 30));

      // Begin shutdown; do not await yet.
      const shutdown = ctx.handle.stop();

      // Sample listening state across the drain window. The server must stay
      // listening for the entire time the drain gate is held.
      let stillListeningDuringDrain = true;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 10));
        if (!ctx.handle.server.listening) {
          stillListeningDuringDrain = false;
          break;
        }
      }
      expect(stillListeningDuringDrain).toBe(true);

      // Release the in-flight request so drain can finish, and let shutdown
      // resolve cleanly.
      releaseInFlight();
      await slow.catch(() => null);
      await shutdown;

      // After shutdown resolves, the listening socket is closed.
      expect(ctx.handle.server.listening).toBe(false);
    },
  );
});
