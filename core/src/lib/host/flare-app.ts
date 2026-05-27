import type { HttpArc } from "../arcs/http/http-arc.js";
import type { FlareService } from "../services/composition/flare-service.js";
import type { FlareServiceClass, ServiceToken } from "../services/types/types.js";
import type { TestAppHandle } from "../testing/test.js";
import type { IFlareHost } from "./flare-host.js";
import { START_HTTP_ARC, START_HTTP_ARC_ASYNC, STOP_HTTP_ARC, STOP_HTTP_ARC_ASYNC } from "../arcs/http/http-arc.js";
import { _log, Logger } from "../logger/logger.js";

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
   * Orchestrates startup: invokes registered arc onStart callbacks, then calls
   * onStart() on all singleton service instances.
   */
  public start(): void {
    const arcStart = Date.now();
    _log("trace", "Lifecycle event", {
      phase: "startup",
      component: "arc",
      event: "start",
      name: "http",
    });
    this.http[START_HTTP_ARC]();
    _log("trace", "Lifecycle event", {
      phase: "startup",
      component: "arc",
      event: "ready",
      name: "http",
      durationMs: Date.now() - arcStart,
    });

    for (const instance of this.host.singletonServices.values()) {
      if (instance instanceof Logger) {
        this.#assertSync(instance.onStart?.(), "Logger.onStart()");
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
      this.#assertSync(instance.onStart?.(), `${name}.onStart()`);
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

  /**
   * @internal
   * Orchestrates async startup for runtimes that support asynchronous module lifecycle.
   */
  public async startAsync(): Promise<void> {
    const arcStart = Date.now();
    _log("trace", "Lifecycle event", {
      phase: "startup",
      component: "arc",
      event: "start",
      name: "http",
    });
    await this.http[START_HTTP_ARC_ASYNC]();
    _log("trace", "Lifecycle event", {
      phase: "startup",
      component: "arc",
      event: "ready",
      name: "http",
      durationMs: Date.now() - arcStart,
    });

    for (const instance of this.host.singletonServices.values()) {
      if (instance instanceof Logger) {
        await instance.onStart?.();
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
      await instance.onStart?.();
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

  /**
   * @internal
   * Orchestrates shutdown: calls onStop() on all singleton service instances,
   * then invokes registered arc onStop callbacks.
   */
  public stop(): void {
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
        this.#assertSync(instance.onStop?.(), `${name}.onStop()`);
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
    this.http[STOP_HTTP_ARC]();
    this.host.logger.trace("Lifecycle event", {
      phase: "shutdown",
      component: "arc",
      event: "ready",
      name: "http",
      durationMs: Date.now() - arcStart,
    });

    if (this.#loggerStarted) {
      const logger = instances.find((inst) => inst instanceof Logger) as Logger | undefined;
      try {
        this.#assertSync(logger?.onStop?.(), "Logger.onStop()");
      } catch (err) {
        errors.push(err);
        console.error("[flare] Error during logger shutdown:", JSON.stringify(err));
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more errors occurred during shutdown");
    }
  }

  /**
   * @internal
   * Orchestrates async shutdown for runtimes that support asynchronous module lifecycle.
   */
  public async stopAsync(): Promise<void> {
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
        await instance.onStop?.();
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
    await this.http[STOP_HTTP_ARC_ASYNC]();
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
        await logger?.onStop?.();
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

  #assertSync(result: Promise<void> | void, label: string): void {
    if (result instanceof Promise) {
      throw new Error(`[flare] ${label} returned a Promise during sync runtime lifecycle.`);
    }
  }

  // TODO: implement diagnostics / introspection APIs to list registered services, controllers, state, middleware, etc.
}
