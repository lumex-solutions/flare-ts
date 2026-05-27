import type { FlareError } from "../../../errors/flare-error.js";
import type { HttpErrorContext } from "../../../logger/types.js";
import type { HandlerResult } from "../transport/types/response.js";
import type {
  ControllerRegistration,
  ErrorHandlerRegistration,
  MiddlewareRegistration,
} from "../types/registration.js";
import type { ControllerClass } from "./classes/controller-base.js";
import type { ErrorHandlerClass } from "./classes/error-handler-base.js";
import type { MiddlewareClass } from "./classes/middleware-base.js";
import type { HttpGroup } from "./group.js";
import type { CorsConfig } from "./types/cors.js";
import type {
  AfterMiddlewareHandler,
  BeforeMiddlewareHandler,
  ErrorHandlerOptions,
  FinallyMiddlewareHandler,
  FlareErrorHandler,
  MiddlewareOptions,
  RouteHandler,
  RouteOptions,
} from "./types/handlers.js";
import { Method, registerRoute } from "../routing/decorators.js";
import { assertRegistrationPath } from "../routing/path.js";
import { ControllerBase } from "./classes/controller-base.js";
import { ErrorHandlerBase } from "./classes/error-handler-base.js";
import { MiddlewareBase } from "./classes/middleware-base.js";
import { flareContract } from "./contract/flare-contract.js";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
// TODO(review): replace any - HandlerFn covers heterogeneous handler signatures (route/before/after/finally/error).
type HandlerFn = (...args: any[]) => unknown;
type Resolved<TOptions, THandler extends HandlerFn> = { options: TOptions; handler: THandler; };
type SyntheticEntry = { cls: ControllerClass; registration: ControllerRegistration; methods: Set<HttpMethod>; };

/**
 * Shared base for {@link FlareApp} and {@link HttpGroup}.
 *
 * Public composition has two surfaces:
 * - class-based: controller/use/error with framework base classes
 * - function-based: route/middleware/error handlers with optional options
 */
export abstract class HttpBase {
  /**
   * Returns `this` when the instance is an {@link HttpGroup}, otherwise `undefined`.
   * Overridden by `HttpGroup` to return `this`, avoiding a circular runtime import.
   */
  protected _asGroupParent(): HttpGroup | undefined {
    return undefined;
  }

  readonly mwRegistrations: MiddlewareRegistration[] = [];
  readonly conRegistrations: ControllerRegistration[] = [];
  readonly errorHandlers: ErrorHandlerRegistration[] = [];
  readonly #syntheticControllers = new Map<string, SyntheticEntry>();

  corsConfig: CorsConfig | undefined = undefined;

  /**
   * Attaches a CORS policy to this arc or group.
   *
   * At the arc level (`host.http.cors()`), the policy applies to every route
   * not inside a group with its own `.cors()` call.
   *
   * At the group level (`g.cors()`), the policy fully replaces the arc-level
   * policy for every route registered inside that group.
   */
  public cors(config: CorsConfig): void {
    this.corsConfig = config;
  }

  public use(middleware: MiddlewareClass): void {
    if (!(middleware.prototype instanceof MiddlewareBase)) {
      throw new Error("Invalid middleware argument. Must be a MiddlewareClass.");
    }

    this.#assertMiddlewareStatics(middleware);
    this.mwRegistrations.push({ factory: (container, req) => new middleware(container, req), cls: middleware });
  }

  public before(handler: BeforeMiddlewareHandler): void;
  public before(options: MiddlewareOptions, handler: BeforeMiddlewareHandler): void;

  public before(
    optionsOrHandler: MiddlewareOptions | BeforeMiddlewareHandler,
    maybeHandler?: BeforeMiddlewareHandler,
  ): void {
    const { options, handler } = this.#resolveOptions<MiddlewareOptions, BeforeMiddlewareHandler>(
      optionsOrHandler,
      maybeHandler,
      "middleware",
    );
    this.#syntheticMiddleware("before", options, handler);
  }

  public after(handler: AfterMiddlewareHandler): void;
  public after(options: MiddlewareOptions, handler: AfterMiddlewareHandler): void;

  public after(
    optionsOrHandler: MiddlewareOptions | AfterMiddlewareHandler,
    maybeHandler?: AfterMiddlewareHandler,
  ): void {
    const { options, handler } = this.#resolveOptions<MiddlewareOptions, AfterMiddlewareHandler>(
      optionsOrHandler,
      maybeHandler,
      "middleware",
    );
    this.#syntheticMiddleware("after", options, handler);
  }

  public finally(handler: FinallyMiddlewareHandler): void;
  public finally(options: MiddlewareOptions, handler: FinallyMiddlewareHandler): void;

  public finally(
    optionsOrHandler: MiddlewareOptions | FinallyMiddlewareHandler,
    maybeHandler?: FinallyMiddlewareHandler,
  ): void {
    const { options, handler } = this.#resolveOptions<MiddlewareOptions, FinallyMiddlewareHandler>(
      optionsOrHandler,
      maybeHandler,
      "middleware",
    );
    this.#syntheticMiddleware("finally", options, handler);
  }

  public controller(path: string, controller: ControllerClass): void {
    this.#assertPath(path);
    if (!(controller.prototype instanceof ControllerBase)) {
      throw new Error(`Invalid controller argument for path ${path}. Must be a ControllerClass.`);
    }

    this.#assertControllerStatics(controller);
    const fullPath = this.#fullPath(path);
    this.conRegistrations.push({
      factory: (container, req) => new controller(container, req),
      cls: controller,
      path: fullPath,
      standalone: false,
      groupIsolated: false,
      groupErrorHandlers: [],
      groupExcludeList: [],
      groupReplacements: [],
    });
  }

  public get(path: string, handler: RouteHandler): void;
  public get(path: string, options: RouteOptions, handler: RouteHandler): void;

  public get(path: string, optionsOrHandler: RouteOptions | RouteHandler, maybeHandler?: RouteHandler): void {
    this.#syntheticController(path, "GET", optionsOrHandler, maybeHandler);
  }

  public post(path: string, handler: RouteHandler): void;
  public post(path: string, options: RouteOptions, handler: RouteHandler): void;

  public post(path: string, optionsOrHandler: RouteOptions | RouteHandler, maybeHandler?: RouteHandler): void {
    this.#syntheticController(path, "POST", optionsOrHandler, maybeHandler);
  }

  public put(path: string, handler: RouteHandler): void;
  public put(path: string, options: RouteOptions, handler: RouteHandler): void;

  public put(path: string, optionsOrHandler: RouteOptions | RouteHandler, maybeHandler?: RouteHandler): void {
    this.#syntheticController(path, "PUT", optionsOrHandler, maybeHandler);
  }

  public patch(path: string, handler: RouteHandler): void;
  public patch(path: string, options: RouteOptions, handler: RouteHandler): void;

  public patch(path: string, optionsOrHandler: RouteOptions | RouteHandler, maybeHandler?: RouteHandler): void {
    this.#syntheticController(path, "PATCH", optionsOrHandler, maybeHandler);
  }

  public delete(path: string, handler: RouteHandler): void;
  public delete(path: string, options: RouteOptions, handler: RouteHandler): void;

  public delete(path: string, optionsOrHandler: RouteOptions | RouteHandler, maybeHandler?: RouteHandler): void {
    this.#syntheticController(path, "DELETE", optionsOrHandler, maybeHandler);
  }

  public head(path: string, handler: RouteHandler): void;
  public head(path: string, options: RouteOptions, handler: RouteHandler): void;

  public head(path: string, optionsOrHandler: RouteOptions | RouteHandler, maybeHandler?: RouteHandler): void {
    this.#syntheticController(path, "HEAD", optionsOrHandler, maybeHandler);
  }

  public options(path: string, handler: RouteHandler): void;
  public options(path: string, options: RouteOptions, handler: RouteHandler): void;

  public options(path: string, optionsOrHandler: RouteOptions | RouteHandler, maybeHandler?: RouteHandler): void {
    this.#syntheticController(path, "OPTIONS", optionsOrHandler, maybeHandler);
  }

  public error(handler: ErrorHandlerClass): void;
  public error(handler: FlareErrorHandler): void;
  public error(options: ErrorHandlerOptions, handler: FlareErrorHandler): void;

  public error(
    optionsOrHandler: ErrorHandlerClass | ErrorHandlerOptions | FlareErrorHandler,
    maybeHandler?: FlareErrorHandler,
  ): void {
    if (typeof optionsOrHandler === "function" && optionsOrHandler.prototype instanceof ErrorHandlerBase) {
      const handlerClass = optionsOrHandler as ErrorHandlerClass;
      if (handlerClass.deps === undefined) throw new Error(`${handlerClass.name} is missing static 'deps'.`);
      this.errorHandlers.push({
        factory: (container) => new handlerClass(container),
        deps: handlerClass.deps,
        cls: handlerClass,
      });
      return;
    }

    const { options, handler } = this.#resolveOptions<ErrorHandlerOptions, FlareErrorHandler>(
      optionsOrHandler as ErrorHandlerOptions | FlareErrorHandler,
      maybeHandler,
      "error handler",
    );
    const deps = [...(options.inject ?? [])];
    const name = options.name ?? "SyntheticErrorHandler";

    const BuiltErrorHandler = class extends ErrorHandlerBase {
      static override deps = deps;

      override handle(err: FlareError | Error, context: HttpErrorContext) {
        return handler(err, context, {
          inject: (token) => this.inject(token),
          config: (token) => this.config(token),
        });
      }
    };
    Object.defineProperty(BuiltErrorHandler, "name", { value: name });

    this.errorHandlers.push({ factory: (container) => new BuiltErrorHandler(container), deps, cls: BuiltErrorHandler });
  }

  #syntheticController(
    path: string,
    method: HttpMethod,
    optionsOrHandler: RouteOptions | RouteHandler,
    maybeHandler?: RouteHandler,
  ): void {
    this.#assertPath(path);
    const { options, handler } = this.#resolveOptions<RouteOptions, RouteHandler>(
      optionsOrHandler,
      maybeHandler,
      "route",
    );
    const fullPath = this.#fullPath(path);
    const existing = this.#syntheticControllers.get(fullPath);

    if (existing) {
      if (existing.methods.has(method)) {
        throw new Error(
          `Duplicate route registration for ${method} ${fullPath}. Each route can only have one handler per HTTP method.`,
        );
      }

      // Graft a new named method onto the existing prototype so the single
      // registration covers every HTTP method registered at this path.
      const methodName = `handle${method}`;
      const fn = handler;
      Object.defineProperty(existing.cls.prototype, methodName, {
        value: function(this: ControllerBase) {
          return fn(this.ctx, {
            inject: (token) => this.inject(token),
            // Inline handlers have no static config declaration site, so route
            // config resolution directly through the container instead of
            // this.config(), whose guardrail would always throw here.
            config: (token) => this.container.resolveCfg(token),
          });
        },
        writable: true,
        configurable: true,
      });

      // Apply the @Method decorator programmatically.
      registerRoute(existing.cls, method, methodName);

      for (const dep of (options.inject ?? [])) {
        if (!existing.cls.deps.includes(dep)) existing.cls.deps.push(dep);
      }
      for (const st of (options.state ?? [])) {
        if (!existing.cls.state.includes(st)) existing.cls.state.push(st);
      }

      existing.methods.add(method);
      return;
    }

    const deps = [...(options.inject ?? [])];
    const state = [...(options.state ?? [])];
    const contract = options.contract ? flareContract({ handle: options.contract }) : undefined;
    const name = options.name ?? `Synthetic${method} ${fullPath}`;
    const fn = handler;

    const SyntheticController = class extends ControllerBase {
      static override deps = deps;
      static override state = state;
      static override contract = contract;

      @Method(method)
      handle() {
        return fn(this.ctx, {
          inject: (token) => this.inject(token),
          // Inline handlers have no static config declaration site, so route
          // config resolution directly through the container instead of
          // this.config(), whose guardrail would always throw here.
          config: (token) => this.container.resolveCfg(token),
        });
      }
    };
    Object.defineProperty(SyntheticController, "name", { value: name });

    const registration: ControllerRegistration = {
      factory: (container, req) => new SyntheticController(container, req),
      cls: SyntheticController as ControllerClass,
      path: fullPath,
      standalone: options.isolated ?? false,
      groupIsolated: false,
      groupErrorHandlers: [],
      groupExcludeList: [],
      groupReplacements: [],
    };

    this.#syntheticControllers.set(fullPath, {
      cls: SyntheticController as ControllerClass,
      registration,
      methods: new Set([method]),
    });
    this.conRegistrations.push(registration);
  }

  // Detect async functions once at module load: same mechanism as exec-codegen.ts.
  static readonly #AsyncFn = Object.getPrototypeOf(async function() {}).constructor as FunctionConstructor;

  #syntheticMiddleware(
    lifecycle: "before" | "after" | "finally",
    options: MiddlewareOptions,
    handler: BeforeMiddlewareHandler | AfterMiddlewareHandler | FinallyMiddlewareHandler,
  ): void {
    const deps = [...(options.inject ?? [])];
    const state = [...(options.state ?? [])];
    const provides = options.provides ? [...options.provides] : undefined;
    const name = options.name ?? `Synthetic${this.#capitalize(lifecycle)}Middleware`;
    // If the user's callback is async, the wrapper's prototype method is NOT async
    // (it's a plain function returning handler(...)), so exec-codegen's _isAsyncFn
    // would miss it. We mark the class with _asyncHook so _detectSlotAsync can detect
    // it correctly at pipeline compile time.
    const callbackIsAsync = handler instanceof HttpBase.#AsyncFn;

    if (lifecycle === "before") {
      const BuiltMiddleware = class extends MiddlewareBase {
        static override deps = deps;
        static override state = state;

        override before() {
          return (handler as BeforeMiddlewareHandler)(this.ctx, {
            inject: (token) => this.inject(token),
            config: (token) => this.config(token),
          });
        }
      };
      if (callbackIsAsync) (BuiltMiddleware as { _asyncHook?: boolean; })._asyncHook = true;
      this.#registerSyntheticMiddleware(name, BuiltMiddleware, provides);
      return;
    }

    if (lifecycle === "after") {
      const BuiltMiddleware = class extends MiddlewareBase {
        static override deps = deps;
        static override state = state;

        override after(result: HandlerResult) {
          return (handler as AfterMiddlewareHandler)(this.ctx, result, {
            inject: (token) => this.inject(token),
            config: (token) => this.config(token),
          });
        }
      };
      if (callbackIsAsync) (BuiltMiddleware as { _asyncHook?: boolean; })._asyncHook = true;
      this.#registerSyntheticMiddleware(name, BuiltMiddleware, provides);
      return;
    }

    const BuiltMiddleware = class extends MiddlewareBase {
      static override deps = deps;
      static override state = state;

      override finally(result: HandlerResult) {
        return (handler as FinallyMiddlewareHandler)(this.ctx, result, {
          inject: (token) => this.inject(token),
          config: (token) => this.config(token),
        });
      }
    };
    if (callbackIsAsync) (BuiltMiddleware as { _asyncHook?: boolean; })._asyncHook = true;
    this.#registerSyntheticMiddleware(name, BuiltMiddleware, provides);
  }

  #registerSyntheticMiddleware(
    name: string,
    middleware: MiddlewareClass,
    provides?: MiddlewareOptions["provides"],
  ): void {
    if (provides) middleware.provides = [...provides];
    Object.defineProperty(middleware, "name", { value: name });
    this.mwRegistrations.push({
      factory: (container, req) => new middleware(container, req),
      cls: middleware,
    });
  }

  #resolveOptions<TOptions extends object, THandler extends HandlerFn>(
    optionsOrHandler: TOptions | THandler,
    maybeHandler: THandler | undefined,
    label: string,
  ): Resolved<TOptions, THandler> {
    if (typeof optionsOrHandler === "function") {
      return { options: {} as TOptions, handler: optionsOrHandler };
    }
    if (!maybeHandler) throw new Error(`Missing ${label} function.`);
    return { options: optionsOrHandler, handler: maybeHandler };
  }

  #assertPath(path: string): void {
    assertRegistrationPath(path);
  }

  #fullPath(path: string): string {
    const parent = this._asGroupParent();
    return parent ? parent.prefix + path : path;
  }

  #assertControllerStatics(controller: ControllerClass): void {
    const missingDeps = controller.deps == undefined;
    const missingState = controller.state == undefined;
    if (missingDeps && missingState) throw new Error(`${controller.name} is missing static 'deps' and 'state'.`);
    if (missingDeps) throw new Error(`${controller.name} is missing static 'deps'.`);
    if (missingState) throw new Error(`${controller.name} is missing static 'state'.`);
  }

  #assertMiddlewareStatics(middleware: MiddlewareClass): void {
    const missingDeps = middleware.deps == undefined;
    const missingState = middleware.state == undefined;
    if (missingDeps && missingState) throw new Error(`${middleware.name} is missing static 'deps' and 'state'.`);
    if (missingDeps) throw new Error(`${middleware.name} is missing static 'deps'.`);
    if (missingState) throw new Error(`${middleware.name} is missing static 'state'.`);
  }

  #capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
