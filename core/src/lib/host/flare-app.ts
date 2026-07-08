import type { HttpArc } from "../arcs/http/http-arc.js";
import type { FlareService } from "../services/composition/flare-service.js";
import type { FlareServiceClass, ServiceToken } from "../services/types/types.js";
import type { TestAppHandle } from "../testing/test.js";
import type { IFlareHost } from "./flare-host.js";
import { START_HTTP_ARC, START_HTTP_ARC_ASYNC, STOP_HTTP_ARC, STOP_HTTP_ARC_ASYNC } from "../arcs/http/http-arc.js";
import { _log } from "../logger/bootstrap.js";
import { Logger } from "../logger/logger.js";

/**
 * One step of a lifecycle program: a callback to run plus the label used in the sync interpreter's
 * "returned a Promise during sync runtime lifecycle" diagnostic. See `FlareAppBase#startupProgram`.
 */
interface LifecycleStep {
  readonly invoke: () => void | Promise<void>;
  readonly label: string;
}

export interface IFlareApp {
  /** @internal Starts framework-managed app resources. */
  start(): void;
  /** @internal Starts framework-managed app resources with async lifecycle support. */
  startAsync(): Promise<void>;
  /** @internal Stops framework-managed app resources. */
  stop(): void;
  /** @internal Stops framework-managed app resources with async lifecycle support. */
  stopAsync(): Promise<void>;
}

/** Options accepted by `app.test()`. Mirrors the `replace` map from the spec. */
export interface AppTestOptions {
  replace?: ReadonlyMap<ServiceToken<FlareService>, FlareServiceClass>;
}

/**
 * Compiled application produced by {@link IFlareHost.build}. Runtime-specific subclasses
 * ({@link FlareAppNode}, {@link FlareAppCF}) extend this with the entrypoint method appropriate
 * to their host.
 */
export abstract class FlareAppBase implements IFlareApp {
  constructor(protected readonly host: IFlareHost) {
    this.http = host.http;
  }

  protected readonly http: HttpArc;
  // TODO: add `workers` and `flows` arc fields when those arcs ship.

  /**
   * Starts the application in test mode and returns a {@link TestAppHandle}
   * for driving synthetic requests. Mirrors how `run()` (Node) returns a
   * `NodeRunHandle` and `export()` (CF) returns a `{ fetch }` handle.
   *
   * The base implementation throws when `FLARE_MODE=test` was not set, so `host.build()`
   * returned a production app rather than the test variant. Set `FLARE_MODE=test`
   * before importing the host module (vitest: `test.env.FLARE_MODE = 'test'`).
   * `FlareTestApp` overrides with the real implementation.
   */
  public test(_opts?: AppTestOptions): Promise<TestAppHandle> {
    throw new Error(
      "[flare] app.test() called on a non-test app. Set FLARE_MODE=test in your test runner env before importing the host module (e.g. vitest: test.env.FLARE_MODE = 'test').",
    );
  }

  #singletonIdx = 0;
  #loggerStarted = false;

  /**
   * @internal
   * Orchestrates startup: invokes the HTTP arc's sync onStart callbacks, then calls onStart() on
   * all singleton service instances. Drives {@link #startupProgram} with the sync interpreter.
   */
  public start(): void {
    this.#runSync(this.#startupProgram(() => this.http[START_HTTP_ARC]()));
  }

  /**
   * @internal
   * Orchestrates async startup for runtimes that support asynchronous module lifecycle. Drives the
   * same {@link #startupProgram} with the async interpreter, awaiting each step in turn (no
   * parallel onStart execution).
   */
  public startAsync(): Promise<void> {
    return this.#runAsync(this.#startupProgram(() => this.http[START_HTTP_ARC_ASYNC]()));
  }

  /**
   * @internal
   * Orchestrates shutdown: calls onStop() on all singleton service instances in reverse, then the
   * HTTP arc, then the Logger last. Drives {@link #shutdownProgram} with the sync interpreter.
   */
  public stop(): void {
    this.#runSync(this.#shutdownProgram(() => this.http[STOP_HTTP_ARC]()));
  }

  /**
   * @internal
   * Orchestrates async shutdown for runtimes that support asynchronous module lifecycle. Drives the
   * same {@link #shutdownProgram} with the async interpreter.
   */
  public stopAsync(): Promise<void> {
    return this.#runAsync(this.#shutdownProgram(() => this.http[STOP_HTTP_ARC_ASYNC]()));
  }

  /**
   * A lifecycle program is the ordering, logging, and error policy of one phase expressed once,
   * independent of whether the runtime is sync or async. It `yield`s a {@link LifecycleStep} at each
   * point a user/arc callback must run; an interpreter ({@link #runSync} / {@link #runAsync})
   * executes the step's `invoke` and resumes the generator, or throws back into it via
   * `generator.throw()` so the program's own try/catch handles the failure. This keeps the reverse
   * walk, Logger deferral, `#singletonIdx` window, and error aggregation in a single place rather
   * than duplicated across four methods.
   */
  *#startupProgram(startArc: () => void | Promise<void>): Generator<LifecycleStep, void, void> {
    const arcStart = Date.now();
    _log("trace", "Lifecycle event", {
      phase: "startup",
      component: "arc",
      event: "start",
      name: "http",
    });
    yield { invoke: startArc, label: "http arc start" };
    _log("trace", "Lifecycle event", {
      phase: "startup",
      component: "arc",
      event: "ready",
      name: "http",
      durationMs: Date.now() - arcStart,
    });

    for (const instance of this.host.singletonServices.values()) {
      if (instance instanceof Logger) {
        yield { invoke: () => instance.onStart?.(), label: "Logger.onStart()" };
        this.#loggerStarted = true;
        this.#singletonIdx++;
        continue;
      }

      const name = instance.constructor.name;
      const serviceStart = Date.now();
      this.host.logger.trace("Lifecycle event", {
        phase: "startup",
        component: "service",
        event: "start",
        name,
      });
      yield { invoke: () => instance.onStart?.(), label: `${name}.onStart()` };
      this.host.logger.trace("Lifecycle event", {
        phase: "startup",
        component: "service",
        event: "ready",
        name,
        durationMs: Date.now() - serviceStart,
      });
      this.#singletonIdx++;
    }
  }

  /** See {@link #startupProgram}. Reverse-walks started singletons, then the arc, then the Logger. */
  *#shutdownProgram(stopArc: () => void | Promise<void>): Generator<LifecycleStep, void, void> {
    const instances = [...this.host.singletonServices.values()];
    const errors: unknown[] = [];
    for (let i = this.#singletonIdx - 1; i >= 0; i--) {
      // If instance is the logger, skip it to avoid shutting down the logging system prematurely
      if (instances[i] instanceof Logger) continue;

      const instance = instances[i];
      if (!instance) continue;
      const name = instance.constructor.name;

      try {
        const serviceStart = Date.now();
        this.host.logger.trace("Lifecycle event", {
          phase: "shutdown",
          component: "service",
          event: "start",
          name,
        });
        yield { invoke: () => instance.onStop?.(), label: `${name}.onStop()` };
        this.host.logger.trace("Lifecycle event", {
          phase: "shutdown",
          component: "service",
          event: "ready",
          name,
          durationMs: Date.now() - serviceStart,
        });
      } catch (err) {
        errors.push(err);
        this.host.logger.error(err, "Error during service shutdown", {
          phase: "shutdown",
          component: "service",
          event: "error",
          name,
        });
      }
    }

    const arcStart = Date.now();
    this.host.logger.trace("Lifecycle event", {
      phase: "shutdown",
      component: "arc",
      event: "start",
      name: "http",
    });
    // Not wrapped in try/catch: an arc-stop failure propagates raw (bypassing the AggregateError),
    // matching the original direct call.
    yield { invoke: stopArc, label: "http arc stop" };
    this.host.logger.trace("Lifecycle event", {
      phase: "shutdown",
      component: "arc",
      event: "ready",
      name: "http",
      durationMs: Date.now() - arcStart,
    });

    // Only call Logger.onStop() if Logger.onStart() completed successfully.
    // Running onStop on a half-initialized logger can dereference transports
    // that never wired up their own onStart.
    if (this.#loggerStarted) {
      const logger = instances.find((inst) => inst instanceof Logger) as Logger | undefined;
      try {
        yield { invoke: () => logger?.onStop?.(), label: "Logger.onStop()" };
      } catch (err) {
        errors.push(err);
        // Logger shutdown failed. Log to console as a last resort.
        console.error("[flare] Error during logger shutdown:", JSON.stringify(err));
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more errors occurred during shutdown");
    }
  }

  /**
   * Sync interpreter for a lifecycle program. Executes each step synchronously and rejects a step
   * that returns a Promise (a sync runtime cannot await it); the failure is thrown back into the
   * program so its own try/catch decides whether to aggregate or propagate.
   */
  #runSync(program: Generator<LifecycleStep, void, void>): void {
    let result = program.next();
    while (!result.done) {
      const step = result.value;
      let failure: unknown;
      let failed = false;
      try {
        const invoked = step.invoke();
        if (invoked instanceof Promise) {
          throw new Error(`[flare] ${step.label} returned a Promise during sync runtime lifecycle.`);
        }
      } catch (err) {
        failure = err;
        failed = true;
      }
      // A step the program does not guard rethrows out of `program.throw` and propagates here.
      result = failed ? program.throw(failure) : program.next();
    }
  }

  /** Async interpreter for a lifecycle program. Awaits each step in turn (no parallel execution). */
  async #runAsync(program: Generator<LifecycleStep, void, void>): Promise<void> {
    let result = program.next();
    while (!result.done) {
      const step = result.value;
      let failure: unknown;
      let failed = false;
      try {
        await step.invoke();
      } catch (err) {
        failure = err;
        failed = true;
      }
      result = failed ? program.throw(failure) : program.next();
    }
  }

  // TODO: implement diagnostics / introspection APIs to list registered services, controllers, state, middleware, etc.
}
