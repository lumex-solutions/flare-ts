/**
 * In-process integration tests for async host lifecycle ordering across the HTTP arc, singleton
 * services, and logger transports. `FLARE_MODE` must be set before imports so default adapters see
 * test mode; production-path tests temporarily clear it and restore before the next case.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { SingletonExtension } from "../../../../../src/lib/host/extensions/singleton.js";
import type { HostRuntimeAdapter } from "../../../../../src/lib/host/types/adapter.js";
import type { LogRecord } from "../../../../../src/lib/logger/types.js";
import type { LoggerTransportClass } from "../../../../../src/lib/logger/types.js";
import { FlareHost, FlareResponse, FlareService, Logger, LoggerTransport } from "../../../../../src/index.js";
import { singletonExtension } from "../../../../../src/lib/host/extensions/singleton.js";
import { FlareAppBase } from "../../../../../src/lib/host/flare-app-base.js";
import { node } from "../../../../../src/node.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

type LifecycleEvent = string;

/**
 * Silent transport that does not write to console. Used by every host built in this
 * file so test output stays clean.
 */
class SilentTransport extends LoggerTransport {
  static override readonly transportName = "silent";
  static override deps = [];
  override write(_record: LogRecord): void {
    /* intentionally swallow */
  }
}

/**
 * Async node-style adapter that uses a `SilentTransport` instead of the real
 * console transport. Mirrors `node` but with no FS access (so we do not need
 * a flare.json on disk) and an empty env so FlareHost construction does not
 * accidentally enter test mode based on process.env.
 */
function buildAsyncAdapter(): HostRuntimeAdapter<FlareAppBase, LoggerTransportClass, "async", SingletonExtension> {
  return {
    runtime: "node",
    lifecycle: "async",
    get flareJsonFile(): JsonObject {
      return {};
    },
    env: {},
    defaultLoggerTransports: [SilentTransport],
    createApp(host) {
      // The base class is abstract in TS but has no abstract members at
      // runtime; concrete behavior we exercise (start/stop/startAsync/
      // stopAsync) is fully implemented on FlareAppBase. The cast widens
      // the constructor return so TS accepts the assignment.
      return new (class extends FlareAppBase {})(host);
    },
    createLogger(transports, container) {
      return new Logger(transports, container);
    },
    createTestRequest() {
      throw new Error("not used by these tests");
    },
    extendHost(host) {
      return singletonExtension(host);
    },
  };
}

describe("Primary Behavior", () => {
  it(
    "Async runtime: same order, with await between each step (no parallel onStart execution)",
    async () => {
      const events: LifecycleEvent[] = [];

      // Each onStart pauses briefly via a resolved-microtask chain. If the
      // framework launched them in parallel, the events array would contain
      // interleaved `start:X:before` / `start:Y:before` entries. Because
      // FlareAppBase.startAsync awaits each instance.onStart() in turn,
      // every "before" entry must be immediately followed by its matching
      // "after" entry.
      class A extends FlareService {
        public static override deps = [];
        public override async onStart(): Promise<void> {
          events.push("start:A:before");
          await Promise.resolve();
          await Promise.resolve();
          events.push("start:A:after");
        }
        public override async onStop(): Promise<void> {
          events.push("stop:A:before");
          await Promise.resolve();
          events.push("stop:A:after");
        }
      }
      class B extends FlareService {
        public static override deps = [];
        public override async onStart(): Promise<void> {
          events.push("start:B:before");
          await Promise.resolve();
          await Promise.resolve();
          events.push("start:B:after");
        }
        public override async onStop(): Promise<void> {
          events.push("stop:B:before");
          await Promise.resolve();
          events.push("stop:B:after");
        }
      }

      const host = new FlareHost(buildAsyncAdapter());
      host.singleton(A);
      host.singleton(B);
      registerMinimalPingRoute(host);

      const app = host.build();
      // startAsync / stopAsync are public on FlareAppBase; the cast here is
      // not needed because both methods exist on the IFlareApp interface.
      await app.startAsync();
      await app.stopAsync();

      // No interleaving: each before/after pair is contiguous, and the
      // reverse order on stop is preserved.
      expect(events).toEqual([
        "start:A:before",
        "start:A:after",
        "start:B:before",
        "start:B:after",
        "stop:B:before",
        "stop:B:after",
        "stop:A:before",
        "stop:A:after",
      ]);
    },
  );

  it(
    "HTTP arc onStart fires before any singleton onStart; HTTP arc onStop fires "
      + "between last singleton onStop and Logger onStop",
    async () => {
      const events: LifecycleEvent[] = [];

      class A extends FlareService {
        public static override deps = [];
        public override async onStart(): Promise<void> {
          events.push("start:A");
        }
        public override async onStop(): Promise<void> {
          events.push("stop:A");
        }
      }
      class B extends FlareService {
        public static override deps = [];
        public override async onStart(): Promise<void> {
          events.push("start:B");
        }
        public override async onStop(): Promise<void> {
          events.push("stop:B");
        }
      }

      class RecordingTransport extends LoggerTransport {
        static override readonly transportName = "rec-async-1";
        static override deps = [];
        override write(_r: LogRecord): void {}
        override async onStart(): Promise<void> {
          events.push("start:Logger");
        }
        override async onStop(): Promise<void> {
          events.push("stop:Logger");
        }
      }

      const adapter: HostRuntimeAdapter<FlareAppBase, LoggerTransportClass, "async", SingletonExtension> = {
        runtime: "node",
        lifecycle: "async",
        get flareJsonFile(): JsonObject {
          return {};
        },
        env: {},
        defaultLoggerTransports: [RecordingTransport],
        createApp(host) {
          return new (class extends FlareAppBase {})(host);
        },
        createLogger(transports, container) {
          return new Logger(transports, container);
        },
        createTestRequest() {
          throw new Error("not used");
        },
        extendHost(host) {
          return singletonExtension(host);
        },
      };

      const host = new FlareHost(adapter);
      host.singleton(A);
      host.singleton(B);

      // HTTP arc onStart / onStop callbacks via host.http.onStart/onStop.
      host.http.onStart(() => {
        events.push("start:HttpArc");
      });
      host.http.onStop(() => {
        events.push("stop:HttpArc");
      });
      registerMinimalPingRoute(host);

      const app = host.build();
      await app.startAsync();
      await app.stopAsync();

      // On start: HttpArc, then Logger (first in singleton walk), then A, then B.
      // On stop: B, then A (reverse singleton walk excluding Logger), then
      // HttpArc, then Logger (last).
      expect(events).toEqual([
        "start:HttpArc",
        "start:Logger",
        "start:A",
        "start:B",
        "stop:B",
        "stop:A",
        "stop:HttpArc",
        "stop:Logger",
      ]);
    },
  );
});

describe("Edge Cases", () => {
  it(
    "a service that defines neither onStart nor onStop is walked but no method is called",
    async () => {
      const events: LifecycleEvent[] = [];

      // Inert has no lifecycle methods. The framework must still walk past
      // it (advancing #singletonIdx so reverse-stop slots align) without
      // throwing because `instance.onStart?.()` is undefined.
      class Inert extends FlareService {
        public static override deps = [];
        // no onStart, no onStop
      }
      class Recorded extends FlareService {
        public static override deps = [];
        public override async onStart(): Promise<void> {
          events.push("start:Recorded");
        }
        public override async onStop(): Promise<void> {
          events.push("stop:Recorded");
        }
      }

      const host = new FlareHost(buildAsyncAdapter());
      host.singleton(Inert);
      host.singleton(Recorded);
      registerMinimalPingRoute(host);

      const app = host.build();
      // If the framework attempted to invoke `Inert.onStart()` it would
      // throw `TypeError: undefined is not a function`. Successful start +
      // stop proves the optional-chain walk is honored, and the events
      // array proves the *other* singleton's hooks still ran.
      await app.startAsync();
      await app.stopAsync();

      expect(events).toEqual(["start:Recorded", "stop:Recorded"]);
    },
  );

  it(
    "partial start (failure in service N) results in stop() walking only services 0..N-1 in reverse",
    async () => {
      const events: LifecycleEvent[] = [];

      class A extends FlareService {
        public static override deps = [];
        public override async onStart(): Promise<void> {
          events.push("start:A");
        }
        public override async onStop(): Promise<void> {
          events.push("stop:A");
        }
      }
      class B extends FlareService {
        public static override deps = [];
        public override async onStart(): Promise<void> {
          events.push("start:B");
        }
        public override async onStop(): Promise<void> {
          events.push("stop:B");
        }
      }
      // C throws DURING onStart, so #singletonIdx never advances past C.
      class C extends FlareService {
        public static override deps = [];
        public override async onStart(): Promise<void> {
          events.push("start:C:before-throw");
          throw new Error("boom in C.onStart");
        }
        public override async onStop(): Promise<void> {
          events.push("stop:C");
        }
      }
      class D extends FlareService {
        public static override deps = [];
        public override async onStart(): Promise<void> {
          events.push("start:D");
        }
        public override async onStop(): Promise<void> {
          events.push("stop:D");
        }
      }

      const host = new FlareHost(buildAsyncAdapter());
      host.singleton(A);
      host.singleton(B);
      host.singleton(C);
      host.singleton(D);
      registerMinimalPingRoute(host);

      const app = host.build();
      await expect(app.startAsync()).rejects.toThrow("boom in C.onStart");

      // D never started; C never finished; #singletonIdx was advanced
      // through Logger + A + B and stopped at C (the throw came before
      // the `#singletonIdx++` increment for C).
      expect(events).toEqual(["start:A", "start:B", "start:C:before-throw"]);

      // stopAsync now walks indices 0..#singletonIdx-1 in reverse. That
      // window is {Logger, A, B}; Logger is skipped inside the loop and
      // handled last; the reverse walk yields B then A. C.onStop and
      // D.onStop must NOT run (they were never started).
      await app.stopAsync();
      expect(events).toEqual([
        "start:A",
        "start:B",
        "start:C:before-throw",
        "stop:B",
        "stop:A",
      ]);
    },
  );

  it(
    "Logger that fails onStart leaves #loggerStarted = false, so stop() does not attempt Logger.onStop",
    async () => {
      const events: LifecycleEvent[] = [];

      // Transport whose onStart rejects. Logger.onStart awaits every
      // transport.onStart before flipping #loggerStarted, so the rejection
      // propagates up through FlareAppBase.startAsync and #loggerStarted
      // stays false. Then stopAsync must skip Logger.onStop.
      class FailingStartTransport extends LoggerTransport {
        static override readonly transportName = "failing-start";
        static override deps = [];
        override write(_r: LogRecord): void {}
        override async onStart(): Promise<void> {
          events.push("transport:onStart:attempted");
          throw new Error("transport refused to start");
        }
        override async onStop(): Promise<void> {
          // MUST NOT fire when Logger.onStart failed; stopAsync skips Logger.onStop.
          events.push("transport:onStop:fired");
        }
      }

      const adapter: HostRuntimeAdapter<FlareAppBase> = {
        runtime: "node",
        lifecycle: "async",
        get flareJsonFile(): JsonObject {
          return {};
        },
        env: {},
        defaultLoggerTransports: [FailingStartTransport],
        createApp(host) {
          return new (class extends FlareAppBase {})(host);
        },
        createLogger(transports, container) {
          return new Logger(transports, container);
        },
        createTestRequest() {
          throw new Error("not used");
        },
      };

      const host = new FlareHost(adapter);
      registerMinimalPingRoute(host);
      const app = host.build();

      // Logger is the FIRST singleton in the walk. Its onStart rejection
      // aborts startAsync entirely.
      await expect(app.startAsync()).rejects.toThrow("transport refused to start");
      expect(events).toEqual(["transport:onStart:attempted"]);

      // stopAsync should be a clean no-op for Logger because #loggerStarted
      // is still false. No transport:onStop event may appear.
      await app.stopAsync();
      expect(events).toEqual(["transport:onStart:attempted"]);
    },
  );
});

describe("Failure Modes", () => {
  it(
    "an error in service onStop is captured into the AggregateError; later services "
      + "in the reverse walk still receive onStop",
    async () => {
      const events: LifecycleEvent[] = [];

      // Registration order: A, B, C. Reverse walk is C, B, A. B.onStop
      // throws; the framework must still call A.onStop and gather B's
      // error into the final AggregateError.
      class A extends FlareService {
        public static override deps = [];
        public override async onStop(): Promise<void> {
          events.push("stop:A");
        }
      }
      class B extends FlareService {
        public static override deps = [];
        public override async onStop(): Promise<void> {
          events.push("stop:B:before-throw");
          throw new Error("B.onStop failed");
        }
      }
      class C extends FlareService {
        public static override deps = [];
        public override async onStop(): Promise<void> {
          events.push("stop:C");
        }
      }

      const host = new FlareHost(buildAsyncAdapter());
      host.singleton(A);
      host.singleton(B);
      host.singleton(C);
      registerMinimalPingRoute(host);

      const app = host.build();
      await app.startAsync();

      // The aggregate carries the original Error inside `.errors`; the
      // outer message is the documented framework string.
      await expect(app.stopAsync()).rejects.toThrow(
        "One or more errors occurred during shutdown",
      );

      // Reverse walk: C ran, B threw, A still ran after the throw.
      expect(events).toEqual(["stop:C", "stop:B:before-throw", "stop:A"]);

      // The captured error is preserved verbatim in the AggregateError's
      // `errors` array so the runtime can surface diagnostics.
      let caught: unknown;
      try {
        await app.stopAsync();
      } catch (err) {
        caught = err;
      }
      // Second call: no services were re-started so the second stop walks
      // an empty window (#singletonIdx is past everything but instances
      // that already ran their stop hooks won't fire again because
      // #singletonIdx is not decremented by a stop walk; the framework
      // walks until 0 again, so the same throw recurs).
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toContainEqual(
        expect.objectContaining({ message: "B.onStop failed" }),
      );
    },
  );

  it(
    "an error in Logger onStop falls back to console.error and contributes to the AggregateError",
    async () => {
      // Intercept console.error so we can assert the fallback path fired
      // without polluting test output. Restore in finally so a thrown
      // assertion does not leak the override into sibling tests.
      const originalErr = console.error;
      const capturedConsole: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        capturedConsole.push(args);
      };

      try {
        // Transport whose onStop rejects after a successful start. Logger
        // wraps the transport, so Logger.onStop awaits the transport and
        // re-throws; FlareAppBase.stopAsync catches that rethrow, logs it
        // via console.error (because the logger itself is the failure
        // mode being reported), and pushes the error into the aggregate.
        class FailingStopTransport extends LoggerTransport {
          static override readonly transportName = "failing-stop";
          static override deps = [];
          override write(_r: LogRecord): void {}
          override async onStop(): Promise<void> {
            throw new Error("transport rejected during onStop");
          }
        }

        const adapter: HostRuntimeAdapter<FlareAppBase> = {
          runtime: "node",
          lifecycle: "async",
          get flareJsonFile(): JsonObject {
            return {};
          },
          env: {},
          defaultLoggerTransports: [FailingStopTransport],
          createApp(host) {
            return new (class extends FlareAppBase {})(host);
          },
          createLogger(transports, container) {
            return new Logger(transports, container);
          },
          createTestRequest() {
            throw new Error("not used");
          },
        };

        const host = new FlareHost(adapter);
        registerMinimalPingRoute(host);
        const app = host.build();
        await app.startAsync();

        let caught: unknown;
        try {
          await app.stopAsync();
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(AggregateError);
        expect((caught as AggregateError).message).toBe(
          "One or more errors occurred during shutdown",
        );
        // The aggregate carries the transport's error; the outer AggregateError
        // from Logger.onStop wraps it (Logger#stopAsync awaits a rejecting
        // transport and re-throws, surfacing as a plain Error caught by
        // FlareAppBase.stopAsync).
        const errors = (caught as AggregateError).errors;
        expect(errors.length).toBeGreaterThan(0);

        // Console fallback fired with the [flare] prefix so the logger
        // failure is visible even when the framework logger cannot record it.
        const flareCalls = capturedConsole.filter((args) =>
          typeof args[0] === "string" && args[0].startsWith("[flare] Error during logger shutdown:")
        );
        expect(flareCalls.length).toBe(1);
      } finally {
        console.error = originalErr;
      }
    },
  );

  it(
    "AggregateError is thrown only if at least one error occurred; clean shutdown returns void without throwing",
    async () => {
      const events: LifecycleEvent[] = [];

      class A extends FlareService {
        public static override deps = [];
        public override async onStart(): Promise<void> {
          events.push("start:A");
        }
        public override async onStop(): Promise<void> {
          events.push("stop:A");
        }
      }
      class B extends FlareService {
        public static override deps = [];
        public override async onStart(): Promise<void> {
          events.push("start:B");
        }
        public override async onStop(): Promise<void> {
          events.push("stop:B");
        }
      }

      const host = new FlareHost(buildAsyncAdapter());
      host.singleton(A);
      host.singleton(B);
      registerMinimalPingRoute(host);

      const app = host.build();
      await app.startAsync();
      // stopAsync returns Promise<void>; we explicitly capture the
      // resolved value to assert no error escaped and no value was returned.
      const result = await app.stopAsync();
      expect(result).toBeUndefined();
      // Successful walk produced the expected reverse order; the absence
      // of a thrown AggregateError is the contract on the happy path.
      expect(events).toEqual(["start:A", "start:B", "stop:B", "stop:A"]);
    },
  );
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with host/state) State advances starting -> ready after Node's server.listen "
      + "callback; ready -> draining -> stopped during #shutdown",
    async () => {
      // The real FlareAppNode (not the test-mode shim) is the only path
      // that calls SET_HOST_STATE("ready") inside the server.listen
      // callback and SET_HOST_STATE("draining") / "stopped" inside
      // #shutdown. Run it without FLARE_MODE so host.build() returns the
      // production FlareAppNode.
      const prev = process.env["FLARE_MODE"];
      delete process.env["FLARE_MODE"];

      try {
        const adapter: HostRuntimeAdapter<FlareAppBase> = {
          runtime: "node",
          lifecycle: "async",
          get flareJsonFile(): JsonObject {
            return {};
          },
          env: {},
          defaultLoggerTransports: [SilentTransport],
          createApp(host) {
            // Uses the real FlareAppNode via the node adapter's createApp so signal
            // handlers and server lifecycle match production.
            return node.createApp(host);
          },
          createLogger(transports, container) {
            return new Logger(transports, container);
          },
          createTestRequest(input) {
            return node.createTestRequest(input);
          },
        };

        const host = new FlareHost(adapter);
        host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

        // Pre-run: state begins "starting".
        expect(host.state).toBe("starting");

        // Use port 0 so the OS assigns a free port; we never actually
        // connect to it, just observe the lifecycle transitions.
        const app = host.build() as ReturnType<typeof node.createApp>;
        const handle = app.run({ port: 0, host: "127.0.0.1" });
        try {
          // Wait until server.listen's callback has fired. The handle
          // doesn't expose a "ready" promise, but the server emits the
          // listening event before SET_HOST_STATE("ready") returns.
          await new Promise<void>((resolve) => {
            if (handle.server.listening) resolve();
            else handle.server.once("listening", () => resolve());
          });
          // Tiny microtask hop so the onListening callback (which sets
          // state to "ready" right after server.listen succeeds) runs
          // before we read host.state.
          await Promise.resolve();
          expect(host.state).toBe("ready");
        } finally {
          // handle.stop() drives FlareAppNode.#shutdown which sets state
          // to "draining" up-front, drains, then advances to "stopped".
          await handle.stop();
        }

        expect(host.state).toBe("stopped");
      } finally {
        if (prev !== undefined) process.env["FLARE_MODE"] = prev;
      }
    },
  );

  it(
    "(with host/graceful-shutdown) stopAsync is invoked inside #shutdown after the "
      + "server has closed and active requests have drained",
    async () => {
      // FlareAppNode.#shutdown awaits #closeServer() and
      // #waitForActiveRequests() before calling stopAsync. If a singleton
      // records the wall-clock moment its onStop fires, that timestamp
      // must come AFTER the server has already stopped listening.
      const prev = process.env["FLARE_MODE"];
      delete process.env["FLARE_MODE"];

      try {
        let serverWasListeningAtStop: boolean | null = null;
        let serverRef: { listening: boolean; } | null = null;

        class ShutdownProbe extends FlareService {
          public static override deps = [];
          public override async onStop(): Promise<void> {
            serverWasListeningAtStop = serverRef ? serverRef.listening : null;
          }
        }

        const adapter: HostRuntimeAdapter<FlareAppBase, LoggerTransportClass, "async", SingletonExtension> = {
          runtime: "node",
          lifecycle: "async",
          get flareJsonFile(): JsonObject {
            return {};
          },
          env: {},
          defaultLoggerTransports: [SilentTransport],
          createApp(host) {
            return node.createApp(host);
          },
          createLogger(transports, container) {
            return new Logger(transports, container);
          },
          createTestRequest(input) {
            return node.createTestRequest(input);
          },
          extendHost(host) {
            return singletonExtension(host);
          },
        };

        const host = new FlareHost(adapter);
        host.singleton(ShutdownProbe);
        host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

        const app = host.build() as ReturnType<typeof node.createApp>;
        const handle = app.run({ port: 0, host: "127.0.0.1" });
        serverRef = handle.server;
        await new Promise<void>((resolve) => {
          if (handle.server.listening) resolve();
          else handle.server.once("listening", () => resolve());
        });
        await Promise.resolve();
        expect(handle.server.listening).toBe(true);

        await handle.stop();

        // The probe captured server.listening at the exact moment its
        // onStop ran. Because #shutdown awaits #closeServer (and
        // #closeServer awaits the server-close callback) before invoking
        // stopAsync, the server must already be non-listening.
        expect(serverWasListeningAtStop).toBe(false);
      } finally {
        if (prev !== undefined) process.env["FLARE_MODE"] = prev;
      }
    },
  );
});
