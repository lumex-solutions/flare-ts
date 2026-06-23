import type { JsonObject } from "@flare-ts/lib";
import { type DescriptorValue, schema } from "@flare-ts/lib";
import type { OpaqueConfigToken } from "../config/flare-config.js";
import type { LogContext } from "../logger/types.js";
import type { LoggerTransportClass } from "../logger/types.js";
import type { FlareService } from "../services/composition/flare-service.js";
import type { ServiceRegistration } from "../services/types/registration.js";
import type { FlareServiceClass, ServiceToken } from "../services/types/types.js";
import type { HostInspectSnapshot } from "../testing/types/inspect-build.js";
import type {
  ConfigValidationContext,
  HttpValidationContext,
  ServiceValidationContext,
} from "../validation/contexts.js";
import type { ValidationError } from "../validation/types.js";
import type { IFlareApp } from "./flare-app.js";
import type { HostRuntimeAdapter } from "./types/adapter.js";
import type { HostRuntimeLifecycle } from "./types/lifecycle.js";
import type { FlareApp, FlareConfig, HostRuntime, HostState } from "./types/types.js";
import { COMPILE_HTTP_ARC, HttpArc, INSPECT_HTTP_ARC, REEVALUATE_CONTAINER_STRATEGY } from "../arcs/http/http-arc.js";
import { type ConfigToken, HOST_CONFIG, LOG_CONFIG } from "../config/flare-config.js";
import { _log, Logger, toErrorField } from "../logger/logger.js";
import { loggerALS } from "../logger/types.js";
import { Container } from "../services/container.js";
import { FlareRegistrationMap } from "../services/registration-map.js";
import { FlareTestError } from "../testing/error.js";
import { FlareTestApp } from "../testing/test.js";
import { FlareValidationError } from "../validation/flare-validation-error.js";
import { createConfigValidator } from "../validation/validators/config-composite-validator.js";
import { createHttpValidator } from "../validation/validators/http-composite-validator.js";
import { createServiceValidator } from "../validation/validators/service-composite-validator.js";
import { Logging } from "./composition/logging.js";
import {
  COMPILE_FOR_TEST,
  COMPILE_INSTANCE_CONTAINER,
  COMPILE_INSTANCE_SINGLETONS,
  INSPECT_HOST,
  PROVIDE_SERVICE,
  REGISTER_BUILD_HOOK,
  RESET_FOR_TEST,
  REVALIDATE,
  SET_HOST_STATE,
  UNSAFE_CONFIG_ENV_KEYS,
} from "./types/const.js";

type AdapterLifecycle<TAdapter> = TAdapter extends HostRuntimeAdapter<IFlareApp, LoggerTransportClass, infer TLifecycle>
  ? TLifecycle
  : HostRuntimeLifecycle;

type AdapterTransportClass<TAdapter> = TAdapter extends HostRuntimeAdapter<IFlareApp, infer TTransportClass>
  ? TTransportClass
  : LoggerTransportClass;

/** Extracts the host-extension type an adapter stamps (the 4th `HostRuntimeAdapter` generic). */
type ExtensionOf<TAdapter> = TAdapter extends
  HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle, infer TExt> ? TExt
  : Record<never, never>;

/** Construct signature for {@link FlareHost}: the instance is the host plus whatever its adapter stamps. */
interface FlareHostConstructor {
  new<TAdapter extends HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle>>(
    adapter: TAdapter,
  ): FlareHostBase<TAdapter> & ExtensionOf<TAdapter>;
}

/**
 * Mutable context passed to {@link FlareHost} build hooks. Hooks are registered by a runtime adapter
 * via `[REGISTER_BUILD_HOOK]` and run once during `build()` before validation/compilation; they may
 * flip flags to alter the build. This keeps runtime-specific behavior on the adapter rather than as
 * `runtime === X` branches scattered through the host.
 */
export interface FlareBuildContext {
  /**
   * When a hook sets this, `build()` skips the dependency/HTTP/config validation suite. An adapter
   * whose app finalizes per exported terminal (registering further services first) sets it and calls
   * `[REVALIDATE]` from the terminal once the graph is complete.
   */
  deferValidation: boolean;
  /**
   * When a hook sets this, the host skips module-level singleton instantiation. An adapter whose
   * exported instances each need their own singleton graph sets it and compiles the singletons
   * itself (e.g. per exported instance) instead of once at module load.
   */
  deferSingletonCompile: boolean;
  /**
   * Service tokens registered on the host (scoped + singleton registrations, plus framework prebuilts
   * like Logger). Read-only view for adapter build hooks that validate their own dependency-declaring
   * registrations against what the host provides.
   */
  readonly registeredServiceTokens: ReadonlySet<ServiceToken<FlareService>>;
  /** Read-only view of scoped service registrations (for adapter build hooks that re-run validation). */
  readonly scopedRegistrations: ReadonlyArray<ServiceRegistration<FlareService>>;
  /** Read-only view of singleton service registrations. */
  readonly singletonRegistrations: ReadonlyArray<ServiceRegistration<FlareService>>;
  /** Framework prebuilt tokens (e.g. Logger) placed directly into singletonInstances. */
  readonly prebuiltTokens: ReadonlySet<ServiceToken<FlareService>>;
  /** Config tokens registered on the host (for adapter build hooks that re-run validation). */
  readonly configRegistrations: ReadonlySet<OpaqueConfigToken>;
  /** Built-in config tokens exempt from field-presence checks (HOST_CONFIG, LOG_CONFIG). */
  readonly defaultConfigTokens: ReadonlySet<OpaqueConfigToken>;
  /** The fully resolved config object. */
  readonly resolvedConfig: Readonly<JsonObject>;
}

/**
 * Composition root contract observed by {@link FlareAppBase} and its runtime subclasses. Concrete
 * runtimes consume a host implementation rather than depending on the {@link FlareHost} class.
 */
export interface IFlareHost {
  http: HttpArc<HostRuntimeLifecycle>;
  logging: Logging;
  state: HostState;
  /** Runtime this host's adapter targets (e.g. `"node"`, `"cloudflare"`). */
  runtime: HostRuntime;
  config: Readonly<FlareConfig>;
  logger: Logger;
  scopedServices: Pick<FlareRegistrationMap, "get" | "tokens" | "length">;
  singletonServices: ReadonlyMap<ServiceToken<FlareService>, FlareService>;
  [SET_HOST_STATE](state: HostState): void;
  /** @internal Driven by `FlareTestApp.test()` to apply replacements, validate, and compile singletons. */
  [COMPILE_FOR_TEST](opts?: { replace?: ReadonlyMap<ServiceToken<FlareService>, FlareServiceClass>; }): void;
  /** @internal Driven by `TestAppHandle.reset()`. Restores registrations and clears compiled singletons. */
  [RESET_FOR_TEST](): void;
  /** @internal Snapshot for {@link inspectBuild} in test infrastructure. */
  [INSPECT_HOST](): HostInspectSnapshot;
  /**
   * @internal Registers a framework-provided (custom-factory) service. Used by a runtime adapter's
   * app/terminal to contribute services whose instances the runtime seeds rather than building from
   * the default `new Service(container)` factory. The token participates in normal validation.
   */
  [PROVIDE_SERVICE](kind: "scoped" | "singleton", reg: ServiceRegistration<FlareService>): void;
  /**
   * @internal Re-runs the dependency/HTTP/config validation suite against the current graph.
   * Available to any runtime adapter that needs to re-validate after extending the graph
   * post-`build()`. Runtimes that run their own context-aware validation in the build hook
   * (and set `deferValidation = true`) do not call this.
   */
  [REVALIDATE](): void;
  /**
   * @internal Builds a fresh singleton map seeded with the given service factories (on top of
   * framework prebuilts like Logger), then compiles the user singletons into it. The factories run
   * against the new instance's container, so a terminal can construct services from per-instance
   * values; user singletons then resolve their deps — including the seeded services — against it.
   */
  [COMPILE_INSTANCE_SINGLETONS](
    seeded: ReadonlyMap<ServiceToken<FlareService>, (container: Container) => FlareService>,
  ): Map<ServiceToken<FlareService>, FlareService>;
  /**
   * @internal Builds a per-context Container from framework seed factories plus the user scoped
   * registry resolved lazily. Used by the CF Worker (per request) and DO (per instance).
   */
  [COMPILE_INSTANCE_CONTAINER](
    seeded: ReadonlyMap<ServiceToken<FlareService>, (container: Container) => FlareService>,
  ): Container;
  /** @internal Registers a build hook run during `build()`; used by a runtime adapter to alter the build. */
  [REGISTER_BUILD_HOOK](hook: (ctx: FlareBuildContext) => void): void;
}

class FlareHostBase<TAdapter extends HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle>>
  implements IFlareHost {
  public readonly http: HttpArc<AdapterLifecycle<TAdapter>> = new HttpArc(this);
  public readonly logging: Logging<AdapterTransportClass<TAdapter>> = new Logging();

  #defaultConfigSet: ReadonlySet<OpaqueConfigToken> = new Set([HOST_CONFIG, LOG_CONFIG]);
  #config: FlareConfig = {};
  #configRegistrations: Set<OpaqueConfigToken> = new Set();
  #scopedRegistrations: ServiceRegistration<FlareService>[] = [];
  #singletonRegistrations: ServiceRegistration<FlareService>[] = [];
  #scoped: FlareRegistrationMap = new FlareRegistrationMap();
  #singletons: Map<ServiceToken<FlareService>, FlareService> = new Map();
  #state: HostState = "starting";

  #adapter: TAdapter;
  #testMode: boolean;
  #app: IFlareApp | undefined;
  #buildHooks: Array<(ctx: FlareBuildContext) => void> = [];
  #singletonsCompiled = false;
  /** Snapshot of registrations taken before the first test-mode replacement runs; restored on reset. */
  #originalScopedRegs: ServiceRegistration<FlareService>[] | undefined;
  #originalSingletonRegs: ServiceRegistration<FlareService>[] | undefined;

  constructor(adapter: TAdapter) {
    this.#adapter = adapter;
    this.#testMode = adapter.env?.FLARE_MODE === "test";
    this.#configRegistrations.add(HOST_CONFIG);
    this.#configRegistrations.add(LOG_CONFIG);
    // Adapters stamp runtime-specific members onto the host. The host TYPE intersects the adapter's
    // extension, so a member exists only when its adapter provides it.
    const extension = adapter.extendHost?.(this);
    if (extension) {
      // An adapter must not shadow a core host member: stamping over an existing key (a method,
      // getter, or field) would silently replace framework behavior and produce confusing failures.
      // Fail loud at construction instead.
      for (const k of Object.keys(extension)) {
        if (k in this) {
          throw new Error(
            `[flare] adapter extendHost() tried to stamp "${k}", which already exists on the host. `
              + `An adapter must not shadow core host members.`,
          );
        }
      }
      Object.assign(this, extension);
    }
  }

  /**
   * Current lifecycle state of the host. Use in health-check / readiness routes
   * instead of probing framework internals.
   *
   * @example
   * ```ts
   * host.http.get("/ready", () => {
   *   return host.state === "ready"
   *     ? new FlareResponse(200, { state: host.state })
   *     : new FlareResponse(503, { state: host.state });
   * });
   * ```
   */
  public get state(): HostState {
    return this.#state;
  }

  /** Runtime this host's adapter targets. */
  public get runtime(): HostRuntime {
    return this.#adapter.runtime;
  }

  /**
   * Resolved configuration produced from {@link HostRuntimeAdapter.flareJsonFile}, environment
   * variables, and registered descriptor defaults.
   */
  public get config(): Readonly<FlareConfig> {
    return this.#config;
  }

  /**
   * Framework logger, bootstrapped during {@link build} before any user-land service is
   * instantiated.
   *
   * @throws If accessed before {@link build} has compiled the logger.
   */
  public get logger(): Logger {
    const logger = this.#singletons.get(Logger);
    if (!logger) {
      throw new Error(
        "Logger not initialized yet. Accessing the host logger before #compileLogger() has been called is not allowed.",
      );
    }
    return logger as Logger;
  }

  /** Read-only view of the per-request service registry compiled from {@link scoped} registrations. */
  public get scopedServices(): Pick<FlareRegistrationMap, "get" | "tokens" | "length"> {
    return this.#scoped;
  }

  /** Read-only view of the singleton service instances compiled from {@link singleton} registrations. */
  public get singletonServices(): ReadonlyMap<ServiceToken<FlareService>, FlareService> {
    return this.#singletons;
  }

  /** @internal Advances host state. Invoked by the runtime at lifecycle transitions. */
  [SET_HOST_STATE](state: HostState): void {
    this.#state = state;
  }

  /**
   * Registers one or more config tokens with the host.
   *
   * Every token declared in a class's `static config` array must be registered here, or
   * {@link build} will throw. Pre-defined framework tokens ({@link HOST_CONFIG},
   * {@link LOG_CONFIG}) are registered automatically.
   */
  public cfg(...tokens: ConfigToken<unknown>[]): this {
    for (const t of tokens) this.#configRegistrations.add(t);
    return this;
  }

  /**
   * Registers a per-request (scoped) service in the DI container.
   *
   * The service is instantiated fresh for each request and disposed after the request
   * completes. Use {@link singleton} for long-lived services.
   *
   * @param service - The service class to register.
   * @throws If the class is missing the required static `deps` array.
   */
  public scoped<T extends FlareService>(service: FlareServiceClass<T>): void {
    const token = service as ServiceToken<T>;
    if (service.deps != undefined) {
      this.#scopedRegistrations.push({
        factory: (container) => new service(container) as T,
        cls: service,
        token,
      });
      return;
    }
    throw new Error(`${token.name} is missing static 'deps'.`);
  }

  /**
   * Compiles config, logger, validators, and DI registrations, then returns the runtime-specific
   * app produced by {@link HostRuntimeAdapter.createApp}. Idempotent: a second call returns the
   * cached app.
   *
   * @throws {FlareValidationError} If any composite validator reports an error.
   *
   * TODO(public-app-interface): Export a minimal public app interface (run/export/test entrypoints)
   * so consumers can annotate `host.build()` without relying on inferred internal app classes.
   */
  public build(): FlareApp<TAdapter> {
    // Idempotent: the host file calls this at module load, and the test file
    // (which imports the host module) effectively triggers it again via
    // `host.build().test()`. Re-running config compile, validation, etc. would
    // be wasteful and the build is deterministic; return the cached app instead.
    if (this.#app) return this.#app as FlareApp<TAdapter>;

    // Let the runtime adapter contribute framework services and build hooks before anything
    // compiles (e.g. registering seed services and deferring singleton compile).
    // Duck-typed so the base adapter interface stays free of runtime-specific surface.
    const setup = (this.#adapter as { setup?: (host: IFlareHost) => void; }).setup;
    if (setup) setup(this);

    const configStart = Date.now();
    _log("trace", "Lifecycle event", {
      phase: "build",
      component: "host",
      event: "config:start",
    });

    this.#compileConfig();
    _log("trace", "Lifecycle event", {
      phase: "build",
      component: "host",
      event: "config:ready",
      durationMs: Date.now() - configStart,
    });

    // TODO: Make logger compilation CF safe (no FS access for config, no dynamic transports, etc. start/stop need to be sync)
    this.#compileLogger();
    this.logger.trace("Lifecycle event", {
      phase: "build",
      component: "host",
      event: "logger:ready",
    });

    const logContext: LogContext = {
      source: "flare:host",
    };

    if (this.config.log?.enableContext) {
      return loggerALS.run({ context: logContext }, () => {
        return this.#build();
      });
    } else {
      return this.#build();
    }
  }

  /**
   * @internal
   * Driven by `FlareTestApp.test()`. Applies replacement registrations, re-runs the
   * service validator suite against the post-replacement graph, and compiles
   * singletons. Throws `FlareTestError` if FLARE_MODE is not set or if called twice.
   *
   * Singleton instantiation is deferred from `host.build()` to this method so the
   * `replace` map can substitute classes before any constructor runs.
   */
  [COMPILE_FOR_TEST](
    opts?: { replace?: ReadonlyMap<ServiceToken<FlareService>, FlareServiceClass>; },
  ): void {
    if (!this.#testMode) {
      throw new FlareTestError(
        "app.test() called without FLARE_MODE=test. Set FLARE_MODE=test in your test runner env (e.g. vitest config: test.env.FLARE_MODE = 'test') before importing the host module.",
      );
    }
    if (this.#singletonsCompiled) {
      throw new FlareTestError(
        "app.test() may only be called once per host instance. Use app.reset({ replace }) to swap services between scenarios.",
      );
    }

    // Snapshot the original registrations once, before any replacement mutates them.
    // `app.reset()` restores from these so a second compile sees a pristine graph.
    this.#originalScopedRegs ??= this.#scopedRegistrations.slice();
    this.#originalSingletonRegs ??= this.#singletonRegistrations.slice();

    if (opts?.replace && opts.replace.size > 0) {
      this.#applyReplacements(opts.replace);
    }

    const errors = createServiceValidator()
      .validate(this.#buildServiceCtx())
      .filter((e) => e.severity === "error");
    if (errors.length > 0) {
      const detail = errors.map((e) => `  [${e.code}] ${e.message}${e.hint ? ` ${e.hint}` : ""}`).join("\n");
      throw new FlareTestError(`app.test() validation failed:\n${detail}`);
    }

    // Scoped registry is populated against the post-replacement registrations
    // so per-request resolution picks up the test substitutions.
    this.#compileScoped(this.#scopedRegistrations);
    this.#compileSingletons(this.#singletonRegistrations);
    this.#singletonsCompiled = true;

    // host.build() ran HttpArc[COMPILE_HTTP_ARC] before scoped registration
    // was visible (deferred to here in test mode), so the shared-container
    // optimisation was incorrectly installed when scoped services exist. Redo
    // just that decision now that scoped services are populated.
    this.http[REEVALUATE_CONTAINER_STRATEGY]();
  }

  /**
   * @internal
   * Driven by `FlareTestApp.reset()`. Restores the original registration arrays
   * snapshotted at first compile, clears the compiled singleton instances, and
   * resets the `#singletonsCompiled` flag so the caller can run a fresh
   * `[COMPILE_FOR_TEST]` with a different replacement set.
   *
   * Pre-built singletons placed before user-land compile (Logger) are preserved.
   */
  [RESET_FOR_TEST](): void {
    if (!this.#testMode) {
      throw new FlareTestError("app.reset() called without FLARE_MODE=test.");
    }
    if (!this.#singletonsCompiled) {
      throw new FlareTestError("app.reset() called before app.test(); nothing to reset.");
    }

    if (this.#originalScopedRegs) {
      this.#scopedRegistrations.length = 0;
      this.#scopedRegistrations.push(...this.#originalScopedRegs);
    }
    if (this.#originalSingletonRegs) {
      this.#singletonRegistrations.length = 0;
      this.#singletonRegistrations.push(...this.#originalSingletonRegs);
    }

    // Drop user-land compiled singletons; keep pre-built ones (e.g. Logger).
    const prebuilt = new Map<ServiceToken<FlareService>, FlareService>();
    for (const reg of this.#originalSingletonRegs ?? []) {
      // Anything in the registrations array was user-land; exclude its instance.
      prebuilt.delete(reg.token);
    }
    const userLandTokens = new Set((this.#originalSingletonRegs ?? []).map((r) => r.token));
    for (const [token, instance] of this.#singletons) {
      if (!userLandTokens.has(token)) prebuilt.set(token, instance);
    }
    this.#singletons.clear();
    for (const [token, instance] of prebuilt) this.#singletons.set(token, instance);

    this.#scoped = new FlareRegistrationMap();
    this.#singletonsCompiled = false;
  }

  /**
   * @internal Registers a framework-provided service contributed by a host extension. The token
   * goes through normal build-time dependency validation; the instance is seeded by the extension
   * (per exported instance, or per request), so the registration's factory is a guard that throws
   * if ever invoked — it never should be, because the extension pre-seeds the instance.
   */
  [PROVIDE_SERVICE](kind: "scoped" | "singleton", reg: ServiceRegistration<FlareService>): void {
    if (kind === "singleton") this.#singletonRegistrations.push(reg);
    else this.#scopedRegistrations.push(reg);
  }

  /**
   * @internal Builds a fresh singleton graph scoped to one exported instance. Starts from the
   * module-level prebuilts (Logger) plus the `seeded` services the extension supplies, then
   * compiles the user singletons into that map so they resolve their deps — including the seeded
   * services — against it. The returned map backs that one instance; module-level state is untouched.
   */
  [COMPILE_INSTANCE_SINGLETONS](
    seeded: ReadonlyMap<ServiceToken<FlareService>, (container: Container) => FlareService>,
  ): Map<ServiceToken<FlareService>, FlareService> {
    const map = new Map<ServiceToken<FlareService>, FlareService>(this.#singletons);
    const registry = new FlareRegistrationMap();
    for (const reg of this.#singletonRegistrations) registry.set(reg.token, reg);
    // One container over the instance's map: seeded factories build first (so user singletons can
    // inject them), then user singletons compile against the same container.
    const container = new Container(registry, map, this.config);
    for (const [token, factory] of seeded) map.set(token, factory(container));
    for (const reg of this.#singletonRegistrations) map.set(reg.token, container.resolveDep(reg.token));
    return map;
  }

  /**
   * @internal Builds a per-context container from framework seed factories plus the user scoped
   * registry resolved lazily. Used by the CF Worker (per request) and DO (per instance).
   */
  [COMPILE_INSTANCE_CONTAINER](
    seeded: ReadonlyMap<ServiceToken<FlareService>, (container: Container) => FlareService>,
  ): Container {
    const singletons = new Map<ServiceToken<FlareService>, FlareService>(this.#singletons); // Logger
    const container = new Container(this.#scoped, singletons, this.config);
    for (const [token, factory] of seeded) singletons.set(token, factory(container));
    return container;
  }

  /**
   * @internal Re-runs the validation suite against the current graph. A runtime adapter may call
   * this after extending the graph post-`build()` to confirm the now-complete graph is sound.
   * Runtimes that run their own context-aware validation in the build hook do not call this.
   */
  [REVALIDATE](): void {
    const warnings = this.#runValidationSuite();
    for (const w of warnings) {
      this.logger.warn(`[${w.code}]: ${w.message}${w.hint ? ` ${w.hint}` : ""}`);
    }
  }

  /**
   * @internal Registers a build hook. Host extensions call this (with `this` bound to the host) to
   * participate in `build()` through the mutable {@link FlareBuildContext}, so runtime-specific
   * build behavior lives in the extension rather than as `runtime === X` branches in the host.
   */
  [REGISTER_BUILD_HOOK](hook: (ctx: FlareBuildContext) => void): void {
    this.#buildHooks.push(hook);
  }

  /** @internal Snapshot for artifact-tier tests via {@link inspectBuild}. */
  [INSPECT_HOST](): HostInspectSnapshot {
    const allControllers = [...this.http.conRegistrations, ...this.http.groups.flatMap((g) => g.controllers)];
    const allMiddleware = [...this.http.mwRegistrations, ...this.http.groups.flatMap((g) => g.middleware)];

    return {
      state: this.#state,
      config: this.#config,
      runtime: this.#adapter.runtime,
      lifecycle: this.#adapter.lifecycle,
      registrations: {
        scoped: this.#scopedRegistrations.length,
        singleton: this.#singletonRegistrations.length,
        controllers: allControllers.length,
        middleware: allMiddleware.length,
      },
      singletonKeys: [...this.#singletons.keys()].map((t) => String(t)),
      testMode: {
        enabled: this.#testMode,
        singletonsCompiled: this.#singletonsCompiled,
      },
      httpCompiled: this.http[INSPECT_HTTP_ARC]().compiled,
    };
  }

  #buildServiceCtx(): ServiceValidationContext {
    const allControllers = [...this.http.conRegistrations, ...this.http.groups.flatMap((g) => g.controllers)];
    const allMiddleware = [...this.http.mwRegistrations, ...this.http.groups.flatMap((g) => g.middleware)];
    return {
      scoped: this.#scopedRegistrations,
      singletons: this.#singletonRegistrations,
      controllers: allControllers,
      middleware: allMiddleware,
      prebuiltTokens: new Set(this.#singletons.keys()),
    };
  }

  #build(): FlareApp<TAdapter> {
    // Run adapter build hooks first — they may defer validation and/or singleton compilation so a
    // terminal can finalize the graph per exported instance. Runtime-specific build behavior lives
    // on the adapter rather than as a `runtime === X` branch here.
    const buildCtx: FlareBuildContext = {
      deferValidation: false,
      deferSingletonCompile: false,
      registeredServiceTokens: new Set<ServiceToken<FlareService>>([
        ...this.#scopedRegistrations.map((r) => r.token),
        ...this.#singletonRegistrations.map((r) => r.token),
        ...this.#singletons.keys(),
      ]),
      scopedRegistrations: this.#scopedRegistrations,
      singletonRegistrations: this.#singletonRegistrations,
      prebuiltTokens: new Set(this.#singletons.keys()),
      configRegistrations: this.#configRegistrations,
      defaultConfigTokens: this.#defaultConfigSet,
      resolvedConfig: this.#config,
    };
    for (const hook of this.#buildHooks) hook(buildCtx);

    const warnings = buildCtx.deferValidation ? [] : this.#runValidationSuite();

    try {
      const compileStart = Date.now();
      this.logger.trace("Lifecycle event", {
        phase: "build",
        component: "host",
        event: "compile:start",
      });
      // In test mode, defer scoped + singleton compilation until app.test({ replace })
      // has had a chance to substitute registrations (replace works on BOTH scoped
      // and singleton services). The full validator suite re-runs at that point
      // against the post-replacement graph.
      if (!this.#testMode) {
        this.#compileScoped(this.#scopedRegistrations);
        // A build hook may defer singleton instantiation (an adapter compiles them elsewhere,
        // e.g. per exported instance). The scoped registry and the rest of the blueprint are still
        // compiled once here.
        if (!buildCtx.deferSingletonCompile) {
          this.#compileSingletons(this.#singletonRegistrations);
          this.#singletonsCompiled = true;
        }
      }
      this.http[COMPILE_HTTP_ARC]();
      this.logger.trace("Lifecycle event", {
        phase: "build",
        component: "host",
        event: "compile:ready",
        durationMs: Date.now() - compileStart,
      });
    } catch (err) {
      this.logger.fatal(err, "Host build failed during compilation.");
      throw err;
    }

    // Emit warnings after compilation so they flow through the configured transports.
    for (const w of warnings) {
      this.logger.warn(`[${w.code}]: ${w.message}${w.hint ? ` ${w.hint}` : ""}`);
    }

    const app = this.#testMode
      ? new FlareTestApp(this, this.#adapter as ConstructorParameters<typeof FlareTestApp>[1])
      : this.#adapter.createApp(this);
    this.#app = app;
    return app as FlareApp<TAdapter>;
  }

  /**
   * Builds the validation contexts from the current graph, runs the service/HTTP/config suite,
   * throws {@link FlareValidationError} on any error, and returns the warnings (the caller emits
   * them). Re-runnable: a runtime adapter may call `[REVALIDATE]` to re-run this suite after the
   * graph is further extended post-build. An adapter that runs its own context-aware suite (setting
   * `deferValidation = true`) does not use this.
   */
  #runValidationSuite(): ValidationError[] {
    const allControllers = [...this.http.conRegistrations, ...this.http.groups.flatMap((g) => g.controllers)];
    const allMiddleware = [...this.http.mwRegistrations, ...this.http.groups.flatMap((g) => g.middleware)];

    const serviceCtx: ServiceValidationContext = this.#buildServiceCtx();

    const httpCtx: HttpValidationContext = {
      controllers: allControllers,
      globalMiddleware: this.http.mwRegistrations,
      groups: this.http.groups,
      corsConfig: this.http.corsConfig,
    };

    const configCtx: ConfigValidationContext = {
      registeredTokens: this.#configRegistrations,
      defaultTokens: this.#defaultConfigSet,
      resolvedConfig: this.#config,
      classConfigDeclarations: [
        // TODO: narrow these `as any` casts. `r.cls` should be typed to expose the optional
        // `static config?: readonly ConfigToken<unknown>[]` declared on FlareBase.
        ...this.#scopedRegistrations.map((r) => (r.cls as any).config),
        ...this.#singletonRegistrations.map((r) => (r.cls as any).config),
        ...allControllers.map((r) => (r.cls as any).config),
        ...allMiddleware.map((r) => (r.cls as any).config),
      ],
    };

    const validationStart = Date.now();
    this.logger.trace("Lifecycle event", {
      phase: "build",
      component: "host",
      event: "validation:start",
    });

    const allResults = [
      ...createServiceValidator().validate(serviceCtx),
      ...createHttpValidator().validate(httpCtx),
      ...createConfigValidator().validate(configCtx),
    ];

    const warnings = allResults.filter((e) => e.severity === "warning");
    const errors = allResults.filter((e) => e.severity === "error");
    this.logger.trace("Lifecycle event", {
      phase: "build",
      component: "host",
      event: "validation:ready",
      durationMs: Date.now() - validationStart,
      warnings: warnings.length,
      errors: errors.length,
    });

    if (errors.length > 0) {
      this.logger.error(
        `Host build failed with ${errors.length} validation error(s) and ${warnings.length} warning(s).`,
      );
      throw new FlareValidationError(errors);
    }
    return warnings;
  }

  #compileConfig(): void {
    let config: JsonObject = {};

    try {
      config = this.#adapter.flareJsonFile ?? {};
    } catch (err) {
      if ((err as { code?: string; }).code === "ENOENT") {
        _log("info", "No flare.json found at project root; proceeding with defaults and environment variables.");
      } else {
        _log("fatal", "Host build failed during config file loading.", { error: toErrorField(err) });
        throw err;
      }
    }

    const envVars = this.#adapter.env ?? {};

    // Build lowercase -> canonical-key maps from registered token descriptors so
    // env-var overrides resolve to the correct camelCase names even when no
    // flare.json is present and the config sections are empty.
    const sectionKeyMap = new Map<string, string>();
    const sectionFieldMaps = new Map<string, Map<string, string>>();
    for (const t of this.#configRegistrations) {
      sectionKeyMap.set(t.key.toLowerCase(), t.key);
      if (!t.descriptor) continue;
      const fieldMap = new Map<string, string>();
      for (const fieldKey of Object.keys(t.descriptor)) {
        fieldMap.set(fieldKey.toLowerCase(), fieldKey);
      }
      sectionFieldMaps.set(t.key.toLowerCase(), fieldMap);
    }

    for (const [k, v] of Object.entries(envVars)) {
      if (!k.startsWith("FLARE__") || v === undefined) continue;
      const parts = k.slice("FLARE__".length).toLowerCase().split("__");
      if (parts.length < 2) continue;
      if (parts.some((part) => UNSAFE_CONFIG_ENV_KEYS.has(part))) continue;

      const sectionLower = parts[0]!;
      const sectionKey = sectionKeyMap.get(sectionLower) ?? sectionLower;
      const fieldMap = sectionFieldMaps.get(sectionLower);

      if (typeof config[sectionKey] !== "object" || config[sectionKey] === null) config[sectionKey] = {};
      let node = config[sectionKey] as JsonObject;

      for (let i = 1; i < parts.length - 1; i++) {
        const part = fieldMap?.get(parts[i]!) ?? parts[i]!;
        if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
        node = node[part] as JsonObject;
      }

      const lowerLast = parts[parts.length - 1]!;
      node[fieldMap?.get(lowerLast) ?? lowerLast] = v;
    }

    const descriptors: Record<string, DescriptorValue<unknown>> = {};
    for (const t of this.#configRegistrations) {
      // Ensure every registered section exists in the raw config so field-level
      // defaultTo/optional logic runs even when the section is absent from flare.json.
      if (!(t!.key in config)) config[t!.key] = {};
      descriptors[t!.key] = schema({ ...t!.descriptor });
    }

    const cfgSchema = schema(descriptors);

    try {
      // Apply env-based defaults before parsing
      const host = config["host"] as JsonObject | undefined;
      const log = config["log"] as JsonObject | undefined;
      if (host && host["env"] === "development") {
        if (log && log["level"] === undefined) log["level"] = "debug";
        if (log && log["format"] === undefined) log["format"] = "pretty";
      }

      const parsed = cfgSchema.safeParse(config);
      if (!parsed.success) {
        throw new Error(`Config validation failed: ${JSON.stringify(parsed.error, null, 2)}`);
      }
      this.#config = parsed.data;
    } catch (err) {
      _log("fatal", "Host build failed during config parsing.", { error: toErrorField(err) });
      throw err;
    }
  }

  #compileLogger(): Logger {
    const loggerTransportClasses = [...this.#adapter.defaultLoggerTransports, ...this.logging.loggerTransports];

    // Bootstrap container: config populated, service registry empty.
    // Transports may call this.config() and that works. Calling this.inject() would
    // throw at build time, which is an intentional constraint: transports are logging
    // destinations and must not depend on user services.
    const bootContainer = new Container(new FlareRegistrationMap(), new Map(), this.config);

    const transports = loggerTransportClasses.map((Transport) => new Transport(bootContainer));
    const loggerInstance = this.#adapter.createLogger(transports, bootContainer);

    // Pre-create: place directly into singletonInstances so DI (resolveDep)
    // finds it in the singletons map without going through a lazy factory.
    this.#singletons.set(Logger, loggerInstance);
    return loggerInstance;
  }

  #compileScoped(serviceRegistrations: ServiceRegistration<FlareService>[]): void {
    for (let i = 0; i < serviceRegistrations.length; i++) {
      const service = serviceRegistrations[i]!;
      this.#scoped.set(service.token, service);
    }
  }

  #compileSingletons(singletonRegistrations: ServiceRegistration<FlareService>[]): void {
    if (singletonRegistrations.length === 0) return;
    // Build a temporary registry containing only singleton factories and resolve each one.
    const singletonRegistry = new FlareRegistrationMap();
    for (const reg of singletonRegistrations) {
      singletonRegistry.set(reg.token, reg);
    }
    const singletonContainer = new Container(singletonRegistry, this.#singletons, this.config);
    for (const reg of singletonRegistrations) {
      const instance = singletonContainer.resolveDep(reg.token);
      this.#singletons.set(reg.token, instance);
    }
  }

  /**
   * Substitutes singleton service classes per `host.test({ replace })`.
   *
   * Mutates `singletonRegistrations` in place. Only validates what the existing
   * validator suite cannot catch on its own:
   *   1. The token is actually a registered singleton.
   *   2. The replacement constructor extends the same token base.
   *
   * Dependency satisfiability, cycle detection, captive-dep, lifecycle-hook
   * checks are delegated to `createServiceValidator()` re-running against the
   * post-replacement context inside `host.test()`.
   */
  #applyReplacements(replace: ReadonlyMap<ServiceToken<FlareService>, FlareServiceClass>): void {
    // Two pass: validate every replacement first, then mutate. Keeps the
    // registrations arrays atomic: a failed replacement can be fixed and
    // retried without leaving the host in a half-mutated state. Replacements
    // can target either singleton or scoped registrations; whichever array
    // contains the token is the one mutated.
    type Planned = {
      arr: ServiceRegistration<FlareService>[];
      idx: number;
      token: ServiceToken<FlareService>;
      replacement: FlareServiceClass;
    };
    const planned: Planned[] = [];

    for (const [token, replacement] of replace) {
      const sIdx = this.#singletonRegistrations.findIndex((r) => r.token === token);
      const cIdx = sIdx === -1 ? this.#scopedRegistrations.findIndex((r) => r.token === token) : -1;
      const arr = sIdx !== -1 ? this.#singletonRegistrations : (cIdx !== -1 ? this.#scopedRegistrations : null);
      const idx = sIdx !== -1 ? sIdx : cIdx;

      if (!arr || idx === -1) {
        throw new FlareTestError(
          `${token.name} is not a registered service. Replace targets must be registered via host.singleton() or host.scoped()`,
        );
      }

      // ServiceToken is a structural brand, not the abstract constructor itself; widen here
      // so `instanceof` sees the prototype chain. Legitimate escape hatch.
      if (!(replacement.prototype instanceof (token as unknown as (abstract new(...args: never[]) => FlareService)))) {
        throw new FlareTestError(
          `${replacement.name} does not extend ${token.name}`,
        );
      }

      planned.push({ arr, idx, token, replacement });
    }

    for (const { arr, idx, token, replacement } of planned) {
      arr[idx] = {
        // FlareServiceClass models an abstract constructor; widen to concrete-new here so
        // the factory can instantiate the replacement. Legitimate escape hatch.
        factory: (container) => new (replacement as unknown as new(c: typeof container) => FlareService)(container),
        cls: replacement,
        token,
      };
    }
  }
}

/**
 * Composition root of a Flare application. `new FlareHost(adapter)` returns the host plus any members
 * the adapter stamps via `extendHost`.
 */
export const FlareHost = FlareHostBase as unknown as FlareHostConstructor; // stamped members are added at runtime by the constructor

/** The host instance type for a given adapter: the base host plus the adapter's stamped extension. */
export type FlareHost<
  TAdapter extends HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle> = HostRuntimeAdapter<
    IFlareApp,
    LoggerTransportClass,
    HostRuntimeLifecycle
  >,
> = FlareHostBase<TAdapter> & ExtensionOf<TAdapter>;
