/**
 * Unit tests for {@link FlareAppBase} lifecycle: service start/stop ordering, HTTP arc hooks,
 * and logger gating across sync and async runtimes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { HttpArc } from "../../../../src/lib/arcs/http/http-arc.js";
import type { IFlareHost } from "../../../../src/lib/host/flare-host.js";
import type { FlareService } from "../../../../src/lib/services/composition/flare-service.js";
import type { ServiceToken } from "../../../../src/lib/services/types/types.js";
import {
  START_HTTP_ARC,
  START_HTTP_ARC_ASYNC,
  STOP_HTTP_ARC,
  STOP_HTTP_ARC_ASYNC,
} from "../../../../src/lib/arcs/http/http-arc.js";
import { FlareAppBase } from "../../../../src/lib/host/flare-app.js";
import { Logger } from "../../../../src/lib/logger/logger.js";
import { Container } from "../../../../src/lib/services/container.js";

interface ArcCalls {
  startSync: number;
  startAsync: number;
  stopSync: number;
  stopAsync: number;
}

interface StubArc {
  arc: HttpArc;
  calls: ArcCalls;
  /** Set to throw from any of the arc lifecycle methods. */
  // `| undefined` is required under exactOptionalPropertyTypes so makeArc()
  // can spread back an undefined arcStopThrows from a missing option.
  arcStopThrows?: Error | undefined;
}

/** Concrete subclass of the abstract FlareAppBase so we can instantiate it. */
class TestApp extends FlareAppBase {}

/** Logger subclass that suppresses configure() and lets tests record onStart/onStop. */
class StubLogger extends Logger {
  public startCalls = 0;
  public stopCalls = 0;
  /** When set, returned from onStart()/onStop(). Useful for forcing Promise rejects. */
  public startResult: void | Promise<void> = undefined;
  public stopResult: void | Promise<void> = undefined;
  public stopThrows: Error | undefined;

  constructor() {
    super([], new Container());
  }

  override onStart(): Promise<void> | void {
    this.startCalls += 1;
    return this.startResult;
  }
  override onStop(): Promise<void> | void {
    this.stopCalls += 1;
    if (this.stopThrows) throw this.stopThrows;
    return this.stopResult;
  }

  // Suppress every emit so the host's `_log` / `logger.trace` calls do not
  // touch the real configure() path (which needs a populated LOG_CONFIG).
  // Each override accepts the base signature so TraceSpyLogger (below) can
  // override trace() with the real (message, meta?) shape.
  override trace(_message: string, _meta?: Record<string, unknown>): void {}
  override debug(_message: string, _meta?: Record<string, unknown>): void {}
  override info(_message: string, _meta?: Record<string, unknown>): void {}
  override warn(_message: string, _meta?: Record<string, unknown>): void {}
  // The two overloaded signatures aren't important here: we only care that
  // the no-op replacements don't throw on any argument shape.
  override error(): void {}
  override fatal(): void {}
}

/** Logger subclass that records trace() calls for lifecycle assertions. */
class TraceSpyLogger extends StubLogger {
  public traces: Array<{ message: string; meta: Record<string, unknown>; }> = [];

  override trace(message: string, meta?: Record<string, unknown>): void {
    this.traces.push({ message, meta: meta ?? {} });
  }
}

function makeArc(opts: { arcStopThrows?: Error; } = {}): StubArc {
  const calls: ArcCalls = { startSync: 0, startAsync: 0, stopSync: 0, stopAsync: 0 };
  const arc = {
    [START_HTTP_ARC]() {
      calls.startSync += 1;
    },
    async [START_HTTP_ARC_ASYNC]() {
      calls.startAsync += 1;
    },
    [STOP_HTTP_ARC]() {
      calls.stopSync += 1;
      if (opts.arcStopThrows) throw opts.arcStopThrows;
    },
    async [STOP_HTTP_ARC_ASYNC]() {
      calls.stopAsync += 1;
      if (opts.arcStopThrows) throw opts.arcStopThrows;
    },
  } as unknown as HttpArc;
  return { arc, calls, arcStopThrows: opts.arcStopThrows };
}

function makeHost(
  singletons: Map<ServiceToken<FlareService>, FlareService>,
  logger: Logger,
  arc: HttpArc,
): IFlareHost {
  return {
    http: arc,
    logger,
    singletonServices: singletons,
  } as unknown as IFlareHost;
}

/** Builds a TestApp bound to the supplied collaborators. */
function build(
  services: Array<{ token: ServiceToken<FlareService>; instance: FlareService; }>,
  logger: Logger = new StubLogger(),
  opts: { arcStopThrows?: Error; } = {},
): { app: TestApp; arcCalls: ArcCalls; logger: Logger; singletons: Map<ServiceToken<FlareService>, FlareService>; } {
  const singletons = new Map<ServiceToken<FlareService>, FlareService>();
  for (const { token, instance } of services) singletons.set(token, instance);
  const arc = makeArc(opts);
  const host = makeHost(singletons, logger, arc.arc);
  return { app: new TestApp(host), arcCalls: arc.calls, logger, singletons };
}

/** Minimal service stub that is not instanceof Logger for ordering assertions. */
class FakeService {
  static order: string[] = [];
  static reset(): void {
    FakeService.order = [];
  }

  constructor(public name: string) {}

  onStart?: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
}

beforeEach(() => {
  FakeService.reset();
});

describe("test-mode compile entry point on non-test apps", () => {
  it("throws a clear error mentioning FLARE_MODE=test when invoked on a non-test app instance", () => {
    const { app } = build([]);
    expect(() => app.test()).toThrow(
      "[flare] app.test() called on a non-test app. Set FLARE_MODE=test in your test runner env before importing the host module (e.g. vitest: test.env.FLARE_MODE = 'test').",
    );
  });

  it("ignores its argument: passing an opts object behaves the same as omitting it", () => {
    const { app } = build([]);
    // Both invocations throw the same message; the `_opts` parameter is unused.
    expect(() => app.test()).toThrow("[flare] app.test() called on a non-test app.");
    expect(() => app.test({ replace: new Map() })).toThrow("[flare] app.test() called on a non-test app.");
  });
});

describe("synchronous application startup", () => {
  it("invokes http[START_HTTP_ARC] then walks singletonServices calling each onStart in insertion order", () => {
    class SvcA {
      onStart(): void {
        FakeService.order.push("A:start");
      }
    }
    class SvcB {
      onStart(): void {
        FakeService.order.push("B:start");
      }
    }
    const a = new SvcA();
    const b = new SvcB();
    const { app, arcCalls } = build([
      { token: SvcA as unknown as ServiceToken<FlareService>, instance: a as unknown as FlareService },
      { token: SvcB as unknown as ServiceToken<FlareService>, instance: b as unknown as FlareService },
    ]);

    app.start();

    expect(arcCalls.startSync).toBe(1);
    // Arc start fires before any service onStart (no service entries before this point).
    expect(FakeService.order).toEqual(["A:start", "B:start"]);
  });

  it("starts the Logger singleton first so a subsequent stop invokes Logger.onStop", () => {
    // We cannot observe #loggerStarted directly, but we can observe its effect:
    // a subsequent stop() will invoke Logger.onStop() only when #loggerStarted is true.
    const logger = new StubLogger();
    class Svc {
      onStart(): void {}
      onStop(): void {}
    }
    const svc = new Svc();
    const { app } = build(
      [
        { token: Logger, instance: logger },
        { token: Svc as unknown as ServiceToken<FlareService>, instance: svc as unknown as FlareService },
      ],
      logger,
    );

    app.start();
    expect(logger.startCalls).toBe(1);

    app.stop();
    expect(logger.stopCalls).toBe(1);
  });

  it("a service with no onStart defined is skipped without error", () => {
    class SvcNoStart {}
    const inst = new SvcNoStart();
    const { app } = build([
      { token: SvcNoStart as unknown as ServiceToken<FlareService>, instance: inst as unknown as FlareService },
    ]);
    expect(() => app.start()).not.toThrow();
  });

  it("a service onStart returning a Promise during sync runtime lifecycle throws '[flare] <name>.onStart() returned a Promise during sync runtime lifecycle.'", () => {
    class BadSvc {
      onStart(): Promise<void> {
        return Promise.resolve();
      }
    }
    const inst = new BadSvc();
    const { app } = build([
      { token: BadSvc as unknown as ServiceToken<FlareService>, instance: inst as unknown as FlareService },
    ]);
    expect(() => app.start()).toThrow(
      "[flare] BadSvc.onStart() returned a Promise during sync runtime lifecycle.",
    );
  });

  it("stop walks singletons in reverse of the start order", () => {
    // Indirect observation: stop() walks i = singletonIdx-1 down to 0, so the
    // services we registered are all visited on stop. We assert via FakeService.order.
    class A {
      onStart(): void {
        FakeService.order.push("A:start");
      }
      onStop(): void {
        FakeService.order.push("A:stop");
      }
    }
    class B {
      onStart(): void {
        FakeService.order.push("B:start");
      }
      onStop(): void {
        FakeService.order.push("B:stop");
      }
    }
    class C {
      onStart(): void {
        FakeService.order.push("C:start");
      }
      onStop(): void {
        FakeService.order.push("C:stop");
      }
    }
    const { app } = build([
      { token: A as unknown as ServiceToken<FlareService>, instance: new A() as unknown as FlareService },
      { token: B as unknown as ServiceToken<FlareService>, instance: new B() as unknown as FlareService },
      { token: C as unknown as ServiceToken<FlareService>, instance: new C() as unknown as FlareService },
    ]);
    app.start();
    app.stop();
    expect(FakeService.order).toEqual([
      "A:start",
      "B:start",
      "C:start",
      "C:stop",
      "B:stop",
      "A:stop",
    ]);
  });
});

describe("asynchronous application startup", () => {
  it("awaits http[START_HTTP_ARC_ASYNC] then awaits each singleton onStart in insertion order", async () => {
    class SvcA {
      async onStart(): Promise<void> {
        FakeService.order.push("A:start");
      }
    }
    class SvcB {
      async onStart(): Promise<void> {
        FakeService.order.push("B:start");
      }
    }
    const { app, arcCalls } = build([
      { token: SvcA as unknown as ServiceToken<FlareService>, instance: new SvcA() as unknown as FlareService },
      { token: SvcB as unknown as ServiceToken<FlareService>, instance: new SvcB() as unknown as FlareService },
    ]);

    await app.startAsync();

    expect(arcCalls.startAsync).toBe(1);
    expect(FakeService.order).toEqual(["A:start", "B:start"]);
  });

  it("starts Logger first and emits start/ready trace events for other services", async () => {
    const logger = new TraceSpyLogger();
    class Svc {
      async onStart(): Promise<void> {}
      async onStop(): Promise<void> {}
    }
    const svc = new Svc();
    const { app } = build(
      [
        { token: Logger, instance: logger },
        { token: Svc as unknown as ServiceToken<FlareService>, instance: svc as unknown as FlareService },
      ],
      logger,
    );

    await app.startAsync();
    expect(logger.startCalls).toBe(1);

    const serviceTraces = logger.traces.filter((t) => t.meta["component"] === "service");
    expect(serviceTraces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Lifecycle event",
          meta: expect.objectContaining({
            phase: "startup",
            component: "service",
            event: "start",
            name: "Svc",
          }),
        }),
        expect.objectContaining({
          message: "Lifecycle event",
          meta: expect.objectContaining({
            phase: "startup",
            component: "service",
            event: "ready",
            name: "Svc",
          }),
        }),
      ]),
    );

    await app.stopAsync();
    expect(logger.stopCalls).toBe(1);
  });

  it("awaits each async onStart sequentially: next service starts only after the previous resolves", async () => {
    const resolveOrder: string[] = [];
    let resolveA!: () => void;
    const aPromise = new Promise<void>((r) => {
      resolveA = r;
    });

    class A {
      async onStart(): Promise<void> {
        FakeService.order.push("A:enter");
        await aPromise;
        FakeService.order.push("A:exit");
        resolveOrder.push("A");
      }
    }
    class B {
      async onStart(): Promise<void> {
        FakeService.order.push("B:enter");
        resolveOrder.push("B");
      }
    }
    const { app } = build([
      { token: A as unknown as ServiceToken<FlareService>, instance: new A() as unknown as FlareService },
      { token: B as unknown as ServiceToken<FlareService>, instance: new B() as unknown as FlareService },
    ]);

    const started = app.startAsync();
    // At this point A is awaiting; B must not have started.
    // Microtask flush ensures any synchronous body of A has executed.
    await Promise.resolve();
    expect(FakeService.order).toEqual(["A:enter"]);

    resolveA();
    await started;

    expect(resolveOrder).toEqual(["A", "B"]);
    expect(FakeService.order).toEqual(["A:enter", "A:exit", "B:enter"]);
  });

  it("a rejected onStart propagates and aborts subsequent service starts", async () => {
    class Bad {
      async onStart(): Promise<void> {
        throw new Error("boom");
      }
    }
    class Next {
      async onStart(): Promise<void> {
        FakeService.order.push("next:start");
      }
    }
    const { app } = build([
      { token: Bad as unknown as ServiceToken<FlareService>, instance: new Bad() as unknown as FlareService },
      { token: Next as unknown as ServiceToken<FlareService>, instance: new Next() as unknown as FlareService },
    ]);

    await expect(app.startAsync()).rejects.toThrow("boom");
    expect(FakeService.order).toEqual([]);
  });
});

describe("synchronous application shutdown", () => {
  it("stops services in reverse order, stops the HTTP arc, then stops Logger last after start initialized it", () => {
    const logger = new StubLogger();
    class A {
      onStart(): void {}
      onStop(): void {
        FakeService.order.push("A:stop");
      }
    }
    class B {
      onStart(): void {}
      onStop(): void {
        FakeService.order.push("B:stop");
      }
    }
    const { app, arcCalls } = build(
      [
        { token: Logger, instance: logger },
        { token: A as unknown as ServiceToken<FlareService>, instance: new A() as unknown as FlareService },
        { token: B as unknown as ServiceToken<FlareService>, instance: new B() as unknown as FlareService },
      ],
      logger,
    );

    app.start();
    FakeService.order = []; // ignore start ordering noise
    app.stop();

    // Services walk in reverse, Logger skipped during the loop:
    expect(FakeService.order).toEqual(["B:stop", "A:stop"]);
    expect(arcCalls.stopSync).toBe(1);
    // Logger.onStop happens after the arc stop because #loggerStarted is true.
    expect(logger.stopCalls).toBe(1);
  });

  it("services with no onStop are skipped (no error)", () => {
    class NoStop {
      onStart(): void {}
    }
    const { app } = build([
      { token: NoStop as unknown as ServiceToken<FlareService>, instance: new NoStop() as unknown as FlareService },
    ]);
    app.start();
    expect(() => app.stop()).not.toThrow();
  });

  it("an error in a service onStop is captured into the AggregateError; subsequent services still attempted", () => {
    class A {
      onStart(): void {}
      onStop(): void {
        FakeService.order.push("A:stop");
      }
    }
    class B {
      onStart(): void {}
      onStop(): void {
        throw new Error("B failed");
      }
    }
    const { app } = build([
      { token: A as unknown as ServiceToken<FlareService>, instance: new A() as unknown as FlareService },
      { token: B as unknown as ServiceToken<FlareService>, instance: new B() as unknown as FlareService },
    ]);
    app.start();
    FakeService.order = [];

    try {
      app.stop();
      throw new Error("expected stop() to throw AggregateError");
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).message).toBe("One or more errors occurred during shutdown");
      expect((err as AggregateError).errors[0]).toBeInstanceOf(Error);
      expect(((err as AggregateError).errors[0] as Error).message).toBe("B failed");
    }
    // A.onStop must still have been attempted after B threw (B is later in
    // insertion order; reverse walk visits B first then A).
    expect(FakeService.order).toEqual(["A:stop"]);
  });

  it("an error in Logger.onStop falls back to console.error and still appends to the errors list", () => {
    const logger = new StubLogger();
    logger.stopThrows = new Error("logger died");

    const originalErr = console.error;
    const errCalls: unknown[][] = [];
    console.error = (...args: unknown[]): void => {
      errCalls.push(args);
    };

    try {
      const { app } = build([{ token: Logger, instance: logger }], logger);
      app.start();
      expect(() => app.stop()).toThrow(AggregateError);
      // console.error was used as the last-resort emitter.
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
      expect(errCalls[0]?.[0]).toBe("[flare] Error during logger shutdown:");
    } finally {
      console.error = originalErr;
    }
  });

  it("aggregates errors and throws AggregateError('One or more errors occurred during shutdown')", () => {
    class A {
      onStart(): void {}
      onStop(): void {
        throw new Error("A bad");
      }
    }
    class B {
      onStart(): void {}
      onStop(): void {
        throw new Error("B bad");
      }
    }
    const { app } = build([
      { token: A as unknown as ServiceToken<FlareService>, instance: new A() as unknown as FlareService },
      { token: B as unknown as ServiceToken<FlareService>, instance: new B() as unknown as FlareService },
    ]);
    app.start();
    try {
      app.stop();
      throw new Error("expected AggregateError");
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).message).toBe("One or more errors occurred during shutdown");
      expect((err as AggregateError).errors).toHaveLength(2);
    }
  });

  it("a service onStop returning a Promise during sync shutdown is collected as an AggregateError", () => {
    class BadSvc {
      onStart(): void {}
      onStop(): Promise<void> {
        return Promise.resolve();
      }
    }
    const { app } = build([
      { token: BadSvc as unknown as ServiceToken<FlareService>, instance: new BadSvc() as unknown as FlareService },
    ]);
    app.start();

    try {
      app.stop();
      throw new Error("expected AggregateError");
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const inner = (err as AggregateError).errors[0] as Error;
      expect(inner.message).toBe(
        "[flare] BadSvc.onStop() returned a Promise during sync runtime lifecycle.",
      );
    }
  });

  it("does not call Logger.onStop when stop runs before start ever initialized the logger", () => {
    // Build a state where Logger is registered but app.start() was never called,
    // so #singletonIdx is 0 and #loggerStarted stayed false.
    const logger = new StubLogger();
    const { app } = build([{ token: Logger, instance: logger }], logger);

    // stop() before start(): no singletons walked (idx-1 == -1), arc stop fires,
    // and Logger.onStop is gated on #loggerStarted (false).
    app.stop();
    expect(logger.stopCalls).toBe(0);
  });
});

describe("asynchronous application shutdown", () => {
  it("stops services in reverse order, awaits arc shutdown, then awaits Logger.onStop only after start initialized it", async () => {
    const logger = new StubLogger();
    class A {
      async onStart(): Promise<void> {}
      async onStop(): Promise<void> {
        FakeService.order.push("A:stop");
      }
    }
    class B {
      async onStart(): Promise<void> {}
      async onStop(): Promise<void> {
        FakeService.order.push("B:stop");
      }
    }
    const { app, arcCalls } = build(
      [
        { token: Logger, instance: logger },
        { token: A as unknown as ServiceToken<FlareService>, instance: new A() as unknown as FlareService },
        { token: B as unknown as ServiceToken<FlareService>, instance: new B() as unknown as FlareService },
      ],
      logger,
    );

    await app.startAsync();
    FakeService.order = [];
    await app.stopAsync();

    expect(FakeService.order).toEqual(["B:stop", "A:stop"]);
    expect(arcCalls.stopAsync).toBe(1);
    expect(logger.stopCalls).toBe(1);
  });

  it("a rejected service onStop is captured into the errors list; subsequent services still stopped", async () => {
    class A {
      async onStart(): Promise<void> {}
      async onStop(): Promise<void> {
        FakeService.order.push("A:stop");
      }
    }
    class B {
      async onStart(): Promise<void> {}
      async onStop(): Promise<void> {
        throw new Error("B failed");
      }
    }
    const { app } = build([
      { token: A as unknown as ServiceToken<FlareService>, instance: new A() as unknown as FlareService },
      { token: B as unknown as ServiceToken<FlareService>, instance: new B() as unknown as FlareService },
    ]);
    await app.startAsync();
    FakeService.order = [];

    try {
      await app.stopAsync();
      throw new Error("expected AggregateError");
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const errs = (err as AggregateError).errors;
      expect(errs).toHaveLength(1);
      expect((errs[0] as Error).message).toBe("B failed");
    }
    expect(FakeService.order).toEqual(["A:stop"]);
  });

  it("throws errors aggregated as AggregateError after all teardown attempts complete", async () => {
    class A {
      async onStart(): Promise<void> {}
      async onStop(): Promise<void> {
        throw new Error("A bad");
      }
    }
    class B {
      async onStart(): Promise<void> {}
      async onStop(): Promise<void> {
        throw new Error("B bad");
      }
    }
    const { app } = build([
      { token: A as unknown as ServiceToken<FlareService>, instance: new A() as unknown as FlareService },
      { token: B as unknown as ServiceToken<FlareService>, instance: new B() as unknown as FlareService },
    ]);
    await app.startAsync();

    await expect(app.stopAsync()).rejects.toThrow(AggregateError);
    await expect(app.stopAsync()).rejects.toThrow("One or more errors occurred during shutdown");
  });

  it("Logger.onStop rejection falls back to console.error and still records the error in the AggregateError", async () => {
    const logger = new StubLogger();
    logger.stopThrows = new Error("logger died");

    const originalErr = console.error;
    const errCalls: unknown[][] = [];
    console.error = (...args: unknown[]): void => {
      errCalls.push(args);
    };

    try {
      const { app } = build([{ token: Logger, instance: logger }], logger);
      await app.startAsync();

      await expect(app.stopAsync()).rejects.toThrow(AggregateError);
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
      expect(errCalls[0]?.[0]).toBe("[flare] Error during logger shutdown:");
    } finally {
      console.error = originalErr;
    }
  });
});

describe("sync lifecycle guard against Promise-returning hooks", () => {
  it("void result returns silently: sync onStart returning void completes start() without error", () => {
    class Ok {
      onStart(): void {}
    }
    const { app } = build([
      { token: Ok as unknown as ServiceToken<FlareService>, instance: new Ok() as unknown as FlareService },
    ]);
    expect(() => app.start()).not.toThrow();
  });

  it("Promise result throws '[flare] <label> returned a Promise during sync runtime lifecycle.'", () => {
    // Asserts the exact label substitution for the Logger.onStart() call path.
    const logger = new StubLogger();
    logger.startResult = Promise.resolve();
    const { app } = build([{ token: Logger, instance: logger }], logger);
    expect(() => app.start()).toThrow(
      "[flare] Logger.onStart() returned a Promise during sync runtime lifecycle.",
    );
  });
});
