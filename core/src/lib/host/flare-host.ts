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
import type { IFlareApp } from "./flare-app.js";
import type { HostRuntimeAdapter } from "./types/adapter.js";
import type { HostRuntimeLifecycle } from "./types/lifecycle.js";
import type { FlareApp, FlareConfig, HostState } from "./types/types.js";
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
import { type FlareRequestExtension, requestExtensionsFor } from "./composition/extensions.js";
import { Logging } from "./composition/logging.js";
import {
  COMPILE_FOR_TEST,
  INSPECT_HOST,
  REQUEST_EXTENSIONS,
  RESET_FOR_TEST,
  SET_HOST_STATE,
  UNSAFE_CONFIG_ENV_KEYS,
} from "./types/const.js";

type AdapterTransportClass<TAdapter> = TAdapter extends HostRuntimeAdapter<IFlareApp, infer TTransportClass>
  ? TTransportClass
  : LoggerTransportClass;

type AdapterLifecycle<TAdapter> = TAdapter extends HostRuntimeAdapter<IFlareApp, LoggerTransportClass, infer TLifecycle>
  ? TLifecycle
  : HostRuntimeLifecycle;

/**
 * Composition root contract observed by {@link FlareAppBase} and its runtime subclasses. Concrete
 * runtimes consume a host implementation rather than depending on the {@link FlareHost} class.
 */
export interface IFlareHost {
  http: HttpArc<HostRuntimeLifecycle>;
  logging: Logging;
  state: HostState;
  config: Readonly<FlareConfig>;
  logger: Logger;
  scopedServices: Pick<FlareRegistrationMap, "get" | "tokens" | "length">;
  singletonServices: ReadonlyMap<ServiceToken<FlareService>, FlareService>;
  /** @internal Request extensions resolved for this host's runtime; consumed by the app's runner. */
  [REQUEST_EXTENSIONS]: readonly FlareRequestExtension[];
  [SET_HOST_STATE](state: HostState): void;
  /** @internal Driven by `FlareTestApp.test()` to apply replacements, validate, and compile singletons. */
  [COMPILE_FOR_TEST](opts?: { replace?: ReadonlyMap<ServiceToken<FlareService>, FlareServiceClass>; }): void;
  /** @internal Driven by `TestAppHandle.reset()`. Restores registrations and clears compiled singletons. */
  [RESET_FOR_TEST](): void;
  /** @internal Snapshot for {@link inspectBuild} in test infrastructure. */
  [INSPECT_HOST](): HostInspectSnapshot;
}

/**
 * Composition root of a Flare application. Registers config tokens, scoped and singleton services,
 * HTTP routes via {@link FlareHost.http}, and logger transports via {@link FlareHost.logging}, then
 * produces a runtime-specific app instance from {@link build}.
 */
export class FlareHost<TAdapter extends HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle>>
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
  #singletonsCompiled = false;
  /** Snapshot of registrations taken before the first test-mode replacement runs; restored on reset. */
  #originalScopedRegs: ServiceRegistration<FlareService>[] | undefined;
  #originalSingletonRegs: ServiceRegistration<FlareService>[] | undefined;

  constructor(adapter: TAdapter) {
    this.#adapter = adapter;
    this.#testMode = adapter.env?.FLARE_MODE === "test";
    this.#configRegistrations.add(HOST_CONFIG);
    this.#configRegistrations.add(LOG_CONFIG);
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

  /**
   * Request extensions resolved for this host's runtime from the module-level registry. Extension
   * packages register at import time via {@link registerRequestExtension}; the app's per-request
   * runner consumes this list. Resolved fresh from the registry — no host-side registration.
   */
  get [REQUEST_EXTENSIONS](): readonly FlareRequestExtension[] {
    return requestExtensionsFor(this.#adapter.runtime);
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
   * Registers a singleton service in the DI container.
   *
   * The service is instantiated once at {@link build} time and reused for the lifetime
   * of the application. Its {@link FlareService.onStart} is called during app startup and
   * {@link FlareService.onStop} is called during graceful shutdown.
   *
   * **Not available on edge runtimes (Cloudflare Workers).** Edge runtimes do not have a
   * long-lived process; only `host.scoped()` is supported there.
   *
   * @param service - The service class to register.
   * @throws If the class is missing the required static `deps` array.
   */
  public singleton<T extends FlareService>(
    service: TAdapter extends { runtime: "cloudflare"; } ? never : FlareServiceClass<T>,
  ): void {
    if (this.#adapter.runtime === "cloudflare") {
      throw new Error(
        "[flare] host.singleton() is not supported on Cloudflare Workers; "
          + "edge runtimes have no long-lived process — use host.scoped() instead.",
      );
    }
    const token = service as ServiceToken<T>;
    if (service.deps != undefined) {
      this.#singletonRegistrations.push({
        factory: (container) => new service(container) as T,
        cls: service,
        token: service as ServiceToken<T>,
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
      requestExtensions: this[REQUEST_EXTENSIONS].map((e) => e.name),
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

    // Throw on errors before compiling
    if (errors.length > 0) {
      this.logger.error(
        `Host build failed with ${errors.length} validation error(s) and ${warnings.length} warning(s).`,
      );
      throw new FlareValidationError(errors);
    }

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
        this.#compileSingletons(this.#singletonRegistrations);
        this.#singletonsCompiled = true;
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
    this.#app = app as IFlareApp;
    return app as FlareApp<TAdapter>;
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
