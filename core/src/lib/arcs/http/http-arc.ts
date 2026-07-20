/**
 * The HTTP arc: route registration surface, pipeline dispatch on fetch, and lifecycle hooks.
 */
import type { ArrayTypedPrimitive, JsonValue } from "@flare-ts/lib/schema";
import type { Primitive, TypedPrimitive } from "@flare-ts/lib/schema";
import type { IFlareHost } from "../../host/flare-host.js";
import type { HostRuntimeLifecycle, LifecycleCallback } from "../../host/types/lifecycle.js";
import type { Router } from "../../routing/router.js";
import type { StateToken } from "../../state/flare-state.js";
import type { HttpArcInspectSnapshot, RouterInspectSnapshot } from "../../testing/types/inspect-build.js";
import type { MiddlewareBase } from "./composition/classes/middleware-base.js";
import type { HttpGroupFn } from "./composition/group.js";
import type { RouteSegment } from "./routing/types/route.js";
import type { CookieSigner } from "./transport/cookie-signer.js";
import type { FlareHttpContext } from "./transport/flare-http-context.js";
import type { QueryValue } from "./transport/types/request-context.js";
import type { HandlerResult, ResponseLike } from "./transport/types/response.js";
import type { ExecFn } from "./types/exec-fn.js";
import type { Pipeline } from "./types/pipeline.js";
import type { CompiledQueryPrimitive } from "./types/pipeline.js";
import type { GroupRegistration } from "./types/registration.js";
import { toErrorField } from "../../logger/fields.js";
import { isValidInboundPath } from "../../routing/path.js";
import { Container } from "../../services/container.js";
import { compileHttp } from "./build.js";
import { HttpBase } from "./composition/base.js";
import { stream } from "./composition/contract/http-contract.js";
import { HttpGroup } from "./composition/group.js";
import { applyActualCorsHeaders, buildCorsPreflightResponse, checkOriginAllowed } from "./cors.js";
import { deriveAllowedMethods } from "./routing/allow-methods.js";
import { INVALID_REQUEST_PATH_MESSAGE } from "./routing/path.js";
import { METHOD_IDX_MAP } from "./routing/types/methods.js";
import { INSTANCE_SINGLETONS, SET_REQ_CTX } from "./transport/flare-http-context.js";
import { type FlareRequest, SET_MAX_BODY_BYTES, SET_ROUTE_PARAMS } from "./transport/flare-request.js";
import { FINALIZE_JSON_BODY, FlareResponse } from "./transport/flare-response.js";
import { normalizeHandlerResult } from "./transport/normalize.js";
import { COOKIE_SIGNER } from "./transport/types/cookies.js";

export const CHAR_CODE_COLON = 58; // ":"
export const CHAR_CODE_SLASH = 47; // "/"
export const CHAR_CODE_STAR = 42; // "*"

export const COMPILE_HTTP_ARC: unique symbol = Symbol("COMPILE_HTTP_ARC");
export const REEVALUATE_CONTAINER_STRATEGY: unique symbol = Symbol("REEVALUATE_CONTAINER_STRATEGY");
export const INSPECT_HTTP_ARC: unique symbol = Symbol("INSPECT_HTTP_ARC");
export const START_HTTP_ARC: unique symbol = Symbol("START_HTTP_ARC");
export const START_HTTP_ARC_ASYNC: unique symbol = Symbol("START_HTTP_ARC_ASYNC");
export const STOP_HTTP_ARC: unique symbol = Symbol("STOP_HTTP_ARC");
export const STOP_HTTP_ARC_ASYNC: unique symbol = Symbol("STOP_HTTP_ARC_ASYNC");

// Reused for every no-middleware pipeline: never written to, never needs to be reset.
const _EMPTY_MW_CACHE: MiddlewareBase[] = [];

/**
 * Top-level application entry point.
 *
 * Extends {@link HttpBase} with `group` for registering prefixed route groups and
 * `run` for handing control to the runtime selected by the build pipeline.
 */
export class HttpArc<TLifecycle extends HostRuntimeLifecycle = "async"> extends HttpBase {
  #pipelines: Pipeline[] = [];
  #execFns: ExecFn[] = [];
  #router?: Router;
  /** Pre-built once at compile time; reused every request when there are no scoped services. */
  #sharedContainer: Container | undefined;
  /** Cached at compile time; stamped onto each ctx only when a cookie secret is configured. */
  #cookieSigner: CookieSigner | undefined;

  /** @internal Raw group registrations in authoring order; read by build and validation. */
  readonly groups: GroupRegistration[] = [];
  readonly #onStartCallbacks: Array<LifecycleCallback<TLifecycle>> = [];
  readonly #onStopCallbacks: Array<LifecycleCallback<TLifecycle>> = [];

  constructor(
    /** @internal The owning host; composition wiring, not application API. */ readonly host: IFlareHost<TLifecycle>,
  ) {
    super();
  }

  /** @internal Sync-driver arc start: runs the registered onStart callbacks. */
  [START_HTTP_ARC](): void {
    for (const fn of this.#onStartCallbacks) {
      const result = fn();
      if (result instanceof Promise) {
        throw new Error("[flare] Sync runtime lifecycle callback returned a Promise.");
      }
    }
  }

  /** @internal Async-driver arc start: awaits the registered onStart callbacks. */
  async [START_HTTP_ARC_ASYNC](): Promise<void> {
    for (const fn of this.#onStartCallbacks) {
      await fn();
    }
  }

  /** @internal Sync-driver arc stop: runs the registered onStop callbacks. */
  [STOP_HTTP_ARC](): void {
    for (const fn of this.#onStopCallbacks) {
      const result = fn();
      if (result instanceof Promise) {
        throw new Error("[flare] Sync runtime lifecycle callback returned a Promise.");
      }
    }
  }

  /** @internal Async-driver arc stop: awaits the registered onStop callbacks. */
  async [STOP_HTTP_ARC_ASYNC](): Promise<void> {
    for (const fn of this.#onStopCallbacks) {
      await fn();
    }
  }

  /**
   * @internal Invoked by FlareHost.build() to compile the http arc into pipelines / router / middleware.
   *
   * `providedAtEntry` is an optional, opaque list of state tokens treated as provided before any
   * middleware runs (i.e. seeded into the per-controller provided-state set). The Cloudflare
   * adapter passes a Durable Object's `static state` tokens here so DO routes consuming forwarded
   * state validate clean; the generic arc attaches no DO/CF meaning to them.
   */
  [COMPILE_HTTP_ARC](providedAtEntry: readonly StateToken[] = []): void {
    const controllers = [...this.conRegistrations];

    for (const group of this.groups) {
      controllers.push(...group.controllers);
    }

    const { pipelines, router, execFns } = compileHttp(
      controllers,
      this.mwRegistrations,
      this.errorHandlers,
      this.groups,
      this.corsConfig,
      providedAtEntry,
    );

    this.#pipelines = pipelines;
    this.#router = router;
    this.#execFns = execFns;
    this.#cookieSigner = this.host.cookieSigner;

    // If there are no per-request (scoped) services, a single Container instance can be
    // shared across all requests: its `instances` map is never written so it is safe.
    if (this.host.scopedServices.length === 0) {
      this.#sharedContainer = new Container(this.host.scopedServices, this.host.singletonServices, this.host.config);
    }
  }

  /**
   * @internal In test mode, scoped registration is deferred from host.build() to
   * app.test() so replace({}) can substitute classes before any instance is
   * built. By the time [COMPILE_HTTP_ARC] runs, scopedServices is empty and a
   * shared container is incorrectly installed. After scoped registration
   * becomes visible, the host calls this to redo just the container-strategy
   * decision: drop the shared container so per-request isolation (and
   * disposal) kick back in when scoped services are present.
   */
  [REEVALUATE_CONTAINER_STRATEGY](): void {
    if (this.host.scopedServices.length === 0) {
      this.#sharedContainer ??= new Container(this.host.scopedServices, this.host.singletonServices, this.host.config);
    } else {
      this.#sharedContainer = undefined;
    }
  }

  /** @internal Snapshot for tests via {@link inspectBuild}. */
  [INSPECT_HTTP_ARC](): HttpArcInspectSnapshot {
    const router = this.#router;
    if (!router) {
      return {
        compiled: false,
        routes: [],
        pipelines: [],
        router: undefined,
        usesSharedContainer: false,
      };
    }

    const matchRouter: RouterInspectSnapshot = {
      routeCount: router.routeCount,
      maxDepth: router.maxDepth,
      match(path: string): number {
        return router.match(path);
      },
      lastMatchSegments(path: string): readonly { start: number; end: number; }[] {
        const idx = router.match(path);
        if (idx < 0) return [];
        const segments: { start: number; end: number; }[] = [];
        for (let i = 0; i <= router.maxDepth + 1; i++) {
          const start = router.segStart[i]!;
          const end = router.segEnd[i]!;
          if (start < 0 || end < 0) break;
          segments.push({ start, end });
        }
        return segments;
      },
    };

    return {
      compiled: true,
      routes: this.#pipelines.map((p) => p.flareRoute.route),
      pipelines: this.#pipelines.map((p) => ({
        route: p.flareRoute.route,
        score: p.flareRoute.score,
        execCount: p.execCount,
        hasCors: p.corsPolicy !== undefined,
      })),
      router: matchRouter,
      usesSharedContainer: this.#sharedContainer !== undefined,
    };
  }

  /**
   * Registers a callback to be invoked when the application starts.
   *
   * Callbacks are called in registration order during app startup.
   */
  public onStart(fn: LifecycleCallback<TLifecycle>): void {
    this.#onStartCallbacks.push(fn);
  }

  /**
   * Registers a callback to be invoked when the application stops.
   *
   * Callbacks are called in registration order during graceful shutdown.
   */
  public onStop(fn: LifecycleCallback<TLifecycle>): void {
    this.#onStopCallbacks.push(fn);
  }

  /**
   * Registers a route group under a shared path prefix.
   *
   * The builder receives a {@link HttpGroup} instance, a full {@link HttpBase} that
   * can have its own middleware, controllers, and nested groups. Registrations
   * made inside the builder are scoped to `prefix`.
   *
   * @param prefix - The path prefix applied to every route registered inside the group (e.g. `"/api/v1"`).
   * @param builder - A function that configures the group and returns a {@link GroupRegistration}.
   */
  public group(prefix: string, builder: HttpGroupFn): void {
    const group = new HttpGroup(prefix);
    const registration = builder(group);
    this.groups.push(registration);
  }

  /**
   * @internal Dispatches an inbound request through the compiled pipeline. Invoked by the
   * runtime transports, never by application code.
   *
   * Matches the request path against the router, validates the method, applies
   * HEAD-to-GET fallback, runs CORS preflight when applicable, parses route and
   * query parameters against the matched route's contract, then invokes the
   * generated exec function for that pipeline. The result is normalised into a
   * {@link ResponseLike} before being returned.
   *
   * @throws {Error} If a pipeline is found in the router but missing in the pipelines array.
   */
  public fetch(ctx: FlareHttpContext): ResponseLike | Promise<ResponseLike> {
    if (!this.#router) {
      return new FlareResponse(503, "Application not ready. Call host.build() before handling requests.");
    }

    const request = ctx.req;

    if (!isValidInboundPath(request.path)) {
      return new FlareResponse(400, INVALID_REQUEST_PATH_MESSAGE);
    }

    const idx = this.#router.match(request.path);
    if (idx === -1) {
      return new FlareResponse(404, "Not Found");
    }

    const { segStart, segEnd } = this.#router;

    const pipeline = this.#pipelines[idx];
    if (!pipeline) {
      throw new Error(
        "No pipeline found for matched route. This should never happen if the router is built correctly.",
      );
    }

    let methodIdx = METHOD_IDX_MAP[request.method as keyof typeof METHOD_IDX_MAP];
    if (methodIdx === undefined) {
      return new FlareResponse(405, "Method Not Allowed", {
        headers: { Allow: deriveAllowedMethods(pipeline.handlers) },
      });
    }

    let isHeadFallback = false;

    // HEAD: fall back to GET handler when no explicit HEAD handler is registered.
    if (request.method === "HEAD" && methodIdx !== undefined && !pipeline.handlers[methodIdx]) {
      methodIdx = METHOD_IDX_MAP["GET"];
      isHeadFallback = true;
    }

    // OPTIONS: CORS preflight takes priority, otherwise emit an auto-Allow response.
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      const acrm = request.headers.get("Access-Control-Request-Method");

      if (origin && acrm && pipeline.corsPolicy) {
        const corsPolicy = pipeline.corsPolicy;
        const allowed = checkOriginAllowed(origin, corsPolicy);
        if (allowed instanceof Promise) {
          return allowed.then((isAllowed) =>
            isAllowed ? buildCorsPreflightResponse(origin, corsPolicy) : this.#buildAllowResponse(pipeline)
          );
        }
        return allowed
          ? buildCorsPreflightResponse(origin, corsPolicy)
          : this.#buildAllowResponse(pipeline);
      }

      if (!pipeline.handlers[methodIdx]) {
        return this.#buildAllowResponse(pipeline);
      }
    }

    if (!pipeline.handlers[methodIdx]) {
      return new FlareResponse(405, "Method Not Allowed", {
        headers: { Allow: deriveAllowedMethods(pipeline.handlers) },
      });
    }

    // Resolve the effective body size limit for this route+method and store it on the
    // request so buffer() always enforces the right limit, even when called directly
    // from a handler (no body contract) or from middleware.
    const _globalMaxBodyBytes = this.host.config.host?.maxBodyBytes;
    request[SET_MAX_BODY_BYTES](pipeline.maxBodyBytes[methodIdx] ?? _globalMaxBodyBytes!);

    const path = pipeline.flareRoute.route;

    const requestDescriptor = pipeline.flareRoute.requestDescriptors[methodIdx];
    let routeParams: Record<string, number | string> | undefined;
    let queryParams: Record<string, QueryValue> | undefined;
    let bodyData: JsonValue | AsyncIterable<Uint8Array> | null | undefined;

    if (requestDescriptor) {
      const routeContract = requestDescriptor.route;
      if (routeContract) {
        try {
          routeParams = this.#extractRouteParams(
            request,
            path,
            request.path,
            segStart,
            segEnd,
            pipeline.flareRoute.segments,
            pipeline.flareRoute.paramCount,
            routeContract,
          );
        } catch (err) {
          this.host.logger.warn("Route parameter parsing failed", { error: toErrorField(err) });
          return contractRejection("Invalid route parameters. Check that your URL path matches the expected format.");
        }
      } else {
        // If no route contract provided, still need to extract raw route params for controller
        // handler to consume (e.g. for building file paths). Available under request.rawRouteParams.
        // Skip entirely for static routes: paramCount 0 means rawParams would always be {}.
        if (pipeline.flareRoute.paramCount > 0) {
          try {
            this.#extractRouteParams(
              request,
              path,
              request.path,
              segStart,
              segEnd,
              pipeline.flareRoute.segments,
              pipeline.flareRoute.paramCount,
            );
          } catch (err) {
            this.host.logger.warn("Route parameter parsing failed", { error: toErrorField(err) });
            return new FlareResponse(400, "Invalid route parameters. Check that your URL path matches the expected format.");
          }
        }
      }

      const compiledQuery = pipeline.compiledQueryPrimitives[methodIdx];
      if (compiledQuery) {
        try {
          queryParams = this.#extractQueryParams(request.url, compiledQuery);
        } catch (err) {
          this.host.logger.warn("Query parameter parsing failed", { error: toErrorField(err) });
          return contractRejection("Invalid query parameters. Check that your URL query string matches the expected format.");
        }
      }

      if (requestDescriptor.body === stream) {
        // For streaming requests, expose the same adapter-normalized iterable as ctx.req.stream().
        bodyData = request.stream();
      }
    } else {
      // If no method descriptor provided, still need to extract raw route params for controller
      // handler to consume (e.g. for building file paths). Available under request.rawRouteParams.
      // Skip entirely for static routes: paramCount 0 means rawParams would always be {}.
      if (pipeline.flareRoute.paramCount > 0) {
        try {
          this.#extractRouteParams(
            request,
            path,
            request.path,
            segStart,
            segEnd,
            pipeline.flareRoute.segments,
            pipeline.flareRoute.paramCount,
          );
        } catch (err) {
          this.host.logger.warn("Route parameter parsing failed", { error: toErrorField(err) });
          return new FlareResponse(400, "Invalid route parameters. Check that your URL path matches the expected format.");
        }
      }
    }

    // Route/query metadata must exist before before-middleware runs. Contract body parsing
    // is deferred to the generated pre-handler stage so auth can short-circuit first.
    const corsPolicy = pipeline.corsPolicy;
    const corsOrigin = corsPolicy ? request.headers.get("Origin") : null;

    ctx[SET_REQ_CTX](bodyData, routeParams, queryParams, pipeline.responseSerializers, requestDescriptor);

    const execution = this.#executePipeline(ctx, pipeline, idx, isHeadFallback, methodIdx);

    if (corsOrigin && corsPolicy) {
      return applyActualCorsHeaders(execution, corsOrigin, corsPolicy);
    }

    return execution;
  }

  #buildAllowResponse(pipeline: Pipeline): FlareResponse {
    const allowed = deriveAllowedMethods(pipeline.handlers, { includeOptions: true });
    return new FlareResponse(204, null, { headers: { Allow: allowed, "Content-Length": "0" } });
  }

  #executePipeline(
    ctx: FlareHttpContext,
    pipeline: Pipeline,
    pipelineIdx: number,
    isHeadFallback: boolean,
    methodIdx: number,
  ): ResponseLike | Promise<ResponseLike> {
    // No middleware means _getMiddleware is never called, so the cache array is never written.
    const middlewareMap: MiddlewareBase[] = pipeline.execCount === 1 ? _EMPTY_MW_CACHE : [];
    // Stamp the signed-cookie signer only when one is configured, so apps that do not use signed
    // cookies pay a single branch and nothing reaches the context.
    if (this.#cookieSigner !== undefined) ctx[COOKIE_SIGNER] = this.#cookieSigner;
    // When the context carries a per-invocation singleton map (set by a runtime/extension), build a
    // fresh container against it (never the shared one, whose singletons are module-level).
    // Otherwise use the shared container when there are no scoped services, else a fresh one.
    const instanceSingletons = ctx[INSTANCE_SINGLETONS];
    const container = instanceSingletons
      ? new Container(this.host.scopedServices, instanceSingletons, this.host.config)
      : this.#sharedContainer
        ?? new Container(this.host.scopedServices, this.host.singletonServices, this.host.config);
    const execution = this.#execFns[pipelineIdx]!(ctx, container, middlewareMap, methodIdx);

    // Shared container's instances map is always empty (all services are singletons),
    // so dispose() is always a no-op for it. Skip the call entirely.
    const needsDispose = container !== this.#sharedContainer;

    if (execution instanceof Promise) {
      return (execution as Promise<HandlerResult>).then(
        (response) => {
          if (needsDispose) {
            const dr = container.dispose();
            if (dr !== undefined) {
              return dr.then(() => {
                const normalized = normalizeHandlerResult(response, pipeline, methodIdx);
                if (isHeadFallback) {
                  return new Response(null, { status: normalized.status, headers: normalized.headers });
                }
                return normalized;
              });
            }
          }
          const normalized = normalizeHandlerResult(response, pipeline, methodIdx);
          if (isHeadFallback) return new Response(null, { status: normalized.status, headers: normalized.headers });
          return normalized;
        },
        (err) => {
          if (needsDispose) {
            const dr = container.dispose();
            if (dr !== undefined) {
              return dr.then(() => {
                throw err;
              });
            }
          }
          throw err;
        },
      );
    }

    if (needsDispose) {
      const dr = (container as Container).dispose();
      if (dr !== undefined) {
        return dr.then(() => {
          const result = normalizeHandlerResult(execution, pipeline, methodIdx);
          if (isHeadFallback) return new Response(null, { status: result.status, headers: result.headers });
          return result;
        });
      }
    }
    const result = normalizeHandlerResult(execution, pipeline, methodIdx);
    // Strip body from HEAD response (RFC 9110 §9.3.2)
    if (isHeadFallback) return new Response(null, { status: result.status, headers: result.headers });
    return result;
  }

  #extractRouteParams(
    request: FlareRequest,
    matchedPath: string,
    reqPath: string,
    valueStartIdxs: ArrayLike<number>,
    valueEndIdxs: ArrayLike<number>,
    nameSegs: RouteSegment,
    paramCount: number,
    routeContract?: Record<string, Primitive>,
  ): Record<string, number | string> | undefined {
    const rawParams: Record<string, string> = {};
    let parsedParams: Record<string, number | string> | undefined;
    if (routeContract) parsedParams = {};

    let paramsExtracted = 0;

    for (let i = 0; i < nameSegs.startIdxs.length; i++) {
      if (paramsExtracted >= paramCount) {
        break;
      }

      const vStart = valueStartIdxs[i]!;
      const vEnd = valueEndIdxs[i]!;

      const nStart = nameSegs.startIdxs[i]!;
      const nEnd = nameSegs.endIdxs[i]!;

      if (nStart >= matchedPath.length || nEnd > matchedPath.length) {
        continue;
      }

      if (matchedPath.charCodeAt(nStart) === CHAR_CODE_COLON) {
        const paramName = matchedPath.substring(nStart + 1, nEnd);
        const paramValue = decodeURIComponent(reqPath.substring(vStart, vEnd));

        rawParams[paramName] = paramValue;

        if (!routeContract || !routeContract[paramName]) {
          continue;
        }

        const primitive = routeContract[paramName]!;
        const type = primitive._type!;

        let parsedValue: number | string;
        switch (type) {
          case "string":
            parsedValue = (primitive as TypedPrimitive<string>)(paramValue);
            break;
          case "int":
            parsedValue = (primitive as TypedPrimitive<number>)(paramValue);
            break;
          default:
            throw new Error(`Unsupported FlarePrimitive type for route parameter "${paramName}": ${primitive._type}`);
        }

        parsedParams![paramName] = parsedValue;
        paramsExtracted++;
      } else if (matchedPath.charCodeAt(nStart) === CHAR_CODE_STAR) {
        const paramName = matchedPath.substring(nStart + 1, nEnd);
        const paramValue = decodeURIComponent(reqPath.substring(vStart));
        if (parsedParams) parsedParams[paramName] = paramValue;
        rawParams[paramName] = paramValue;
        paramsExtracted++;
      }
    }

    request[SET_ROUTE_PARAMS](rawParams);
    return parsedParams;
  }

  #extractQueryParams(
    url: string,
    compiled: CompiledQueryPrimitive[],
  ): Record<string, QueryValue> {
    const qi = url.indexOf("?");
    if (qi === -1) {
      if (compiled.some((c) => c.primitive._required)) {
        throw new Error(
          `Missing required query parameters: ${
            compiled
              .filter((c) => c.primitive._required)
              .map((c) => c.key)
              .join(", ")
          }`,
        );
      }
      return {};
    }

    const queryParams: Record<string, QueryValue> = {};

    for (let i = 0; i < compiled.length; i++) {
      const { key, primitive } = compiled[i]!;
      const value = this.#findQueryValue(url, qi, key);

      if (value === null) {
        if (primitive._required) {
          throw new Error(`Missing required query parameter: ${key}`);
        }
        continue;
      }

      const type = primitive._type!;
      try {
        queryParams[key] = this.#parseQuery(value, primitive);
      } catch (err) {
        throw new Error(
          `Failed to parse query parameter '${key}' with value '${value}' as type '${type}': ${(err as Error).message}`,
        );
      }
    }

    return queryParams;
  }

  #parseQuery(
    value: string | string[],
    primitive: Primitive,
  ): QueryValue {
    const type = primitive._type!;
    switch (type) {
      case "string":
        this.#assertSingleValue(value);
        return (primitive as TypedPrimitive<string>)(value);
      case "int":
        this.#assertSingleValue(value);
        return (primitive as TypedPrimitive<number>)(value);
      case "bool":
        this.#assertSingleValue(value);
        return (primitive as TypedPrimitive<boolean>)(value);
      case "date":
        this.#assertSingleValue(value);
        return (primitive as TypedPrimitive<Date>)(value);
      case "array<string>":
        return (primitive as ArrayTypedPrimitive<string>)(value);
      case "array<int>":
        return (primitive as ArrayTypedPrimitive<number>)(value);
      case "array<bool>":
        return (primitive as ArrayTypedPrimitive<boolean>)(value);
      case "array<date>":
        return (primitive as ArrayTypedPrimitive<Date>)(value);
      default:
        throw new Error(`Unsupported FlarePrimitive type for query parameter: ${primitive._type}`);
    }
  }

  #assertSingleValue(value: string | string[]): asserts value is string {
    if (Array.isArray(value)) {
      throw new Error(`Expected single value but got multiple: ${value.join(", ")}`);
    }
  }
  /**
   * Scans the raw URL query string for a specific key and returns its value,
   * or null if the key is not present. Avoids constructing a URLSearchParams.
   * Query keys are matched literally against the contract key; only values are
   * decoded after a key match.
   */
  #findQueryValue(url: string, qi: number, key: string): string | string[] | null {
    const keyLen = key.length;
    let pos = qi + 1;
    const end = url.length;

    const results: string[] = [];

    while (pos < end) {
      // Check if key matches at this position (must follow ? or &)
      if (pos + keyLen < end && url.charCodeAt(pos + keyLen) === 61 /* = */) {
        let match = true;
        for (let k = 0; k < keyLen; k++) {
          if (url.charCodeAt(pos + k) !== key.charCodeAt(k)) {
            match = false;
            break;
          }
        }
        if (match) {
          const valueStart = pos + keyLen + 1;
          let valueEnd = valueStart;
          while (valueEnd < end && url.charCodeAt(valueEnd) !== 38 /* & */) valueEnd++;
          const raw = url.slice(valueStart, valueEnd);
          // Fast path: skip decoding when value contains no encoded characters
          if (raw.indexOf("%") === -1 && raw.indexOf("+") === -1) {
            results.push(raw);
          } else {
            results.push(decodeURIComponent(raw.replace(/\+/g, " ")));
          }
        }
      }
      // Advance to next parameter
      while (pos < end && url.charCodeAt(pos) !== 38 /* & */) pos++;
      pos++;
    }

    if (results.length === 0) return null;
    if (results.length === 1) return results[0]!;
    return results;
  }
}

/**
 * 400 carrying the contract-failure `{ error }` envelope, serialized at
 * construction: these returns exit fetch before the pipeline, so nothing
 * downstream runs `normalizeHandlerResult` for them.
 */
function contractRejection(message: string): FlareResponse {
  const response = new FlareResponse(400, { error: message });
  response[FINALIZE_JSON_BODY](JSON.stringify({ error: message }));
  return response;
}
