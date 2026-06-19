import { DurableObject } from "cloudflare:workers";
import type { JsonObject } from "@flare-ts/lib";
import type { FlareHandlerScope } from "../../../arcs/http/composition/types/handlers.js";
import type { CFWLoggerTransport } from "../../../logger/transport.js";
import type { CFWLoggerTransportClass } from "../../../logger/types.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { Container } from "../../../services/container.js";
import type { ServiceRegistration } from "../../../services/types/registration.js";
import type { FlareServiceClass, ServiceToken } from "../../../services/types/types.js";
import type { FlareTestRequestInput } from "../../../testing/types/flare-test-req.js";
import type { IFlareHost } from "../../flare-host.js";
import type { HostRuntimeAdapter } from "../../types/adapter.js";
import { CFWLogger, Logger } from "../../../logger/logger.js";
import { CFWConsoleTransport } from "../../../logger/transports/console.js";
import { FlareAppBase } from "../../flare-app.js";
import {
  COMPILE_INSTANCE_SINGLETONS,
  PROVIDE_SERVICE,
  REGISTER_BUILD_HOOK,
  REVALIDATE,
  SET_HOST_STATE,
} from "../../types/const.js";
import { buildCfTestRequest, FlareCfHandler } from "./handler.js";
import { Bindings, DurableState } from "./services.js";

/** Map of per-instance seed factories handed to `[COMPILE_INSTANCE_SINGLETONS]`. */
type SeedMap = Map<ServiceToken<FlareService>, (container: Container) => FlareService>;

/** Fetch handler returned by {@link CloudflareApp.worker}; the default export of a Worker. */
export type WorkerExportedHandle = {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response>;
};

/** Constructor type of the Durable Object class returned by {@link CloudflareApp.durableObject}. */
export type FlareDurableObjectClass = new(
  state: DurableObjectState,
  env: Cloudflare.Env,
) => DurableObject<Cloudflare.Env>;

/**
 * Optional Durable Object entrypoints passed to {@link CloudflareApp.durableObject}.
 *
 * Each entrypoint receives a fresh per-invocation {@link FlareHandlerScope} (`{ inject, config }`).
 * The WebSocket hooks fire for sockets accepted via `inject(DurableState).state.acceptWebSocket`.
 */
export interface DurableEntrypoints {
  /** Runs once per instance before it serves any traffic; concurrency is blocked until it settles. */
  init?: (scope: FlareHandlerScope) => void | Promise<void>;
  /** Handles a Durable Object alarm; `info` carries workerd's retry and scheduled-time metadata. */
  alarm?: (scope: FlareHandlerScope, info?: AlarmInvocationInfo) => void | Promise<void>;
  /** Handles a message on a WebSocket. */
  webSocketMessage?: (scope: FlareHandlerScope, ws: WebSocket, message: string | ArrayBuffer) => void | Promise<void>;
  /** Handles the close of a WebSocket. */
  webSocketClose?: (
    scope: FlareHandlerScope,
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => void | Promise<void>;
  /** Handles an error on a WebSocket. */
  webSocketError?: (scope: FlareHandlerScope, ws: WebSocket, error: unknown) => void | Promise<void>;
}

/** Cloudflare adapter shape: the base {@link HostRuntimeAdapter} plus a `setup` hook. */
export type CloudflareAdapter =
  & HostRuntimeAdapter<CloudflareApp, CFWLoggerTransportClass, "sync">
  & { setup(host: IFlareHost): void; };

/**
 * Compiled Cloudflare application returned by `host.build()`, exposing the export-shaped terminals.
 *
 * - {@link worker} — a fetch handler whose singletons live per isolate.
 * - {@link durableObject} — a `DurableObject` class whose singletons live per instance.
 */
export class CloudflareApp extends FlareAppBase {
  // Which terminal (if any) was taken from this app. Each `host.build()` yields exactly one terminal:
  // both register framework services onto the shared host, so taking two would let one terminal inherit
  // the other's services (e.g. a Worker would keep DurableState registered and defeat its gate).
  #terminal: "worker" | "durableObject" | undefined;

  #takeTerminal(which: "worker" | "durableObject"): void {
    if (this.#terminal) {
      throw new Error(
        `[flare] host.build() yields exactly one Cloudflare terminal, and this app already produced `
          + `.${this.#terminal}(). Use a separate FlareHost for the .${which}().`,
      );
    }
    this.#terminal = which;
  }

  /**
   * Registers {@link Bindings}, revalidates the graph, and returns the Worker fetch handler.
   *
   * Singletons live per Worker isolate, seeded with the Worker `env` on the first request.
   *
   * @throws If a terminal was already taken from this app.
   */
  worker(): WorkerExportedHandle {
    this.#takeTerminal("worker");
    this.host[PROVIDE_SERVICE]("singleton", frameworkRegistration(Bindings));
    this.host[REVALIDATE]();
    // Start the shared graph once per isolate: the http arc + the framework Logger (whose onStart
    // boots its transports and flushes the bootstrap buffer). User singletons start per isolate below.
    this.start();
    this.host[SET_HOST_STATE]("ready");

    let handler: FlareCfHandler | undefined;
    let initFailure: { error: unknown; } | undefined;
    return {
      fetch: async (request, env) => {
        // First request seeds the per-isolate graph. Keep it failure-atomic: latch the error so a
        // poisoned graph returns a clean 500 (never escapes the isolate) instead of re-running the
        // partial seed + onStart on every subsequent request.
        if (initFailure) throw initFailure.error;
        if (!handler) {
          try {
            const seed: SeedMap = new Map();
            seed.set(Bindings, (c) => new Bindings(c, env));
            const map = this.host[COMPILE_INSTANCE_SINGLETONS](seed);
            startInstanceSingletons(map);
            handler = new FlareCfHandler(this.host, map);
          } catch (error) {
            initFailure = { error };
            throw error;
          }
        }
        return handler.fetch(request);
      },
    };
  }

  /**
   * Registers {@link Bindings} and {@link DurableState}, revalidates the graph, and returns a
   * `DurableObject` class.
   *
   * Singletons live per Durable Object instance, seeded with that instance's state and `env`.
   *
   * @param entrypoints Optional `init`, `alarm`, and WebSocket hooks for the Durable Object.
   * @throws If a terminal was already taken from this app.
   */
  durableObject(entrypoints: DurableEntrypoints = {}): FlareDurableObjectClass {
    this.#takeTerminal("durableObject");
    this.host[PROVIDE_SERVICE]("singleton", frameworkRegistration(Bindings));
    this.host[PROVIDE_SERVICE]("singleton", frameworkRegistration(DurableState));
    this.host[REVALIDATE]();
    // Start the shared graph once (module scope, shared across DO instances): the http arc + the
    // framework Logger. Each instance starts its own user singletons in its constructor.
    this.start();
    this.host[SET_HOST_STATE]("ready");

    return makeFlareDurableObjectClass(this.host, entrypoints);
  }
}

/**
 * Composes one Durable Object instance's app: a fresh singleton graph seeded with this instance's
 * `DurableState(state)` + `Bindings(env)`, with the user singletons started. This is the durable
 * terminal's per-instance core; the generated DO class constructor calls it after `super()`.
 *
 * @internal Exported so white-box tests can drive the real per-instance composition with a synthetic
 * `DurableObjectState` (workerd's native `DurableObject` base rejects a fake `ctx`, so the DO class
 * itself can only be constructed by the runtime).
 */
export function composeDurableInstance(
  host: IFlareHost,
  state: DurableObjectState,
  env: Cloudflare.Env,
): FlareCfHandler {
  const seed: SeedMap = new Map();
  seed.set(DurableState, (c) => new DurableState(c, state));
  seed.set(Bindings, (c) => new Bindings(c, env));
  const map = host[COMPILE_INSTANCE_SINGLETONS](seed);
  startInstanceSingletons(map);
  return new FlareCfHandler(host, map);
}

/** Builds the never-called placeholder registration for a terminal-seeded framework service. */
function frameworkRegistration(token: ServiceToken<FlareService>): ServiceRegistration<FlareService> {
  return {
    token,
    cls: token as unknown as FlareServiceClass,
    factory: () => {
      throw new Error(
        `[flare] ${token.name} is seeded by the Cloudflare terminal, not built from its registration.`,
      );
    },
  };
}

/** Runs sync `onStart` over a per-instance singleton graph; the shared Logger is started once at the host. */
function startInstanceSingletons(map: ReadonlyMap<ServiceToken<FlareService>, FlareService>): void {
  for (const instance of map.values()) {
    if (instance instanceof Logger) continue;
    const result = instance.onStart?.();
    if (result instanceof Promise) {
      throw new Error(
        "[flare] onStart() returned a Promise on the Cloudflare runtime (sync lifecycle). "
          + "For async per-instance startup, use a Durable Object init() entrypoint.",
      );
    }
  }
}

/** Builds the Flare-owned `DurableObject` subclass returned by the durable terminal. */
function makeFlareDurableObjectClass(host: IFlareHost, entrypoints: DurableEntrypoints): FlareDurableObjectClass {
  return class FlareDurableObject extends DurableObject<Cloudflare.Env> {
    #handler: FlareCfHandler;

    constructor(state: DurableObjectState, env: Cloudflare.Env) {
      super(state, env);
      this.#handler = composeDurableInstance(host, state, env);

      if (entrypoints.init) {
        const init = entrypoints.init;
        void state.blockConcurrencyWhile(() => this.#handler.runScoped((scope) => init(scope)));
      }
    }

    fetch(request: Request): Promise<Response> {
      return this.#handler.fetch(request);
    }

    alarm(info?: AlarmInvocationInfo): Promise<void> | void {
      if (!entrypoints.alarm) return;
      const alarm = entrypoints.alarm;
      return this.#handler.runScoped((scope) => alarm(scope, info));
    }

    webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> | void {
      if (!entrypoints.webSocketMessage) return;
      const onMessage = entrypoints.webSocketMessage;
      return this.#handler.runScoped((scope) => onMessage(scope, ws, message));
    }

    webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> | void {
      if (!entrypoints.webSocketClose) return;
      const onClose = entrypoints.webSocketClose;
      return this.#handler.runScoped((scope) => onClose(scope, ws, code, reason, wasClean));
    }

    webSocketError(ws: WebSocket, error: unknown): Promise<void> | void {
      if (!entrypoints.webSocketError) return;
      const onError = entrypoints.webSocketError;
      return this.#handler.runScoped((scope) => onError(scope, ws, error));
    }
  };
}

/**
 * Build hook the Cloudflare adapter registers via {@link HostRuntimeAdapter} `setup`. Cloudflare
 * finalizes per terminal — each terminal registers its framework services, calls `[REVALIDATE]`, and
 * compiles singletons per exported instance — so both validation and singleton compilation are
 * deferred at `build()`.
 */
function cfSetup(host: IFlareHost): void {
  host[REGISTER_BUILD_HOOK]((ctx) => {
    ctx.deferValidation = true;
    ctx.deferSingletonCompile = true;
  });
}

/**
 * Cloudflare runtime adapter (Worker isolate). `host.build()` returns a {@link CloudflareApp} whose
 * terminals (`.worker()`, `.durableObject()`) produce the export shape. Use {@link buildCf} to bind a
 * bundled `flare.json` and `env`; this bare adapter defaults both to empty.
 */
export const cf: CloudflareAdapter = {
  runtime: "cloudflare",
  lifecycle: "sync",
  // A fresh object each read — CF has no filesystem, so the bare adapter carries no config and must
  // not share a mutable default. `buildCf(flareJson)` supplies the bundled config instead.
  get flareJsonFile(): JsonObject {
    return {};
  },
  env: {},
  defaultLoggerTransports: [CFWConsoleTransport],
  createApp(host) {
    return new CloudflareApp(host);
  },
  createLogger(transports, container) {
    return new CFWLogger(transports as CFWLoggerTransport[], container);
  },
  createTestRequest(input: FlareTestRequestInput) {
    return buildCfTestRequest(input);
  },
  setup(host) {
    cfSetup(host);
  },
};

/**
 * Builds a Cloudflare adapter bound to a bundled `flare.json` and optional `env`.
 *
 * On Cloudflare there is no filesystem, so the config is supplied at module scope rather than read
 * from disk.
 */
export function buildCf(flareJsonFile: JsonObject, env: Record<string, string | undefined> = {}): CloudflareAdapter {
  return {
    runtime: cf.runtime,
    lifecycle: cf.lifecycle,
    flareJsonFile,
    env,
    defaultLoggerTransports: cf.defaultLoggerTransports,
    createApp: cf.createApp,
    createLogger: cf.createLogger,
    createTestRequest: cf.createTestRequest,
    setup: cf.setup,
  };
}
