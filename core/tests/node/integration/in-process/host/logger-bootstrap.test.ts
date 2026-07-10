/**
 * In-process integration tests for logger bootstrap: transport fan-out order,
 * one-shot instantiation, DI availability after build, and bootstrap failures.
 */
process.env.FLARE_MODE = "test";

import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { node } from "../../../../../src/lib/host/runtime/node/node.js";
import type { ConsoleTransport } from "../../../../../src/lib/logger/transports/console.js";
import type { LogRecord } from "../../../../../src/lib/logger/types.js";
import type { Container } from "../../../../../src/lib/services/container.js";
import { Get } from "../../../../../src/decorators.js";
import {
  ControllerBase,
  FlareHost,
  FlareResponse,
  FlareService,
  HOST_CONFIG,
  LOG_CONFIG,
  Logger,
  LoggerTransport,
  MiddlewareBase,
} from "../../../../../src/index.js";
import { nodeAdapter } from "../../../../node/helpers/node-adapter.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

function newTestHost(adapter: ReturnType<typeof nodeAdapter>) {
  const host = new FlareHost(adapter);
  registerMinimalPingRoute(host);
  return host;
}

// Adapter helpers. The default Node and CF adapters install ConsoleTransport /
// CfConsoleTransport as their first default; tests that want a deterministic
// transport list override `defaultLoggerTransports`. Tests that exercise the
// "defaults first" ordering keep the production default in place.

function makeNodeAdapter(
  config: JsonObject,
  opts: { defaults?: readonly (typeof ConsoleTransport)[]; } = {},
) {
  return nodeAdapter(config, { FLARE_MODE: "test" }, {
    defaultLoggerTransports: opts.defaults ?? [],
  });
}

// Recording transports.

const transportConstructionCounts: Record<string, number> = {};

class RecordingTransportA extends LoggerTransport {
  static override readonly transportName = "rec-a";
  static override deps: never[] = [];
  static readonly records: LogRecord[] = [];
  constructor(container: Container) {
    super(container);
    transportConstructionCounts["rec-a"] = (transportConstructionCounts["rec-a"] ?? 0) + 1;
  }
  write(record: LogRecord): void {
    RecordingTransportA.records.push(record);
  }
}

class RecordingTransportB extends LoggerTransport {
  static override readonly transportName = "rec-b";
  static override deps: never[] = [];
  static readonly records: LogRecord[] = [];
  constructor(container: Container) {
    super(container);
    transportConstructionCounts["rec-b"] = (transportConstructionCounts["rec-b"] ?? 0) + 1;
  }
  write(record: LogRecord): void {
    RecordingTransportB.records.push(record);
  }
}

class RecordingTransportC extends LoggerTransport {
  static override readonly transportName = "rec-c";
  static override deps: never[] = [];
  static readonly records: LogRecord[] = [];
  constructor(container: Container) {
    super(container);
    transportConstructionCounts["rec-c"] = (transportConstructionCounts["rec-c"] ?? 0) + 1;
  }
  write(record: LogRecord): void {
    RecordingTransportC.records.push(record);
  }
}

function resetRecorders(): void {
  RecordingTransportA.records.length = 0;
  RecordingTransportB.records.length = 0;
  RecordingTransportC.records.length = 0;
  for (const k of Object.keys(transportConstructionCounts)) delete transportConstructionCounts[k];
}

// Primary Behavior

describe("Primary Behavior", () => {
  afterEach(() => {
    resetRecorders();
  });

  it(
    "after build, host.logger.info(...) emits a record that all configured transports receive in registration order (defaults first, then user-registered)",
    async () => {
      // Defaults: a single recording default. Then user-registered: A then B.
      // Expected delivery order on a single info() call: default, then A, then B.
      // Track order: each transport pushes its name onto a shared sequence
      // array on each write call.
      const writeOrder: string[] = [];
      class OrderingTransportDefault extends LoggerTransport {
        static override readonly transportName = "ord-default";
        static override deps: never[] = [];
        write(_record: LogRecord): void {
          writeOrder.push("ord-default");
        }
      }
      class OrderingTransportA extends LoggerTransport {
        static override readonly transportName = "ord-a";
        static override deps: never[] = [];
        write(_record: LogRecord): void {
          writeOrder.push("ord-a");
        }
      }
      class OrderingTransportB extends LoggerTransport {
        static override readonly transportName = "ord-b";
        static override deps: never[] = [];
        write(_record: LogRecord): void {
          writeOrder.push("ord-b");
        }
      }

      const adapter = makeNodeAdapter(
        { host: { env: "test" }, log: { level: "info" } },
        { defaults: [OrderingTransportDefault as unknown as typeof ConsoleTransport] },
      );
      const host = newTestHost(adapter);
      host.logging.transport(OrderingTransportA);
      host.logging.transport(OrderingTransportB);

      const app = await host.build().test();
      try {
        writeOrder.length = 0;
        host.logger.info("primary-emit");

        // Exactly one write per transport, in registration order: default
        // first (from adapter.defaultLoggerTransports), then user-registered
        // transports in the order .transport() was called.
        expect(writeOrder).toEqual(["ord-default", "ord-a", "ord-b"]);
      } finally {
        await app.stop();
      }
    },
  );

  it("transports declared via host.logging.transport(...) are instantiated exactly once each per build", async () => {
    const adapter = makeNodeAdapter({ host: { env: "test" }, log: { level: "info" } });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransportA);
    host.logging.transport(RecordingTransportB);
    host.logging.transport(RecordingTransportC);

    const app = await host.build().test();
    try {
      expect(transportConstructionCounts["rec-a"]).toBe(1);
      expect(transportConstructionCounts["rec-b"]).toBe(1);
      expect(transportConstructionCounts["rec-c"]).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it(
    "logger is available to controllers, middleware, and services via DI as soon as build completes",
    async () => {
      // Each component (controller, middleware, singleton service) calls
      // `this.inject(Logger)` and logs through it. The recording transport
      // captures every emission, proving DI resolution returned the same
      // Logger that the host registered.
      class WitnessService extends FlareService {
        static override readonly deps = [Logger];
        public seenLoggerInOnStart: boolean = false;
        // Resolve immediately at construction (post-build) so we observe the
        // DI graph as soon as build completes.
        readonly #logger = this.inject(Logger);
        override onStart(): void {
          this.#logger.info("svc-onstart");
          this.seenLoggerInOnStart = true;
        }
      }

      class WitnessMiddleware extends MiddlewareBase {
        static override deps = [Logger];
        static override state = [];
        readonly #logger = this.inject(Logger);
        override before(): void {
          this.#logger.info("mw-before");
        }
      }

      class WitnessController extends ControllerBase {
        static override deps = [Logger];
        static override state = [];
        readonly #logger = this.inject(Logger);

        @Get("")
        public async show(): Promise<FlareResponse> {
          this.#logger.info("ctrl-handle");
          return new FlareResponse(200, { ok: true });
        }
      }

      const adapter = makeNodeAdapter({ host: { env: "test" }, log: { level: "info" } });
      const host = newTestHost(adapter);
      host.logging.transport(RecordingTransportA);
      host.singleton(WitnessService);
      host.http.use(WitnessMiddleware);
      host.http.controller("/witness", WitnessController);

      const app = await host.build().test();
      try {
        // The singleton already started; verify it observed the Logger.
        const svc = host.singletonServices.get(WitnessService) as WitnessService | undefined;
        expect(svc).toBeInstanceOf(WitnessService);
        expect(svc!.seenLoggerInOnStart).toBe(true);

        // The recording transport saw the singleton's onStart log.
        expect(
          RecordingTransportA.records.some((r) => r.message === "svc-onstart"),
        ).toBe(true);

        // A request fires the middleware and controller, both of which inject
        // the Logger. Both messages reach the transport.
        const res = await app.fetch("GET /witness");
        expect(res.status).toBe(200);
        expect(RecordingTransportA.records.some((r) => r.message === "mw-before")).toBe(true);
        expect(RecordingTransportA.records.some((r) => r.message === "ctrl-handle")).toBe(true);
      } finally {
        await app.stop();
      }
    },
  );
});

// Edge Cases

describe("Edge Cases", () => {
  afterEach(() => {
    resetRecorders();
  });

  it(
    "a transport that calls this.config(TOKEN) during construction resolves the value from the resolved host config",
    async () => {
      let observedHostEnv: string | undefined;
      let observedLogLevel: string | undefined;

      class ConfigSnoopTransport extends LoggerTransport {
        static override readonly transportName = "snoop";
        static override deps: never[] = [];
        static override readonly config = [HOST_CONFIG, LOG_CONFIG] as const;
        constructor(container: Container) {
          super(container);
          // Calling `this.config(...)` during construction must resolve
          // against the host's compiled config, not throw.
          observedHostEnv = this.config(HOST_CONFIG).env;
          observedLogLevel = this.config(LOG_CONFIG).level;
        }
        write(_record: LogRecord): void {}
      }

      const adapter = makeNodeAdapter({
        host: { env: "production" },
        log: { level: "warn" },
      });
      const host = newTestHost(adapter);
      host.logging.transport(ConfigSnoopTransport);

      const app = await host.build().test();
      try {
        expect(observedHostEnv).toBe("production");
        expect(observedLogLevel).toBe("warn");
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "a transport that tries to call this.inject(SOME_SERVICE) during construction throws (logging cannot depend on user services)",
    () => {
      class SomeUserService extends FlareService {
        static override readonly deps = [];
      }

      class InjectingDuringCtorTransport extends LoggerTransport {
        static override readonly transportName = "inject-ctor";
        static override deps: never[] = [];
        constructor(container: Container) {
          super(container);
          // Will throw: transports cannot inject services. The override on
          // LoggerTransport raises rather than resolving the token.
          this.inject(SomeUserService);
        }
        write(_record: LogRecord): void {}
      }

      const adapter = makeNodeAdapter({ host: { env: "test" }, log: { level: "info" } });
      const host = newTestHost(adapter);
      host.logging.transport(InjectingDuringCtorTransport);

      // Construction of the transport happens inside #compileLogger, which
      // runs synchronously inside host.build(). The override-inject throw
      // therefore surfaces directly from build().
      expect(() => host.build()).toThrow("transports cannot inject services");
    },
  );

  it(
    "host.logger getter throws if accessed before build (the Logger singleton is not in the map yet)",
    () => {
      const adapter = makeNodeAdapter({ host: { env: "test" }, log: { level: "info" } });
      const host = newTestHost(adapter);

      // Pre-build: no #compileLogger() has run, so the singletons map has no
      // Logger entry. The getter throws a diagnostic message naming the
      // missing #compileLogger() step.
      expect(() => host.logger).toThrow("Logger not initialized yet");
    },
  );
});

// Failure Modes

describe("Failure Modes", () => {
  afterEach(() => {
    resetRecorders();
  });

  it(
    "constructor throw from any transport surfaces during build and aborts the rest of the build",
    async () => {
      class TrailingTransport extends LoggerTransport {
        static override readonly transportName = "trailing-fm";
        static override deps: never[] = [];
        static constructed = false;
        constructor(container: Container) {
          super(container);
          TrailingTransport.constructed = true;
        }
        write(_record: LogRecord): void {}
      }

      class ExplodingTransport extends LoggerTransport {
        static override readonly transportName = "exploding";
        static override deps: never[] = [];
        constructor(container: Container) {
          super(container);
          throw new Error("transport ctor boom");
        }
        write(_record: LogRecord): void {}
      }

      const adapter = makeNodeAdapter({ host: { env: "test" }, log: { level: "info" } });
      const host = newTestHost(adapter);
      host.logging.transport(ExplodingTransport);
      host.logging.transport(TrailingTransport);

      TrailingTransport.constructed = false;

      // The build throws synchronously the moment the transport ctor throws,
      // before TrailingTransport is constructed. Calling .test() on a thrown
      // build path means host.build() itself raises, surfacing the ctor error.
      expect(() => host.build()).toThrow("transport ctor boom");

      // The next-registered transport never got instantiated.
      expect(TrailingTransport.constructed).toBe(false);
    },
  );

  it(
    "if adapter.createLogger returns a non-Logger value, attempting to access host.logger and call logger.info fails loudly",
    () => {
      // Replace createLogger to return a value with no .info / .trace methods.
      // host.build() immediately calls `this.logger.trace(...)` after
      // #compileLogger, so the broken logger surfaces synchronously as a
      // "not a function" TypeError during build.
      const adapter = {
        ...nodeAdapter({ host: { env: "test" }, log: { level: "info" } }, { FLARE_MODE: "test" }, {
          defaultLoggerTransports: [],
        }),
        createLogger: () => ({}) as unknown as ReturnType<typeof node.createLogger>,
      };

      const host = newTestHost(adapter);

      // The broken object IS placed into singletons (the getter only checks
      // truthiness), so host.logger returns it; calling any log method on it
      // throws "is not a function". The first such call is host.logger.trace
      // inside host.build() itself.
      expect(() => host.build()).toThrow(/is not a function/);

      // Independent of build: even if we sidestep build, accessing logger.info
      // on a non-Logger value is not callable.
      // (Re-using `host` here would re-trigger the same build throw; demonstrate
      // the failing call shape on a fresh broken logger object directly.)
      const broken = {} as unknown as Logger;
      expect(() => broken.info("anything")).toThrow(/is not a function/);
    },
  );
});

// Cross-Feature Interactions

describe("Cross-Feature Interactions", () => {
  afterEach(() => {
    resetRecorders();
  });

  it(
    "(with host/logging-composition) transport registration order is preserved end-to-end: registered first receives first",
    async () => {
      // Drive the order observation through the global `transports` list as
      // seen by Logger: a single log() call must hit transports in the same
      // order .transport() was invoked, end-to-end.
      const writeOrder: string[] = [];
      class FirstTransport extends LoggerTransport {
        static override readonly transportName = "first";
        static override deps: never[] = [];
        write(_record: LogRecord): void {
          writeOrder.push("first");
        }
      }
      class SecondTransport extends LoggerTransport {
        static override readonly transportName = "second";
        static override deps: never[] = [];
        write(_record: LogRecord): void {
          writeOrder.push("second");
        }
      }
      class ThirdTransport extends LoggerTransport {
        static override readonly transportName = "third";
        static override deps: never[] = [];
        write(_record: LogRecord): void {
          writeOrder.push("third");
        }
      }

      const adapter = makeNodeAdapter({ host: { env: "test" }, log: { level: "info" } });
      const host = newTestHost(adapter);
      // Composition surface: host.logging.transport(...) registers in order.
      host.logging.transport(FirstTransport);
      host.logging.transport(SecondTransport);
      host.logging.transport(ThirdTransport);

      const app = await host.build().test();
      try {
        writeOrder.length = 0;
        host.logger.info("ordered");

        expect(writeOrder).toEqual(["first", "second", "third"]);
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "(with host/lifecycle) Logger.onStart runs first in the singleton walk so subsequent service logs flow correctly",
    async () => {
      // A user singleton that logs from its own onStart. The log call only
      // reaches the recording transport if Logger.onStart (which starts the
      // transports + flushes the bootstrap buffer) ran first.
      class EarlyLoggingService extends FlareService {
        static override readonly deps = [Logger];
        public didLog = false;
        readonly #logger = this.inject(Logger);
        override onStart(): void {
          this.#logger.info("svc-startup-log");
          this.didLog = true;
        }
      }

      const adapter = makeNodeAdapter({ host: { env: "test" }, log: { level: "info" } });
      const host = newTestHost(adapter);
      host.logging.transport(RecordingTransportA);
      host.singleton(EarlyLoggingService);

      const app = await host.build().test();
      try {
        // The transport saw the user service's startup log, which is only
        // possible if Logger.onStart() completed before EarlyLoggingService.
        // onStart fired. (The transport's write() is a no-op until onStart
        // has installed it under the live Logger.)
        const svc = host.singletonServices.get(EarlyLoggingService) as EarlyLoggingService | undefined;
        expect(svc!.didLog).toBe(true);

        const matches = RecordingTransportA.records.filter((r) => r.message === "svc-startup-log");
        expect(matches).toHaveLength(1);
      } finally {
        await app.stop();
      }
    },
  );
});
