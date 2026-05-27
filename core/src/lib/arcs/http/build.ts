import { compileSerializer } from "@flare-ts/lib/schema";
import type { MiddlewareBase } from "./composition/classes/middleware-base.js";
import type { RequestDescriptor } from "./composition/contract/flare-contract.js";
import type { CorsConfig } from "./composition/types/cors.js";
import type { FlareRouter } from "./routing/flare-router.js";
import type { ControllerHandler, Route, RouteSegment } from "./routing/types/route.js";
import type { StateToken } from "./state/types/state-token.js";
import type { ResponseSerializers, Serializer } from "./transport/types/response.js";
import type { ExecFn } from "./types/exec-fn.js";
import type { CompiledQueryPrimitive, FlareHttpFactory, Pipeline } from "./types/pipeline.js";
import type {
  ControllerRegistration,
  ErrorHandlerRegistration,
  GroupRegistration,
  MiddlewareRegistration,
} from "./types/registration.js";
import { CONTRACT_BRAND } from "./composition/contract/flare-contract.js";
import { compileCorsPolicy } from "./composition/cors.js";
import { compileExecFn } from "./exec-codegen.js";
import { CHAR_CODE_COLON, CHAR_CODE_SLASH, CHAR_CODE_STAR } from "./http-arc.js";
import { buildFlareRouter, splitPath } from "./routing/flare-router.js";
import { joinRoutePath } from "./routing/path.js";
import { _getRoutes } from "./routing/route-store.js";
import { METHOD_IDX_MAP, SUPPORTED_METHODS } from "./routing/types/methods.js";

/**
 * Compiles HTTP arc and group registrations into the runtime structures the
 * request pipeline needs: middleware factory arrays, per-route pipelines sorted
 * by specificity, a {@link FlareRouter} over the route paths, and a per-pipeline
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
): { middleware: FlareHttpFactory<MiddlewareBase>[]; pipelines: Pipeline[]; router: FlareRouter; execFns: ExecFn[]; } {
  const middleware = compileMiddleware(mwRegistrations);
  const pipelines = compilePipelines(ctrlRegistrations, mwRegistrations, globalErrorHandlers, groups, arcCorsConfig);

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

  const router = buildFlareRouter(routes, maxDepth);
  return { middleware, pipelines, router, execFns };
}

function compilePipelines(
  controllers: ControllerRegistration[],
  middleware: MiddlewareRegistration[],
  globalErrorHandlers: ErrorHandlerRegistration[],
  groups: GroupRegistration[],
  arcCorsConfig?: CorsConfig,
): Pipeline[] {
  const pipelines: Pipeline[] = [];

  for (let i = 0; i < controllers.length; i++) {
    const registration = controllers[i]!;
    const { beforeFactoryIdxs, afterFactoryIdxs, finallyFactoryIdxs } = getMiddlewareIdxs(registration, middleware);
    const execCount = beforeFactoryIdxs.length + 1 + afterFactoryIdxs.length + finallyFactoryIdxs.length;
    const middlewareFactoryByExecIdx = new Int32Array(execCount);

    middlewareFactoryByExecIdx.set(beforeFactoryIdxs, 0);
    middlewareFactoryByExecIdx[beforeFactoryIdxs.length] = -1;
    middlewareFactoryByExecIdx.set(afterFactoryIdxs, beforeFactoryIdxs.length + 1);
    middlewareFactoryByExecIdx.set(finallyFactoryIdxs, beforeFactoryIdxs.length + 1 + afterFactoryIdxs.length);

    const errorHandlers = registration.groupErrorHandlers.length > 0
      ? [...globalErrorHandlers, ...registration.groupErrorHandlers]
      : globalErrorHandlers;

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
 * Builds a human-readable name for every exec-index slot in the pipeline.
 * Index where factoryIdx === -1 is the handler slot; the name is the controller class name.
 * Other indices resolve to the middleware class name via the appropriate registration array.
 */
function compileExecStepNames(pipeline: Pipeline, globalMwRegs: MiddlewareRegistration[]): string[] {
  const names = new Array<string>(pipeline.execCount);
  for (let i = 0; i < pipeline.execCount; i++) {
    const factoryIdx = pipeline.middlewareFactoryByExecIdx[i]!;
    if (factoryIdx < 0) {
      names[i] = pipeline.registration.cls.name;
      continue;
    }
    if (pipeline.registration.groupIsolated) {
      names[i] = pipeline.registration.groupMiddleware?.[factoryIdx]?.cls.name ?? "Unknown";
    } else if (factoryIdx >= globalMwRegs.length && pipeline.registration.combinedGroupMw) {
      const groupIdx = factoryIdx - globalMwRegs.length;
      names[i] = pipeline.registration.combinedGroupMw[groupIdx]?.cls.name ?? "Unknown";
    } else {
      names[i] = globalMwRegs[factoryIdx]?.cls.name ?? "Unknown";
    }
  }
  return names;
}

function compileMiddleware(middlewareRegistrations: MiddlewareRegistration[]): FlareHttpFactory<MiddlewareBase>[] {
  const middleware: FlareHttpFactory<MiddlewareBase>[] = Array(middlewareRegistrations.length);

  for (let i = 0; i < middlewareRegistrations.length; i++) {
    middleware[i] = middlewareRegistrations[i]!.factory;
  }

  return middleware;
}

function getMiddlewareIdxs(
  controller: ControllerRegistration,
  middleware: MiddlewareRegistration[],
): {
  beforeFactoryIdxs: number[];
  afterFactoryIdxs: number[];
  finallyFactoryIdxs: number[];
} {
  if (controller.standalone) {
    return { beforeFactoryIdxs: [], afterFactoryIdxs: [], finallyFactoryIdxs: [] };
  }

  const beforeFactoryIdxs: number[] = [];
  const afterFactoryIdxs: number[] = [];
  const finallyFactoryIdxs: number[] = [];
  const providedStateTokens: Map<StateToken, string> = new Map();
  const providedBefore: Map<StateToken, string> = new Map();

  if (controller.groupMiddleware) {
    if (controller.groupIsolated) {
      for (let idx = 0; idx < controller.groupMiddleware.length; idx++) {
        processMwRegistration(
          controller.groupMiddleware[idx]!,
          idx,
          beforeFactoryIdxs,
          afterFactoryIdxs,
          finallyFactoryIdxs,
          providedStateTokens,
          providedBefore,
        );
      }
    } else {
      const excludeSet = new Set(controller.groupExcludeList);

      // Validate all excluded classes are actually in the global middleware list.
      for (const excludedCls of excludeSet) {
        const found = middleware.some((reg) => reg.cls === excludedCls);
        if (!found) {
          throw new Error(
            `[flare] Group tried to exclude middleware "${excludedCls.name}" but it is not registered in the global middleware chain.`,
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
      const combinedGroupMw = [...controller.groupReplacements, ...controller.groupMiddleware];
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

  verifyProvidedState(controller.cls.state, providedBefore, controller.cls.name);

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
    throw new Error(
      `Middleware ${name} must implement at least one of the before(), after(), or finally() lifecycle hooks.`,
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
        throw new Error(
          `Duplicate state token provided by middleware ${name}: ${token.name} already provided by middleware ${providerName}. Each state token can only be provided by one middleware in the chain.`,
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
      throw new Error(
        `${consumerName} requires state token ${token.name} that is not provided by any preceding middleware. Please ensure that a preceding middleware in the chain provides this state token.`,
      );
    }
  }
}

function compileRoutes(controller: ControllerRegistration): Route[] {
  const routeMetadata = _getRoutes(controller.cls);
  if (routeMetadata.length === 0) {
    throw new Error(`Controller ${controller.cls.name} has no route handlers. Add at least one decorated method.`);
  }

  const routeMap: Map<string, Route> = new Map();

  for (const route of routeMetadata) {
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
        throw new Error(
          `Duplicate route registration for ${route.method} ${fullPath}. Each route can only have one handler per HTTP method.`,
        );
      }

      handlers = existingRoute.handlers;
      requestDescriptors = existingRoute.requestDescriptors;
    }

    handlers[methodIdx] = route.handler;

    let requestDescriptor: RequestDescriptor | undefined = undefined;
    const contract = controller.cls.contract;
    if (contract && contract[CONTRACT_BRAND]) {
      requestDescriptor = (contract as Record<string, RequestDescriptor>)[route.handler.name];
    }

    Object.entries(requestDescriptor?.route || {}).forEach(([key, value]) => {
      if (value._type === "float") {
        throw new Error(
          `Handler ${route.handler.name} defines a route parameter "${key}" with unsupported type "float". Route parameters can only be string or integer primitives.`,
        );
      }
    });

    requestDescriptors[methodIdx] = requestDescriptor;

    routeMap.set(fullPath, {
      route: fullPath,
      handlers,
      requestDescriptors,
      score: scoreRoute(fullPath),
      controllerRef: controller.cls,
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

function scoreRoute(path: string): number {
  let score = 0;
  const segments = path.split("/").filter(Boolean);

  for (const segment of segments) {
    if (segment.startsWith("*")) {
      continue;
    }

    if (segment.startsWith(":")) {
      score += 1;
    } else {
      score += 2;
    }
  }

  return score;
}
