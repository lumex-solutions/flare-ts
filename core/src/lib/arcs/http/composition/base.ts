/**
 * The registration core both authoring forms feed: routes, middleware, groups, and error handlers compile to one shape here.
 */
import type { ConfigToken } from "../../../config/flare-config.js";
import type { FlareError } from "../../../errors/flare-error.js";
import type { HttpErrorContext } from "../../../logger/types.js";
import type { InjectMap } from "../../../services/types/inject.js";
import type { HandlerScope } from "../../../services/types/scope.js";
import type { HttpMethod } from "../routing/types/methods.js";
import type { FlareHttpContext } from "../transport/flare-http-context.js";
import type { HandlerResult, MiddlewareOverride, ResponseLike } from "../transport/types/response.js";
import type {
  ControllerRegistration,
  ErrorHandlerRegistration,
  MiddlewareRegistration,
  RouteRegistration,
} from "../types/registration.js";
import type { ControllerClass } from "./classes/controller-base.js";
import type { ErrorHandlerClass } from "./classes/error-handler-base.js";
import type { MiddlewareClass } from "./classes/middleware-base.js";
import type { RequestDescriptor } from "./contract/http-contract.js";
import type { HttpGroup } from "./group.js";
import type { CorsConfig } from "./types/cors.js";
import type {
  HttpAfterHandler,
  HttpBeforeHandler,
  DescriptorOf,
  HttpErrorHandlerOptions,
  HttpFinallyHandler,
  HttpErrorHandler,
  HttpHandlerScope,
  InjectOf,
  HttpMiddlewareOptions,
  HttpRouteHandler,
  HttpRouteOptions,
} from "./types/handlers.js";
import { assertRegistrationPath } from "../../../routing/path.js";
import { assertInjectKeys, attachScopeDeps } from "../../../services/scope.js";
import { REQUEST_INPUT } from "../transport/flare-http-context.js";
import { ControllerBase } from "./classes/controller-base.js";
import { ErrorHandlerBase } from "./classes/error-handler-base.js";
import { MiddlewareBase } from "./classes/middleware-base.js";
import { controllerRegistration } from "./controller-registration.js";

/** @internal Keys the non-overloaded route-install seam on {@link HttpBase}. */
export const INSTALL_ROUTE: unique symbol = Symbol("INSTALL_ROUTE");

// The storage-erased bound over the heterogeneous handler signatures (route/before/after/finally/
// error): every function type satisfies `(...args: never[]) => unknown`, and unlike `any[]` it cannot
// be CALLED with unchecked arguments - call sites must first narrow to the concrete signature.
type HandlerFn = (...args: never[]) => unknown;
type Resolved<TOptions, THandler extends HandlerFn> = { options: TOptions; handler: THandler; };

/** RequestDescriptor fields usable as loose inline route-option keys (the alternative to `contract`). */
const REQUEST_FIELDS = ["body", "route", "query", "response", "maxBodyBytes", "signedCookies"] as const;

/**
 * Shared base for {@link FlareApp} and {@link HttpGroup}.
 *
 * Public composition has two surfaces:
 * - class-based: controller/use/error with framework base classes
 * - function-based: route/middleware/error handlers with optional options
 */
export abstract class HttpBase {
  /**
   * @internal
   * Returns `this` when the instance is an {@link HttpGroup}, otherwise `undefined`.
   * Overridden by `HttpGroup` to return `this`, avoiding a circular runtime import.
   */
  protected _asGroupParent(): HttpGroup | undefined {
    return undefined;
  }

  /** @internal Raw registrations in authoring order; read by build and validation. */
  readonly mwRegistrations: MiddlewareRegistration[] = [];
  /** @internal Raw registrations in authoring order; read by build and validation. */
  readonly conRegistrations: ControllerRegistration[] = [];
  /** @internal Raw registrations in authoring order; read by build and validation. */
  readonly errorHandlers: ErrorHandlerRegistration[] = [];
  readonly #inlineRoutes = new Map<string, ControllerRegistration>();

  /** @internal Arc-level CORS policy set via {@link cors}; read by build and validation. */
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

  public before(handler: HttpBeforeHandler): void;
  public before<const D extends InjectMap>(
    options: HttpMiddlewareOptions<D>,
    handler: (ctx: FlareHttpContext, scope: HandlerScope<D>) => MiddlewareOverride | Promise<MiddlewareOverride>,
  ): void;

  public before(
    optionsOrHandler: HttpMiddlewareOptions | HttpBeforeHandler,
    maybeHandler?: HttpBeforeHandler,
  ): void {
    const { options, handler } = this.#resolveOptions<HttpMiddlewareOptions, HttpBeforeHandler>(
      optionsOrHandler,
      maybeHandler,
      "middleware",
    );
    this.#syntheticMiddleware("before", options, handler);
  }

  public after(handler: HttpAfterHandler): void;
  public after<const D extends InjectMap>(
    options: HttpMiddlewareOptions<D>,
    handler: (
      ctx: FlareHttpContext,
      result: HandlerResult,
      scope: HandlerScope<D>,
    ) => MiddlewareOverride | Promise<MiddlewareOverride>,
  ): void;

  public after(
    optionsOrHandler: HttpMiddlewareOptions | HttpAfterHandler,
    maybeHandler?: HttpAfterHandler,
  ): void {
    const { options, handler } = this.#resolveOptions<HttpMiddlewareOptions, HttpAfterHandler>(
      optionsOrHandler,
      maybeHandler,
      "middleware",
    );
    this.#syntheticMiddleware("after", options, handler);
  }

  public finally(handler: HttpFinallyHandler): void;
  public finally<const D extends InjectMap>(
    options: HttpMiddlewareOptions<D>,
    handler: (
      ctx: FlareHttpContext,
      result: HandlerResult,
      scope: HandlerScope<D>,
    ) => MiddlewareOverride | Promise<MiddlewareOverride>,
  ): void;

  public finally(
    optionsOrHandler: HttpMiddlewareOptions | HttpFinallyHandler,
    maybeHandler?: HttpFinallyHandler,
  ): void {
    const { options, handler } = this.#resolveOptions<HttpMiddlewareOptions, HttpFinallyHandler>(
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
    this.conRegistrations.push(controllerRegistration(this.#fullPath(path), controller));
  }

  public get(path: string, handler: HttpRouteHandler): void;
  public get<const O extends HttpRouteOptions>(
    path: string,
    options: O,
    handler: (
      ctx: FlareHttpContext,
      scope: HttpHandlerScope<InjectOf<O>, DescriptorOf<O>>,
    ) => HandlerResult | Promise<HandlerResult>,
  ): void;

  public get(
    path: string,
    optionsOrHandler: HttpRouteOptions | HttpRouteHandler,
    maybeHandler?: HttpRouteHandler,
  ): void {
    this.#inlineRoute(path, "GET", optionsOrHandler, maybeHandler);
  }

  public post(path: string, handler: HttpRouteHandler): void;
  public post<const O extends HttpRouteOptions>(
    path: string,
    options: O,
    handler: (
      ctx: FlareHttpContext,
      scope: HttpHandlerScope<InjectOf<O>, DescriptorOf<O>>,
    ) => HandlerResult | Promise<HandlerResult>,
  ): void;

  public post(
    path: string,
    optionsOrHandler: HttpRouteOptions | HttpRouteHandler,
    maybeHandler?: HttpRouteHandler,
  ): void {
    this.#inlineRoute(path, "POST", optionsOrHandler, maybeHandler);
  }

  public put(path: string, handler: HttpRouteHandler): void;
  public put<const O extends HttpRouteOptions>(
    path: string,
    options: O,
    handler: (
      ctx: FlareHttpContext,
      scope: HttpHandlerScope<InjectOf<O>, DescriptorOf<O>>,
    ) => HandlerResult | Promise<HandlerResult>,
  ): void;

  public put(
    path: string,
    optionsOrHandler: HttpRouteOptions | HttpRouteHandler,
    maybeHandler?: HttpRouteHandler,
  ): void {
    this.#inlineRoute(path, "PUT", optionsOrHandler, maybeHandler);
  }

  public patch(path: string, handler: HttpRouteHandler): void;
  public patch<const O extends HttpRouteOptions>(
    path: string,
    options: O,
    handler: (
      ctx: FlareHttpContext,
      scope: HttpHandlerScope<InjectOf<O>, DescriptorOf<O>>,
    ) => HandlerResult | Promise<HandlerResult>,
  ): void;

  public patch(
    path: string,
    optionsOrHandler: HttpRouteOptions | HttpRouteHandler,
    maybeHandler?: HttpRouteHandler,
  ): void {
    this.#inlineRoute(path, "PATCH", optionsOrHandler, maybeHandler);
  }

  public delete(path: string, handler: HttpRouteHandler): void;
  public delete<const O extends HttpRouteOptions>(
    path: string,
    options: O,
    handler: (
      ctx: FlareHttpContext,
      scope: HttpHandlerScope<InjectOf<O>, DescriptorOf<O>>,
    ) => HandlerResult | Promise<HandlerResult>,
  ): void;

  public delete(
    path: string,
    optionsOrHandler: HttpRouteOptions | HttpRouteHandler,
    maybeHandler?: HttpRouteHandler,
  ): void {
    this.#inlineRoute(path, "DELETE", optionsOrHandler, maybeHandler);
  }

  public head(path: string, handler: HttpRouteHandler): void;
  public head<const O extends HttpRouteOptions>(
    path: string,
    options: O,
    handler: (
      ctx: FlareHttpContext,
      scope: HttpHandlerScope<InjectOf<O>, DescriptorOf<O>>,
    ) => HandlerResult | Promise<HandlerResult>,
  ): void;

  public head(
    path: string,
    optionsOrHandler: HttpRouteOptions | HttpRouteHandler,
    maybeHandler?: HttpRouteHandler,
  ): void {
    this.#inlineRoute(path, "HEAD", optionsOrHandler, maybeHandler);
  }

  public options(path: string, handler: HttpRouteHandler): void;
  public options<const O extends HttpRouteOptions>(
    path: string,
    options: O,
    handler: (
      ctx: FlareHttpContext,
      scope: HttpHandlerScope<InjectOf<O>, DescriptorOf<O>>,
    ) => HandlerResult | Promise<HandlerResult>,
  ): void;

  public options(
    path: string,
    optionsOrHandler: HttpRouteOptions | HttpRouteHandler,
    maybeHandler?: HttpRouteHandler,
  ): void {
    this.#inlineRoute(path, "OPTIONS", optionsOrHandler, maybeHandler);
  }

  public error(handler: ErrorHandlerClass): void;
  public error(handler: HttpErrorHandler): void;
  public error<const D extends InjectMap>(
    options: HttpErrorHandlerOptions<D>,
    handler: (
      err: FlareError | Error,
      context: HttpErrorContext,
      scope: HandlerScope<D>,
    ) => ResponseLike | void | Promise<ResponseLike | void>,
  ): void;

  public error(
    optionsOrHandler: ErrorHandlerClass | HttpErrorHandlerOptions | HttpErrorHandler,
    maybeHandler?: HttpErrorHandler,
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

    const { options, handler } = this.#resolveOptions<HttpErrorHandlerOptions, HttpErrorHandler>(
      optionsOrHandler as HttpErrorHandlerOptions | HttpErrorHandler,
      maybeHandler,
      "error handler",
    );
    assertInjectKeys(options.inject ?? {});
    const deps = Object.values(options.inject ?? {});
    const name = options.name ?? "SyntheticErrorHandler";
    const ownInject = (options.inject ?? {}) as InjectMap;

    const BuiltErrorHandler = class extends ErrorHandlerBase {
      static override deps = deps;

      override handle(err: FlareError | Error, context: HttpErrorContext) {
        return handler(
          err,
          context,
          attachScopeDeps(
            { config: <T>(token: ConfigToken<T>): T => this.container.resolveCfg(token) },
            ownInject,
            (token) => this.inject(token),
          ),
        );
      }
    };
    Object.defineProperty(BuiltErrorHandler, "name", { value: name });

    this.errorHandlers.push({ factory: (container) => new BuiltErrorHandler(container), deps, cls: BuiltErrorHandler });
  }

  /**
   * @internal
   * Non-overloaded route-install seam for framework code that dispatches verbs
   * dynamically (e.g. Durable Object mount forwarding). The public verb methods
   * remain the developer surface; this bypasses their per-shape overloads only.
   */
  [INSTALL_ROUTE](
    path: string,
    method: HttpMethod,
    options: HttpRouteOptions,
    handler: HttpRouteHandler,
  ): void {
    this.#inlineRoute(path, method, options, handler);
  }

  #inlineRoute(
    path: string,
    method: HttpMethod,
    optionsOrHandler: HttpRouteOptions | HttpRouteHandler,
    maybeHandler?: HttpRouteHandler,
  ): void {
    this.#assertPath(path);
    const { options, handler } = this.#resolveOptions<HttpRouteOptions, HttpRouteHandler>(
      optionsOrHandler,
      maybeHandler,
      "route",
    );
    const fullPath = this.#fullPath(path);
    const existing = this.#inlineRoutes.get(fullPath);

    if (existing?.routes.some((route) => route.method === method)) {
      throw new Error(
        `Duplicate route registration for ${method} ${fullPath}. Each route can only have one handler per HTTP method.`,
      );
    }
    if (existing && options.name !== undefined) {
      throw new Error(
        `${method} ${fullPath} sets "name", but only the first route registered at ${fullPath} can: every method at one path shares one registration.`,
      );
    }
    if (existing && (options.isolated ?? false) !== existing.isolated) {
      throw new Error(
        `${method} ${fullPath} sets isolated: ${
          options.isolated ?? false
        }, but the route already registered at ${fullPath} uses isolated: ${existing.isolated}. Every method at one path runs the same middleware chain, so they must match.`,
      );
    }

    assertInjectKeys(options.inject ?? {});
    const inject = (options.inject ?? {}) as InjectMap;
    const fn = handler;
    const routeHandler = function(this: ControllerBase) {
      // The receiver declares no static deps or config, so this.inject() and this.config() would refuse;
      // the scope resolves through the container, and only the tokens this route declared.
      // The cast restates the pairing the erased storage cannot: this scope's `input` was parsed
      // from the SAME contract the handler's typed signature was checked against at registration.
      return fn(
        this.ctx,
        attachScopeDeps(
          {
            config: <T>(token: ConfigToken<T>): T => this.container.resolveCfg(token),
            input: this.ctx[REQUEST_INPUT](),
          },
          inject,
          (token) => this.container.resolveDep(token),
        ) as HttpHandlerScope,
      );
    };
    // Validator messages identify a route's handler by its name.
    Object.defineProperty(routeHandler, "name", { value: method });
    const route: RouteRegistration = { method, path: "", handler: routeHandler, descriptor: routeDescriptor(options) };

    if (existing) {
      existing.routes.push(route);
      for (const dep of Object.values(inject)) {
        if (!existing.deps.includes(dep)) existing.deps.push(dep);
      }
      for (const st of options.state ?? []) {
        if (!existing.state.includes(st)) existing.state.push(st);
      }
      return;
    }

    const registration: ControllerRegistration = {
      factory: (container, ctx) => new InlineRoute(container, ctx),
      path: fullPath,
      isolated: options.isolated ?? false,
      name: options.name ?? fullPath,
      routes: [route],
      // Dedup: `inject: { a: Svc, b: Svc }` declares one dep, not two.
      deps: [...new Set(Object.values(inject))],
      state: [...(options.state ?? [])],
      config: undefined,
    };
    this.#inlineRoutes.set(fullPath, registration);
    this.conRegistrations.push(registration);
  }

  // Detect async functions once at module load: same mechanism as exec-codegen.ts.
  static readonly #AsyncFn = Object.getPrototypeOf(async function() {}).constructor as FunctionConstructor;

  #syntheticMiddleware(
    lifecycle: "before" | "after" | "finally",
    options: HttpMiddlewareOptions,
    handler: HttpBeforeHandler | HttpAfterHandler | HttpFinallyHandler,
  ): void {
    assertInjectKeys(options.inject ?? {});
    // Dedup: `inject: { a: Svc, b: Svc }` declares one dep, not two.
    const deps = [...new Set(Object.values(options.inject ?? {}))];
    const state = [...(options.state ?? [])];
    const provides = options.provides ? [...options.provides] : undefined;
    const name = options.name ?? `Synthetic${this.#capitalize(lifecycle)}Middleware`;
    const ownInject = (options.inject ?? {}) as InjectMap;
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
          return (handler as HttpBeforeHandler)(
            this.ctx,
            attachScopeDeps(
              { config: <T>(token: ConfigToken<T>): T => this.container.resolveCfg(token) },
              ownInject,
              (token) => this.inject(token),
            ),
          );
        }
      };
      if (callbackIsAsync) BuiltMiddleware._asyncHook = true;
      this.#registerSyntheticMiddleware(name, BuiltMiddleware, provides);
      return;
    }

    if (lifecycle === "after") {
      const BuiltMiddleware = class extends MiddlewareBase {
        static override deps = deps;
        static override state = state;

        override after(result: HandlerResult) {
          return (handler as HttpAfterHandler)(
            this.ctx,
            result,
            attachScopeDeps(
              { config: <T>(token: ConfigToken<T>): T => this.container.resolveCfg(token) },
              ownInject,
              (token) => this.inject(token),
            ),
          );
        }
      };
      if (callbackIsAsync) BuiltMiddleware._asyncHook = true;
      this.#registerSyntheticMiddleware(name, BuiltMiddleware, provides);
      return;
    }

    const BuiltMiddleware = class extends MiddlewareBase {
      static override deps = deps;
      static override state = state;

      override finally(result: HandlerResult) {
        return (handler as HttpFinallyHandler)(
          this.ctx,
          result,
          attachScopeDeps(
            { config: <T>(token: ConfigToken<T>): T => this.container.resolveCfg(token) },
            ownInject,
            (token) => this.inject(token),
          ),
        );
      }
    };
    if (callbackIsAsync) BuiltMiddleware._asyncHook = true;
    this.#registerSyntheticMiddleware(name, BuiltMiddleware, provides);
  }

  #registerSyntheticMiddleware(
    name: string,
    middleware: MiddlewareClass,
    provides?: HttpMiddlewareOptions["provides"],
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

/**
 * Resolves a route's {@link RequestDescriptor} from its options. A route supplies its request shape one
 * of two ways: a branded `contract` entry (which IS a descriptor; the brand is an inert extra symbol),
 * or the loose descriptor fields spelled inline. Returns undefined when the route declares neither.
 */
function routeDescriptor(options: HttpRouteOptions): RequestDescriptor | undefined {
  // A branded contract entry IS a descriptor at runtime; the brand is an inert
  // extra symbol the descriptor type does not carry.
  if (options.contract) return options.contract as RequestDescriptor;
  let descriptor: Record<string, unknown> | undefined;
  for (const field of REQUEST_FIELDS) {
    const value = (options as Record<string, unknown>)[field];
    if (value !== undefined) (descriptor ??= {})[field] = value;
  }
  // Assembled field-by-field from REQUEST_FIELDS; the loop realizes exactly the
  // descriptor shape, which the checker cannot follow through dynamic keys.
  return descriptor as RequestDescriptor | undefined;
}

/** Receiver every inline route's handler runs against; the route itself is data on its registration. */
class InlineRoute extends ControllerBase {}
