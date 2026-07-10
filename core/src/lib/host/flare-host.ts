/**
 * The composition root: FlareHost wires adapters, services, config, arcs, and
 * extensions, and compiles them into a runtime app on build().
 */
import type { JsonObject } from "@flare-ts/lib";
import { type DescriptorValue, schema } from "@flare-ts/lib";
import type { OpaqueConfigToken } from "../config/flare-config.js";
import type { LogContext } from "../logger/types.js";
import type { LoggerTransportClass } from "../logger/types.js";
import type { FlareService } from "../services/composition/flare-service.js";
import type { ServiceRegistration } from "../services/types/registration.js";
import type { ServiceClass } from "../services/types/service-class.js";
import type { ServiceToken } from "../services/types/token.js";
import type { HostInspectSnapshot } from "../testing/types/inspect-build.js";
import type { ConfigValidationContext } from "../validation/config/composite.js";
import type { HttpValidationContext } from "../validation/http/composite.js";
import type { ServiceValidationContext } from "../validation/service/composite.js";
import type { ValidationError } from "../validation/types.js";
import type { WsValidationContext } from "../validation/ws/composite.js";
import type { ExtensionMembers, HostExtension, HostExtensionContext } from "./extensions/extension.js";
import type { IFlareApp } from "./flare-app-base.js";
import type { HostRuntimeAdapter } from "./types/adapter.js";
import type { FlareApp } from "./types/app.js";
import type { FlareConfig } from "./types/config.js";
import type { HostRuntimeLifecycle } from "./types/lifecycle.js";
import type { HostRuntime } from "./types/runtime.js";
import type { HostState } from "./types/state.js";
import { COMPILE_HTTP_ARC, HttpArc, INSPECT_HTTP_ARC, REEVALUATE_CONTAINER_STRATEGY } from "../arcs/http/http-arc.js";
import { CookieSigner } from "../arcs/http/transport/cookie-signer.js";
import { COMPILE_WS_ARC, WS_REGISTRATIONS, WebSocketArc } from "../arcs/ws/ws-arc.js";
import {
  type ConfigToken,
  COOKIES_CONFIG,
  HOST_CONFIG,
  LOG_CONFIG,
  WEBSOCKETS_CONFIG,
} from "../config/flare-config.js";
import { _log } from "../logger/bootstrap.js";
import { loggerALS } from "../logger/context.js";
import { toErrorField } from "../logger/fields.js";
import { Logger } from "../logger/logger.js";
import { Container } from "../services/container.js";
import { FlareRegistrationMap } from "../services/registration-map.js";
import { FlareTestApp } from "../testing/flare-test-app.js";
import { FlareTestError } from "../testing/flare-test-error.js";
import { createConfigValidator } from "../validation/config/composite.js";
import { FlareValidationError } from "../validation/flare-validation-error.js";
import { createHttpValidator } from "../validation/http/composite.js";
import { createServiceValidator } from "../validation/service/composite.js";
import { createWsValidator } from "../validation/ws/composite.js";
import { WsConfigValidator } from "../validation/ws/config-validator.js";
import { Logging } from "./logging.js";
import {
  COMPILE_FOR_TEST,
  COMPILE_INSTANCE_CONTAINER,
  INSPECT_HOST,
  PROVIDE_SERVICE,
  REGISTER_BUILD_HOOK,
  RESET_FOR_TEST,
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

/**
 * Construct signature for {@link FlareHost}: the instance is the host plus whatever its adapter stamps,
 * plus the members installed by the host extensions passed as the second argument. The extensions array
 * is a `const` type parameter, so `host.<name>` is derived directly from the passed descriptors; a host
 * that did not opt into an extension does not have its member.
 *
 * This is the type behind the exported `FlareHost` VALUE. The members themselves live on the
 * (unexported) implementation class; hover a constructed instance for their docs, or annotate
 * with the {@link FlareHost} type alias, which carries the same adapter and extension typing.
 */
interface FlareHostConstructor {
  new<
    TAdapter extends HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle>,
    const E extends readonly HostExtension[] = readonly [],
  >(
    adapter: TAdapter,
    extensions?: E,
  ): FlareHostBase<TAdapter> & ExtensionOf<TAdapter> & ExtensionMembers<E>;
}

/**
 * Mutable context passed to {@link FlareHost} build hooks. Hooks are registered by a runtime adapter
 * via `[REGISTER_BUILD_HOOK]` and run once during `build()` before validation/compilation; they expose
 * read-only views of the graph and let the adapter own validation or defer singleton compilation. This
 * keeps runtime-specific behavior on the adapter rather than as `runtime === X` branches in the host.
 */
export interface FlareBuildContext {
  /**
   * Registers the adapter's validator, replacing the host's generic dependency/HTTP/config suite (which
   * has no concept of an adapter's execution contexts). The host runs it after all build hooks, then
   * owns the outcome: it throws {@link FlareValidationError} on any `error` result and emits `warning`
   * results. The validator returns all results rather than throwing itself, so there is one error path.
   */
  ownValidation(validate: () => ValidationError[]): void;
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
 * The read-only view of the host's scoped-service registrations exposed by
 * {@link FlareHost.scopedServices}: lookup, token iteration, and count, never mutation.
 */
export type ScopedServicesView = Pick<FlareRegistrationMap, "get" | "tokens" | "length">;

/**
 * Composition root contract observed by {@link FlareAppBase} and its runtime subclasses. Concrete
 * runtimes consume a host implementation rather than depending on the {@link FlareHost} class.
 */
export interface IFlareHost<TLifecycle extends HostRuntimeLifecycle = HostRuntimeLifecycle> {
  http: HttpArc<TLifecycle>;
  /** WebSocket authoring surface: `host.ws.route(path, opts?)` and `host.ws.controller(path, Class)`. */
  ws: WebSocketArc;
  logging: Logging;
  state: HostState;
  /** Runtime this host's adapter targets (e.g. `"node"`, `"cloudflare"`). */
  runtime: HostRuntime;
  config: Readonly<FlareConfig>;
  logger: Logger;
  /** @internal Cookie signer derived from `cookies.secret`, or `undefined` when no secret is configured. */
  cookieSigner: CookieSigner | undefined;
  scopedServices: ScopedServicesView;
  singletonServices: ReadonlyMap<ServiceToken<FlareService>, FlareService>;
  [SET_HOST_STATE](state: HostState): void;
  /**
   * @internal Registers a framework-provided (custom-factory) service. Used by a runtime adapter's
   * app/terminal to contribute services whose instances the runtime seeds rather than building from
   * the default `new Service(container)` factory. The token participates in normal validation.
   */
  [PROVIDE_SERVICE](kind: "scoped" | "singleton", reg: ServiceRegistration<FlareService>): void;
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

/**
 * Test-only host capabilities, kept off {@link IFlareHost} so a runtime adapter never sees them. The
 * concrete host implements both; only the test infrastructure (`FlareTestApp`, `inspectBuild`) consumes
 * this.
 */
export interface IFlareTestHost {
  /** @internal Driven by `FlareTestApp.test()` to apply replacements, validate, and compile singletons. */
  [COMPILE_FOR_TEST](opts?: { replace?: ReadonlyMap<ServiceToken<FlareService>, ServiceClass>; }): void;
  /** @internal Driven by `TestAppHandle.reset()`. Restores registrations and clears compiled singletons. */
  [RESET_FOR_TEST](): void;
  /** @internal Snapshot for {@link inspectBuild} in test infrastructure. */
  [INSPECT_HOST](): HostInspectSnapshot;
}

class FlareHostBase<TAdapter extends HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle>>
  implements IFlareHost<AdapterLifecycle<TAdapter>>, IFlareTestHost {
  public readonly http: HttpArc<AdapterLifecycle<TAdapter>> = new HttpArc(this);
  public readonly ws: WebSocketArc = new WebSocketArc(this);
  public readonly logging: Logging<AdapterTransportClass<TAdapter>> = new Logging();

  #defaultConfigSet: ReadonlySet<OpaqueConfigToken> = new Set([
    HOST_CONFIG,
    LOG_CONFIG,
    COOKIES_CONFIG,
    WEBSOCKETS_CONFIG,
  ]);
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
  /** Set when a build hook calls `ctx.ownValidation`; the host runs it instead of its generic suite. */
  #adapterValidator: (() => ValidationError[]) | undefined;
  #singletonsCompiled = false;
  /** Cookie signer derived from `cookies.secret`; `null` until first computed, `undefined` when unset. */
  #cookieSigner: CookieSigner | null | undefined = null;
  /** Snapshot of registrations taken before the first test-mode replacement runs; restored on reset. */
  #originalScopedRegs: ServiceRegistration<FlareService>[] | undefined;
  #originalSingletonRegs: ServiceRegistration<FlareService>[] | undefined;

  constructor(adapter: TAdapter, extensions: readonly HostExtension[] = []) {
    this.#adapter = adapter;
    this.#testMode = adapter.env.FLARE_MODE === "test";
    this.#configRegistrations.add(HOST_CONFIG);
    this.#configRegistrations.add(LOG_CONFIG);
    this.#configRegistrations.add(COOKIES_CONFIG);
    this.#configRegistrations.add(WEBSOCKETS_CONFIG);
    // Adapters stamp runtime-specific members onto the host. The host TYPE intersects the adapter's
    // extension, so a member exists only when its adapter provides it.
    const extension = adapter.extendHost?.(this);
    if (extension) this.#stampMembers(extension, "adapter extendHost()");

    // Install the first-class host extensions this host opted into (passed to the constructor). Each
    // installer runs once HERE (after the adapter so it cannot shadow an adapter-stamped member),
    // composes via the narrow HostExtensionContext, and returns the member map the host stamps. Members
    // collide loudly through the same no-shadow guard, including across two extensions.
    const extCtx = this.#extensionContext();
    for (const ext of extensions) {
      this.#stampMembers(ext.install(extCtx), "host extension");
    }
  }

  /**
   * Copies stamped members onto the host, rejecting any key that already exists. Stamping over an
   * existing member (a method, getter, or field) would silently replace framework behavior and
   * produce confusing failures, so this fails loud at construction. Shared by adapter `extendHost` and
   * first-class host extensions.
   */
  #stampMembers(members: Record<string, unknown>, source: string): void {
    for (const k of Object.keys(members)) {
      if (k in this) {
        throw new Error(
          `[flare] ${source} tried to stamp "${k}", which already exists on the host. `
            + `Stamped members must not shadow existing host members.`,
        );
      }
    }
    Object.assign(this, members);
  }

  /**
   * Builds the narrow capability surface handed to a host extension's installer: exactly the
   * author-level composition methods (`scoped`, `cfg`, `http`). It exposes no privileged runtime
   * control (lifecycle state, per-context instancing, validation ownership) or test surface, so an
   * extension physically cannot reach host internals.
   */
  #extensionContext(): HostExtensionContext {
    return {
      scoped: (service) => {
        this.scoped(service);
      },
      cfg: (...tokens) => {
        this.cfg(...tokens);
      },
      http: this.http,
    };
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
   * @internal Cookie signer built from the resolved `cookies.secret`, or `undefined` when no secret is
   * configured. Computed once on first access (after config is resolved during {@link build}) and reused
   * across requests so the HMAC key is imported at most once. Read by the HTTP arc to back
   * `ctx.cookies.setSigned` / `getSigned`.
   */
  public get cookieSigner(): CookieSigner | undefined {
    if (this.#cookieSigner === null) {
      const secret = this.#config.cookies?.secret;
      this.#cookieSigner = secret
        ? new CookieSigner(secret, this.#config.cookies?.previousSecrets)
        : undefined;
    }
    return this.#cookieSigner;
  }

  /**
   * Framework logger, bootstrapped during {@link build} before any user-land service is
   * instantiated.
   *
   * @throws {Error} If accessed before {@link build} has compiled the logger.
   */
  public get logger(): Logger {
    const logger = this.#singletons.get(Logger);
    if (!logger) {
      throw new Error(
        "Logger not initialized yet. Accessing the host logger before #compileLogger() has been called is not allowed.",
      );
    }
    // #compileLogger seeded this exact key with the Logger singleton; the widened map
    // value type cannot carry that invariant. The map stays the single storage: test
    // reset/restore re-seeds it, so a parallel typed field would desync.
    return logger as Logger;
  }

  /** Read-only view of the per-request service registry compiled from {@link scoped} registrations. */
  public get scopedServices(): ScopedServicesView {
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
   * Rejects composition calls (`scoped`/`singleton`/`cfg`) made after `build()` has compiled the graph.
   * A late registration would otherwise land in the already-compiled registry and silently never take
   * effect. `build()` is the close of composition.
   */
  #assertOpen(op: string): void {
    if (this.#app) {
      throw new Error(`[flare] ${op} cannot be called after build(); composition is closed once the host is built.`);
    }
  }

  /**
   * Registers one or more config tokens with the host.
   *
   * Every token declared in a class's `static config` array must be registered here, or
   * {@link build} will throw. Pre-defined framework tokens ({@link HOST_CONFIG},
   * {@link LOG_CONFIG}) are registered automatically.
   */
  public cfg(...tokens: ConfigToken<unknown>[]): this {
    this.#assertOpen("host.cfg()");
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
   * @throws {Error} If the class is missing the required static `deps` array.
   */
  public scoped<T extends FlareService>(service: ServiceClass<T>): void {
    this.#assertOpen("host.scoped()");
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
    const setup = this.#adapter.setup;
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
    opts?: { replace?: ReadonlyMap<ServiceToken<FlareService>, ServiceClass>; },
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
    this.#assertOpen("host.singleton()");
    if (kind === "singleton") this.#singletonRegistrations.push(reg);
    else this.#scopedRegistrations.push(reg);
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
   * @internal Registers a build hook. Host extensions call this (with `this` bound to the host) to
   * participate in `build()` through the mutable {@link FlareBuildContext}, so runtime-specific
   * build behavior lives in the extension rather than as `runtime === X` branches in the host.
   */
  [REGISTER_BUILD_HOOK](hook: (ctx: FlareBuildContext) => void): void {
    this.#buildHooks.push(hook);
  }

  /** @internal Snapshot for tests via {@link inspectBuild}. */
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
      ownValidation: (validate) => {
        this.#adapterValidator = validate;
      },
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

    // Validation runs after all hooks (so installed mount routes are visible). The host owns the
    // outcome for both its own suite and an adapter-registered validator: throw on errors, emit
    // warnings (after compile, below).
    const results = this.#adapterValidator ? this.#adapterValidator() : this.#collectHostValidation();
    const validationErrors = results.filter((r) => r.severity === "error");
    const warnings = results.filter((r) => r.severity === "warning");
    if (validationErrors.length > 0) {
      this.logger.error(
        `Host build failed with ${validationErrors.length} validation error(s) and ${warnings.length} warning(s).`,
      );
      throw new FlareValidationError(validationErrors);
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
        // A build hook may defer singleton instantiation (an adapter compiles them elsewhere,
        // e.g. per exported instance). The scoped registry and the rest of the blueprint are still
        // compiled once here.
        if (!buildCtx.deferSingletonCompile) {
          this.#compileSingletons(this.#singletonRegistrations);
          this.#singletonsCompiled = true;
        }
      }
      this.http[COMPILE_HTTP_ARC]();
      this.ws[COMPILE_WS_ARC]();
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
      ? new FlareTestApp(this, this.#adapter)
      : this.#adapter.createApp(this);
    this.#app = app;
    return app as FlareApp<TAdapter>;
  }

  /**
   * Builds the validation contexts from the current graph and runs the generic service/HTTP/config
   * suite, returning all results (errors and warnings). The caller in {@link build} owns throwing on
   * errors and emitting warnings. An adapter that registers its own validator via `ownValidation` does
   * not use this.
   */
  #collectHostValidation(): ValidationError[] {
    const allControllers = [...this.http.conRegistrations, ...this.http.groups.flatMap((g) => g.controllers)];
    const allMiddleware = [...this.http.mwRegistrations, ...this.http.groups.flatMap((g) => g.middleware)];

    const serviceCtx: ServiceValidationContext = this.#buildServiceCtx();

    const httpCtx: HttpValidationContext = {
      controllers: allControllers,
      globalMiddleware: this.http.mwRegistrations,
      groups: this.http.groups,
      corsConfig: this.http.corsConfig,
      cookieSecretConfigured: Boolean(this.#config.cookies?.secret),
    };

    const configCtx: ConfigValidationContext = {
      registeredTokens: this.#configRegistrations,
      defaultTokens: this.#defaultConfigSet,
      resolvedConfig: this.#config,
      classConfigDeclarations: [
        // The structural class types declare the optional static config array directly.
        // `static config?: readonly ConfigToken<unknown>[]` declared on FlareBase.
        ...this.#scopedRegistrations.map((r) => r.cls.config),
        ...this.#singletonRegistrations.map((r) => r.cls.config),
        ...allControllers.map((r) => r.cls.config),
        ...allMiddleware.map((r) => r.cls.config),
      ],
    };

    const validationStart = Date.now();
    this.logger.trace("Lifecycle event", {
      phase: "build",
      component: "host",
      event: "validation:start",
    });

    const wsRegistrations = this.ws[WS_REGISTRATIONS]();
    const wsCtx: WsValidationContext = {
      wsPatterns: wsRegistrations.map((r) => r.pattern),
      httpControllers: allControllers,
      config: this.#config.websockets,
    };

    const allResults = [
      ...createServiceValidator().validate(serviceCtx),
      ...createHttpValidator().validate(httpCtx),
      ...createConfigValidator().validate(configCtx),
      // The route-level WS validators (syntax/conflict) return [] on empty patterns anyway, so when no
      // routes are registered we skip them and run only the config-section validator: a configured-but-
      // unrouted `websockets` section still deserves its caps/timers errors.
      ...(wsRegistrations.length > 0
        ? createWsValidator().validate(wsCtx)
        : new WsConfigValidator().validate(wsCtx)),
    ];

    this.logger.trace("Lifecycle event", {
      phase: "build",
      component: "host",
      event: "validation:ready",
      durationMs: Date.now() - validationStart,
      warnings: allResults.filter((e) => e.severity === "warning").length,
      errors: allResults.filter((e) => e.severity === "error").length,
    });

    return allResults;
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
  #applyReplacements(replace: ReadonlyMap<ServiceToken<FlareService>, ServiceClass>): void {
    // Two pass: validate every replacement first, then mutate. Keeps the
    // registrations arrays atomic: a failed replacement can be fixed and
    // retried without leaving the host in a half-mutated state. Replacements
    // can target either singleton or scoped registrations; whichever array
    // contains the token is the one mutated.
    type Planned = {
      arr: ServiceRegistration<FlareService>[];
      idx: number;
      token: ServiceToken<FlareService>;
      replacement: ServiceClass;
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
        // ServiceClass models an abstract constructor; widen to concrete-new here so
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
// The cast is type-only and the value IS the class: a class declaration cannot type its
// own constructor as returning the instance PLUS the adapter- and extension-stamped members,
// which the constructor genuinely installs at runtime (#stampMembers). The construct-signature
// interface restates that runtime fact; flare-host-types.test.ts pins it.
export const FlareHost = FlareHostBase as unknown as FlareHostConstructor;

/**
 * The host instance type for a given adapter: the base host plus the adapter's stamped
 * extension, plus the members of any host extensions named in `E`.
 *
 * `E` mirrors the constructor's second argument, so an annotation can carry extension
 * members: `FlareHost<typeof node, [ReturnType<typeof drizzle>]>`.
 */
export type FlareHost<
  TAdapter extends HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle> = HostRuntimeAdapter<
    IFlareApp,
    LoggerTransportClass,
    HostRuntimeLifecycle
  >,
  E extends readonly HostExtension[] = readonly [],
> = FlareHostBase<TAdapter> & ExtensionOf<TAdapter> & ExtensionMembers<E>;
