/**
 * Compiles registered controllers and middleware into sorted pipelines, the router, and per-route exec functions.
 */
import { compileSerializer } from "@flare-ts/lib/schema";
import type { FlareErrorClass } from "../../errors/types.js";
import type { Router } from "../../routing/router.js";
import type { StateToken } from "../../state/flare-state.js";
import type { MiddlewareBase } from "./composition/classes/middleware-base.js";
import type { RequestDescriptor } from "./composition/contract/http-contract.js";
import type { CorsConfig } from "./composition/types/cors.js";
import type { ControllerHandler, Route, RouteSegment } from "./routing/types/route.js";
import type { ResponseSerializers, Serializer } from "./transport/types/response.js";
import type { ExecFn } from "./types/exec-fn.js";
import type { CompiledQueryPrimitive, HttpFactory, Pipeline } from "./types/pipeline.js";
import type {
  ControllerRegistration,
  ErrorHandlerRegistration,
  GroupRegistration,
  MiddlewareRegistration,
} from "./types/registration.js";
import { buildRouter, scoreRoute, splitPath } from "../../routing/router.js";
import { FlareValidationError } from "../../validation/flare-validation-error.js";
import { compileCorsPolicy } from "./cors.js";
import { compileExecFn } from "./exec-codegen.js";
import { CHAR_CODE_COLON, CHAR_CODE_SLASH, CHAR_CODE_STAR } from "./http-arc.js";
import { joinRoutePath } from "./routing/path.js";
import { METHOD_IDX_MAP, SUPPORTED_METHODS } from "./routing/types/methods.js";

/**
 * Compiles HTTP arc and group registrations into the runtime structures the
 * request pipeline needs: middleware factory arrays, per-route pipelines sorted
 * by specificity, a {@link Router} over the route paths, and a per-pipeline
 * exec function.
 *
 * @internal
 */
export function compileHttp(
  ctrlRegistrations: ControllerRegistration[],
  mwRegistrations: MiddlewareRegistration[],
  globalErrorHandlers: ErrorHandlerRegistration[] = [],
  groups: GroupRegistration[] = [],
  arcCorsConfig?: CorsConfig,
  providedAtEntry: readonly StateToken[] = [],
  errorObservers: readonly ErrorHandlerRegistration[] = [],
): { middleware: HttpFactory<MiddlewareBase>[]; pipelines: Pipeline[]; router: Router; execFns: ExecFn[]; } {
  const middleware = compileMiddleware(mwRegistrations);
  const pipelines = compilePipelines(
    ctrlRegistrations,
    mwRegistrations,
    globalErrorHandlers,
    groups,
    arcCorsConfig,
    providedAtEntry,
    errorObservers,
  );

  pipelines.sort((a, b) => b.flareRoute.score - a.flareRoute.score);

  let maxDepth = 0;
  let routes: string[] = [];

  const execFns: ExecFn[] = [];

  for (const pipeline of pipelines) {
    const route = pipeline.flareRoute.route;
    routes.push(route);
    maxDepth = Math.max(maxDepth, splitPath(route).length);

    const names = compileExecStepNames(pipeline, mwRegistrations);
    execFns.push(compileExecFn(pipeline, middleware, names, mwRegistrations));
  }

  const router = buildRouter(routes, maxDepth);
  return { middleware, pipelines, router, execFns };
}

/**
 * Returns the middleware at one exec slot of a compiled pipeline, or undefined at the handler slot.
 *
 * `kind` says when the middleware runs relative to the handler; `from` says whether it was registered
 * globally or on the pipeline's group.
 */
export function resolveStepMiddleware(
  pipeline: Pipeline,
  globalMwRegs: readonly MiddlewareRegistration[],
  execIdx: number,
): {
  readonly kind: "before" | "after" | "finally";
  readonly registration: MiddlewareRegistration;
  readonly from: "global" | "group";
} | undefined {
  const factoryIdx = pipeline.middlewareFactoryByExecIdx[execIdx]!;
  if (factoryIdx < 0) return undefined;
  const group = pipeline.registration.group;
  let registration: MiddlewareRegistration | undefined;
  let from: "global" | "group" = "group";
  if (group?.isolated) {
    registration = group.middleware[factoryIdx];
  } else if (factoryIdx >= globalMwRegs.length && group?.combinedMw) {
    registration = group.combinedMw[factoryIdx - globalMwRegs.length];
  } else {
    registration = globalMwRegs[factoryIdx];
    from = "global";
  }
  if (!registration) return undefined;
  let kind: "before" | "after" | "finally" = "finally";
  if (execIdx < pipeline.handlerExecIdx) kind = "before";
  else if (execIdx < pipeline.execCount - pipeline.finallyCount) kind = "after";
  return { kind, registration, from };
}

function compilePipelines(
  controllers: ControllerRegistration[],
  middleware: MiddlewareRegistration[],
  globalErrorHandlers: ErrorHandlerRegistration[],
  groups: GroupRegistration[],
  arcCorsConfig?: CorsConfig,
  providedAtEntry: readonly StateToken[] = [],
  errorObservers: readonly ErrorHandlerRegistration[] = [],
): Pipeline[] {
  const pipelines: Pipeline[] = [];
  const orderedGlobalErrorHandlers = orderErrorHandlers(globalErrorHandlers);

  for (let i = 0; i < controllers.length; i++) {
    const registration = controllers[i]!;
    const { beforeFactoryIdxs, afterFactoryIdxs, finallyFactoryIdxs } = getMiddlewareIdxs(
      registration,
      middleware,
      providedAtEntry,
    );
    const execCount = beforeFactoryIdxs.length + 1 + afterFactoryIdxs.length + finallyFactoryIdxs.length;
    const middlewareFactoryByExecIdx = new Int32Array(execCount);

    middlewareFactoryByExecIdx.set(beforeFactoryIdxs, 0);
    middlewareFactoryByExecIdx[beforeFactoryIdxs.length] = -1;
    middlewareFactoryByExecIdx.set(afterFactoryIdxs, beforeFactoryIdxs.length + 1);
    middlewareFactoryByExecIdx.set(finallyFactoryIdxs, beforeFactoryIdxs.length + 1 + afterFactoryIdxs.length);

    const groupErrorHandlers = registration.group?.errorHandlers ?? [];
    const scopedErrorHandlers = groupErrorHandlers.length > 0
      ? [...orderedGlobalErrorHandlers, ...orderErrorHandlers(groupErrorHandlers)]
      : orderedGlobalErrorHandlers;
    // Observers (the prebuilt test suite's) see every error first and never answer it.
    const errorHandlers = errorObservers.length > 0
      ? [...errorObservers, ...scopedErrorHandlers]
      : scopedErrorHandlers;

    const routes = compileRoutes(registration);
    const effectiveCors = groups.find((g) => g.controllers.includes(registration))?.corsConfig ?? arcCorsConfig;

    for (let routeIdx = 0; routeIdx < routes.length; routeIdx++) {
      const route = routes[routeIdx]!;
      const serializers = compileResponseSerializers(route.requestDescriptors);
      const compiledQueryPrimitives = compileQueryPrimitives(route.requestDescriptors);
      const maxBodyBytes = route.requestDescriptors.map((d) => d?.maxBodyBytes);
      const corsPolicy = effectiveCors ? compileCorsPolicy(effectiveCors, route.handlers) : undefined;
      pipelines.push({
        registration,
        flareRoute: route,
        handlers: route.handlers,
        execCount,
        handlerExecIdx: beforeFactoryIdxs.length,
        middlewareFactoryByExecIdx,
        finallyCount: finallyFactoryIdxs.length,
        responseSerializers: serializers,
        compiledQueryPrimitives,
        errorHandlers,
        maxBodyBytes,
        corsPolicy,
      });
    }
  }

  return pipelines;
}

/**
 * Names every exec slot in the pipeline.
 *
 * The handler slot takes the registration's name; every other slot takes its middleware's class name.
 */
function compileExecStepNames(pipeline: Pipeline, globalMwRegs: MiddlewareRegistration[]): string[] {
  const names = new Array<string>(pipeline.execCount);
  for (let i = 0; i < pipeline.execCount; i++) {
    names[i] = pipeline.middlewareFactoryByExecIdx[i]! < 0
      ? pipeline.registration.name
      : resolveStepMiddleware(pipeline, globalMwRegs, i)?.registration.cls.name ?? "Unknown";
  }
  return names;
}

function compileMiddleware(middlewareRegistrations: MiddlewareRegistration[]): HttpFactory<MiddlewareBase>[] {
  const middleware: HttpFactory<MiddlewareBase>[] = Array(middlewareRegistrations.length);

  for (let i = 0; i < middlewareRegistrations.length; i++) {
    middleware[i] = middlewareRegistrations[i]!.factory;
  }

  return middleware;
}

function getMiddlewareIdxs(
  controller: ControllerRegistration,
  middleware: MiddlewareRegistration[],
  providedAtEntry: readonly StateToken[],
): {
  beforeFactoryIdxs: number[];
  afterFactoryIdxs: number[];
  finallyFactoryIdxs: number[];
} {
  if (controller.isolated) {
    return { beforeFactoryIdxs: [], afterFactoryIdxs: [], finallyFactoryIdxs: [] };
  }

  const beforeFactoryIdxs: number[] = [];
  const afterFactoryIdxs: number[] = [];
  const finallyFactoryIdxs: number[] = [];
  const providedStateTokens: Map<StateToken, string> = new Map();
  const providedBefore: Map<StateToken, string> = new Map();

  // Seed tokens provided at arc entry (an opaque, caller-supplied token list). The Cloudflare
  // adapter uses this to mark a Durable Object's `static state` tokens as available to consumers
  // before any middleware runs, so a DO route consuming a forwarded token validates clean. This
  // file carries no DO/CF semantics: it only treats these as already-provided state.
  for (const token of providedAtEntry) {
    providedBefore.set(token, "(arc entry)");
    providedStateTokens.set(token, "(arc entry)");
  }

  if (controller.group) {
    const group = controller.group;
    if (group.isolated) {
      for (let idx = 0; idx < group.middleware.length; idx++) {
        processMwRegistration(
          group.middleware[idx]!,
          idx,
          beforeFactoryIdxs,
          afterFactoryIdxs,
          finallyFactoryIdxs,
          providedStateTokens,
          providedBefore,
        );
      }
    } else {
      const excludeSet = new Set(group.excludeList);

      // Validate all excluded classes are actually in the global middleware list.
      for (const excludedCls of excludeSet) {
        const found = middleware.some((reg) => reg.cls === excludedCls);
        if (!found) {
          throw compileError(
            "GROUP_UNREGISTERED_EXCLUDE",
            `Group tried to exclude middleware "${excludedCls.name}" but it is not registered in the global middleware chain.`,
            `Register ${excludedCls.name} with host.http.use(), or remove it from the group's exclude() list.`,
          );
        }
      }

      for (let idx = 0; idx < middleware.length; idx++) {
        const reg = middleware[idx]!;
        if (excludeSet.has(reg.cls)) continue; // skip excluded
        processMwRegistration(
          reg,
          idx,
          beforeFactoryIdxs,
          afterFactoryIdxs,
          finallyFactoryIdxs,
          providedStateTokens,
          providedBefore,
        );
      }

      // Prepend replacements then group-local middleware.
      const combinedGroupMw = [...group.replacements, ...group.middleware];
      for (let idx = 0; idx < combinedGroupMw.length; idx++) {
        processMwRegistration(
          combinedGroupMw[idx]!,
          middleware.length + idx,
          beforeFactoryIdxs,
          afterFactoryIdxs,
          finallyFactoryIdxs,
          providedStateTokens,
          providedBefore,
        );
      }
    }
  } else {
    for (let idx = 0; idx < middleware.length; idx++) {
      processMwRegistration(
        middleware[idx]!,
        idx,
        beforeFactoryIdxs,
        afterFactoryIdxs,
        finallyFactoryIdxs,
        providedStateTokens,
        providedBefore,
      );
    }
  }

  verifyProvidedState(controller.state, providedBefore, controller.name);

  return { beforeFactoryIdxs, afterFactoryIdxs, finallyFactoryIdxs };
}

function processMwRegistration(
  registration: MiddlewareRegistration,
  idx: number,
  beforeFactoryIdxs: number[],
  afterFactoryIdxs: number[],
  finallyFactoryIdxs: number[],
  providedStateTokens: Map<StateToken, string>,
  providedBefore: Map<StateToken, string>,
): void {
  const cls = registration.cls;
  const name = cls.name;
  const before = cls.prototype.before;
  const after = cls.prototype.after;
  const fin = cls.prototype.finally;

  if (!before && !after && !fin) {
    throw compileError(
      "MIDDLEWARE_NO_HOOKS",
      `Middleware ${name} must implement at least one of before(), after(), or finally().`,
      `Add a before(), after(), or finally() method to ${name}, or stop registering it.`,
    );
  }

  if (before) {
    beforeFactoryIdxs.push(idx);
    verifyProvidedState(cls.state, providedBefore, name);

    if (cls.provides) {
      for (const token of cls.provides) {
        providedBefore.set(token, name);
      }
    }
  }

  if (after) {
    afterFactoryIdxs.push(idx);
  }

  if (fin) {
    // LIFO: prepend to finallyFactoryIdxs so the last-registered middleware runs first.
    finallyFactoryIdxs.unshift(idx);
  }

  verifyProvidedState(cls.state, providedStateTokens, name);

  if (cls.provides) {
    for (const token of cls.provides) {
      const providerName = providedStateTokens.get(token);
      if (providerName) {
        throw compileError(
          "DUPLICATE_STATE_PROVIDER",
          `Duplicate state token provided by middleware ${name}: ${token.name} already provided by middleware ${providerName}.`,
          `Each state token can only be provided by one middleware in the chain. Remove ${token.name} from the provides of ${name} or ${providerName}.`,
        );
      }
      providedStateTokens.set(token, name);
    }
  }
}

function verifyProvidedState(
  state: readonly StateToken[],
  providedState: Map<StateToken, string>,
  consumerName: string,
): void {
  for (const token of state) {
    if (!providedState.has(token)) {
      throw compileError(
        "STATE_NOT_PROVIDED",
        `${consumerName} requires state token ${token.name} that is not provided by any preceding middleware.`,
        `Register a middleware that lists ${token.name} in its static provides and runs before ${consumerName}.`,
      );
    }
  }
}

/**
 * A build error found while compiling, which needs the resolved middleware chain or routes and so
 * cannot run in the validation pass; the host reports it the same way.
 */
function compileError(code: string, message: string, hint: string): FlareValidationError {
  return new FlareValidationError([{ severity: "error", code, message, hint }]);
}

function compileRoutes(controller: ControllerRegistration): Route[] {
  if (controller.routes.length === 0) {
    throw compileError(
      "CONTROLLER_NO_ROUTES",
      `Controller ${controller.name} has no route handlers.`,
      "Add at least one decorated method.",
    );
  }

  const routeMap: Map<string, Route> = new Map();

  for (const route of controller.routes) {
    const fullPath = joinRoutePath(controller.path, route.path);
    const length = fullPath.length;

    const segStart: number[] = [];
    const segEnd: number[] = [];
    let paramCount = 0;

    for (let i = 0; i < length; i++) {
      if (i === 0) {
        segStart.push(i + 1);
        continue;
      }

      if (fullPath.charCodeAt(i) === CHAR_CODE_SLASH) {
        segEnd.push(i);
        segStart.push(i + 1);
      }

      if (fullPath.charCodeAt(i) === CHAR_CODE_COLON) {
        paramCount++;
      }

      if (fullPath.charCodeAt(i) === CHAR_CODE_STAR) {
        paramCount++;
      }

      if (i === length - 1) {
        segEnd.push(i + 1);
      }
    }

    const segments: RouteSegment = {
      startIdxs: Int16Array.from(segStart),
      endIdxs: Int16Array.from(segEnd),
    };

    let handlers: ControllerHandler[] = Array(SUPPORTED_METHODS.length);
    let requestDescriptors: Array<RequestDescriptor | undefined> = Array(SUPPORTED_METHODS.length);

    const methodIdx = METHOD_IDX_MAP[route.method as keyof typeof METHOD_IDX_MAP];
    const existingRoute = routeMap.get(fullPath);

    if (existingRoute) {
      if (existingRoute.handlers[methodIdx]) {
        throw compileError(
          "DUPLICATE_ROUTE_METHOD",
          `Duplicate route registration for ${route.method} ${fullPath}.`,
          "Each route can only have one handler per HTTP method.",
        );
      }

      handlers = existingRoute.handlers;
      requestDescriptors = existingRoute.requestDescriptors;
    }

    handlers[methodIdx] = route.handler;

    const requestDescriptor = route.descriptor;

    Object.entries(requestDescriptor?.route || {}).forEach(([key, value]) => {
      if (value._type === "float") {
        throw compileError(
          "ROUTE_PARAM_UNSUPPORTED_TYPE",
          `Handler ${route.handler.name} defines a route parameter "${key}" with unsupported type "float".`,
          "Route parameters can only be string or integer primitives.",
        );
      }
    });

    requestDescriptors[methodIdx] = requestDescriptor;

    routeMap.set(fullPath, {
      route: fullPath,
      handlers,
      requestDescriptors,
      score: scoreRoute(fullPath),
      segments,
      paramCount,
    });
  }

  return [...routeMap.values()];
}

function compileQueryPrimitives(
  requestDescriptors: Array<RequestDescriptor | undefined>,
): Array<CompiledQueryPrimitive[] | undefined> {
  const result: Array<CompiledQueryPrimitive[] | undefined> = new Array(requestDescriptors.length);
  for (let i = 0; i < requestDescriptors.length; i++) {
    const md = requestDescriptors[i];
    if (!md?.query) {
      result[i] = undefined;
      continue;
    }
    const entries = Object.entries(md.query);
    const compiled: CompiledQueryPrimitive[] = new Array(entries.length);
    for (let j = 0; j < entries.length; j++) {
      compiled[j] = { key: entries[j]![0], primitive: entries[j]![1] };
    }
    result[i] = compiled;
  }
  return result;
}

function compileResponseSerializers(
  requestDescriptors: Array<RequestDescriptor | undefined>,
): ResponseSerializers | undefined {
  // Sparse array: index = methodIdx, value = { [status]: Serializer } or
  // undefined when that method declared no response schemas. Numeric keys
  // throughout — avoids per-request string concat on the response hot path
  // (was `${methodIdx}:${status}` lookup in the prior version).
  const serializers: ResponseSerializers = new Array(requestDescriptors.length);
  let hasAny = false;

  for (let i = 0; i < requestDescriptors.length; i++) {
    const md = requestDescriptors[i];
    if (!md?.response) continue;

    let perStatus: Record<number, Serializer> | undefined;
    for (const [statusStr, schema] of Object.entries(md.response)) {
      const status = Number(statusStr);
      const serializer = compileSerializer(schema!);
      if (serializer) {
        if (perStatus === undefined) perStatus = {};
        perStatus[status] = serializer;
        hasAny = true;
      }
    }
    if (perStatus !== undefined) serializers[i] = perStatus;
  }

  return hasAny ? serializers : undefined;
}

// Within one scope, keyed handlers run first, the most specific key first (a subclass before the class it
// extends), then catch-alls; ties keep registration order. Dispatch skips a keyed handler the error is not
// an instance of, so the first keyed handler that runs is the one closest to the error's own class.
function orderErrorHandlers(handlers: readonly ErrorHandlerRegistration[]): ErrorHandlerRegistration[] {
  const depthOf = (errorClass: FlareErrorClass): number => {
    let depth = 0;
    for (let cls = Object.getPrototypeOf(errorClass); cls !== null; cls = Object.getPrototypeOf(cls)) depth++;
    return depth;
  };
  const keyed = handlers.filter((handler) => handler.errorClass !== undefined);
  keyed.sort((a, b) => depthOf(b.errorClass!) - depthOf(a.errorClass!));
  return [...keyed, ...handlers.filter((handler) => handler.errorClass === undefined)];
}
