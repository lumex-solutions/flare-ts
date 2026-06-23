import type { JsonObject } from "@flare-ts/lib";
import type { HttpArc } from "../../../arcs/http/http-arc.js";
import type { ControllerRegistration, MiddlewareRegistration } from "../../../arcs/http/types/registration.js";
import type { ConfigToken, OpaqueConfigToken } from "../../../config/flare-config.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { ServiceRegistration } from "../../../services/types/registration.js";
import type { ServiceToken } from "../../../services/types/types.js";
import type {
  ConfigValidationContext,
  HttpValidationContext,
  ServiceValidationContext,
} from "../../../validation/contexts.js";
import type { ValidationError } from "../../../validation/types.js";
import type { FlareDurableObjectClass } from "./durable-object.js";
import { COMPILE_HTTP_ARC } from "../../../arcs/http/http-arc.js";
import { createConfigValidator } from "../../../validation/validators/config-composite-validator.js";
import { createHttpValidator } from "../../../validation/validators/http-composite-validator.js";
import { CaptiveDependencyValidator } from "../../../validation/validators/service/captive-dep-validator.js";
import { DependencyValidator } from "../../../validation/validators/service/dependency-validator.js";
import { LifecycleHookValidator } from "../../../validation/validators/service/lifecycle-hook-validator.js";
import { ServiceRegistrationValidator } from "../../../validation/validators/service/service-registration-validator.js";
import { Bindings, DurableState } from "./services.js";
import { staticStateTokens } from "./state-crossing.js";

/** Read-only graph the adapter hands the validator: the front door arc, the per-DO arcs, the DOs, services. */
export interface CfValidationGraph {
  /** The shared front-door arc (host.http). */
  readonly frontDoor: HttpArc<"sync">;
  /** Each registered DO class paired with its per-DO arc. */
  readonly durables: ReadonlyArray<{ readonly cls: FlareDurableObjectClass; readonly arc: HttpArc<"sync">; }>;
  /** All registered scoped service registrations. */
  readonly scoped: ServiceRegistration<FlareService>[];
  /** All registered singleton service registrations. */
  readonly singletons: ServiceRegistration<FlareService>[];
  /** Framework prebuilt tokens placed directly into singletonInstances (e.g. Logger). */
  readonly prebuiltTokens: ReadonlySet<ServiceToken<FlareService>>;
  /** Config tokens registered on the host (from buildCtx). */
  readonly configRegistrations: ReadonlySet<OpaqueConfigToken>;
  /** Built-in config tokens exempt from field-presence checks (HOST_CONFIG, LOG_CONFIG). */
  readonly defaultConfigTokens: ReadonlySet<OpaqueConfigToken>;
  /** The fully resolved config object. */
  readonly resolvedConfig: Readonly<JsonObject>;
}

/**
 * Compiles each per-DO arc after validation (the host only compiles host.http).
 *
 * DO-consume seam: each DO's `static state` tokens are passed to the per-arc compile as
 * "provided at arc entry", so a DO route consuming a forwarded token validates clean while a route
 * consuming a token neither in `static state` nor DO-locally provided still errors. This is the
 * adapter-driven half of the seam; the generic arc treats them as opaque already-provided state.
 *
 * Errors thrown during DO arc compilation are re-thrown with the DO class name prepended so the
 * error message is anchored to the specific Durable Object (spec section 7).
 */
export function compileDurableArcs(graph: CfValidationGraph): void {
  for (const { cls, arc } of graph.durables) {
    try {
      arc[COMPILE_HTTP_ARC](staticStateTokens(cls));
    } catch (err) {
      const base = err instanceof Error ? err.message : String(err);
      throw new Error(`[${cls.name}] ${base}`);
    }
  }
}

/**
 * Runs the FULL Cloudflare build-time validation at the correct granularity:
 * - HTTP per arc: the front-door arc (Worker context) and each per-DO arc (DO context).
 * - Service-graph integrity (DependencyValidator, CaptiveDependencyValidator, LifecycleHookValidator)
 *   ONCE globally, with the full framework set { Bindings, DurableState } in prebuiltTokens, so a
 *   DurableState-dependent service used only by a DO still passes the "is it known" check.
 * - Route inject deps (ServiceRegistrationValidator) PER arc, with that arc's framework tokens, so a
 *   front-door route injecting DurableState fails while a per-DO route injecting it passes.
 * - Service-graph reachability, DO static-dep check, and config validation (once).
 * Returns aggregated errors AND warnings; the caller throws on errors. Validation works off
 * registrations (pre-compile), exactly like the host suite.
 *
 * Graph-integrity validators (DependencyValidator, CaptiveDependencyValidator, LifecycleHookValidator)
 * run once globally because they inspect the whole service set; ServiceRegistrationValidator runs per
 * arc because it must see that arc's specific framework tokens.
 */
export function validateCfGraph(graph: CfValidationGraph): ValidationError[] {
  const workerTokens = new Set<ServiceToken<FlareService>>([Bindings]);
  const doTokens = new Set<ServiceToken<FlareService>>([Bindings, DurableState]);
  const results: ValidationError[] = [];

  // HTTP per arc: front door (Worker context) + each per-DO arc (DO context).
  results.push(...createHttpValidator().validate(httpCtx(graph.frontDoor)));
  for (const { arc } of graph.durables) {
    results.push(...createHttpValidator().validate(httpCtx(arc)));
  }

  // Service-graph integrity ONCE globally with the full framework set. These validators iterate the
  // whole service set, so they must see { Bindings, DurableState } and the whole-app controllers +
  // middleware. (ServiceRegistrationValidator is NOT run here; it is per arc below.)
  const allControllers = [
    ...arcControllers(graph.frontDoor),
    ...graph.durables.flatMap((d) => arcControllers(d.arc)),
  ];
  const allMiddleware = [
    ...arcMiddleware(graph.frontDoor),
    ...graph.durables.flatMap((d) => arcMiddleware(d.arc)),
  ];
  const globalCtx = serviceCtx(allControllers, allMiddleware, graph, doTokens);
  for (const validator of [new DependencyValidator(), new CaptiveDependencyValidator(), new LifecycleHookValidator()]) {
    results.push(...validator.validate(globalCtx));
  }

  // Route inject deps PER arc with that arc's framework tokens.
  const regValidator = new ServiceRegistrationValidator();
  results.push(
    ...regValidator.validate(
      serviceCtx(arcControllers(graph.frontDoor), arcMiddleware(graph.frontDoor), graph, workerTokens),
    ),
  );
  for (const { arc } of graph.durables) {
    results.push(
      ...regValidator.validate(serviceCtx(arcControllers(arc), arcMiddleware(arc), graph, doTokens)),
    );
  }

  // CF-specific reachability + DO static-dep checks.
  results.push(...reachabilityErrors(graph));
  results.push(...durableDepErrors(graph));

  // Config validation ONCE (config is host-global, not per-arc). The adapter owns ALL CF validation.
  const configCtx: ConfigValidationContext = {
    registeredTokens: graph.configRegistrations,
    defaultTokens: graph.defaultConfigTokens,
    resolvedConfig: graph.resolvedConfig,
    classConfigDeclarations: configClassDeclarations(graph),
  };
  results.push(...createConfigValidator().validate(configCtx));

  return results;
}

/** Collects every controller (top-level + group) declared on an arc. */
function arcControllers(arc: HttpArc<"sync">): ControllerRegistration[] {
  return [...arc.conRegistrations, ...arc.groups.flatMap((g) => g.controllers)];
}

/** Collects every middleware (top-level + group) declared on an arc. */
function arcMiddleware(arc: HttpArc<"sync">): MiddlewareRegistration[] {
  return [...arc.mwRegistrations, ...arc.groups.flatMap((g) => g.middleware)];
}

/** Gathers `classConfigDeclarations` from every registration across the whole app (all arcs + services). */
function configClassDeclarations(graph: CfValidationGraph): ReadonlyArray<ConfigToken<unknown>[] | undefined> {
  const arcs = [graph.frontDoor, ...graph.durables.map((d) => d.arc)];
  const controllers = arcs.flatMap((arc) => arcControllers(arc));
  const middleware = arcs.flatMap((arc) => arcMiddleware(arc));
  // TODO: narrow these `as any` casts. `r.cls` should be typed to expose the optional
  // `static config?: readonly ConfigToken<unknown>[]` from FlareBase.
  return [
    ...graph.scoped.map((r) => (r.cls as any).config),
    ...graph.singletons.map((r) => (r.cls as any).config),
    ...controllers.map((r) => (r.cls as any).config),
    ...middleware.map((r) => (r.cls as any).config),
  ];
}

/** True if `target` is in the transitive dependency closure of any token in `roots`. */
function closureReaches(
  roots: Iterable<ServiceToken<FlareService>>,
  target: ServiceToken<FlareService>,
  byToken: Map<ServiceToken<FlareService>, ServiceRegistration<FlareService>>,
): boolean {
  const seen = new Set<ServiceToken<FlareService>>();
  const stack = [...roots];
  while (stack.length > 0) {
    const token = stack.pop()!;
    if (token === target) return true;
    if (seen.has(token)) continue;
    seen.add(token);
    const reg = byToken.get(token);
    if (reg) { for (const dep of reg.cls.deps) stack.push(dep); }
  }
  return false;
}

/** Validates each DO's static deps against registered services + DO-context framework tokens. */
function durableDepErrors(graph: CfValidationGraph): ValidationError[] {
  const registered = new Set<ServiceToken<FlareService>>([
    ...graph.scoped.map((r) => r.token),
    ...graph.singletons.map((r) => r.token),
    ...graph.prebuiltTokens,
    Bindings,
    DurableState,
  ]);
  const errors: ValidationError[] = [];
  for (const { cls } of graph.durables) {
    for (const dep of cls.deps ?? []) {
      if (!registered.has(dep)) {
        errors.push({
          severity: "error",
          code: "DURABLE_OBJECT_UNREGISTERED_DEP",
          message: `Durable Object ${cls.name} depends on unregistered service ${dep.name}.`,
          hint: `Register ${dep.name} with host.scoped() before calling host.build().`,
        });
      }
    }
  }
  return errors;
}

/** Builds the HTTP validation context for one arc. */
function httpCtx(arc: HttpArc<"sync">): HttpValidationContext {
  return {
    controllers: arcControllers(arc),
    globalMiddleware: arc.mwRegistrations,
    groups: arc.groups,
    corsConfig: arc.corsConfig,
  };
}

/**
 * Service-graph reachability: a service whose dependency closure includes DurableState is an error iff
 * it is reachable from a front-door ENTRY (its controller inject deps OR its global/group middleware
 * inject deps): it would run in the Worker context, where DurableState is not seeded. DO-only-reachable
 * DurableState-dependent services are allowed.
 */
function reachabilityErrors(graph: CfValidationGraph): ValidationError[] {
  const byToken = serviceIndex(graph);
  const frontDoorRoots = [
    ...arcControllers(graph.frontDoor).flatMap((c) => c.cls.deps),
    ...arcMiddleware(graph.frontDoor).flatMap((m) => m.cls.deps),
  ];
  const errors: ValidationError[] = [];
  for (const reg of [...graph.scoped, ...graph.singletons]) {
    const reachesState = closureReaches([reg.token], DurableState, byToken);
    if (!reachesState) continue;
    if (closureReaches(frontDoorRoots, reg.token, byToken)) {
      errors.push({
        severity: "error",
        code: "DURABLE_STATE_IN_WORKER_CONTEXT",
        message: `Service ${reg.token.name} depends on DurableState but is reachable from a front-door route. `
          + `DurableState is seeded only in a Durable Object context.`,
        hint: `Inject ${reg.token.name} only from a per-DO arc / Durable Object, not from a front-door route.`,
      });
    }
  }
  return errors;
}

/** Builds the service validation context for one arc in one execution context. `frameworkTokens`
 * (Bindings, plus DurableState for a DO context) are added to the prebuilt set so a dep on them
 * resolves. Used at two granularities: once globally (full framework set) for the graph-integrity
 * validators, and per arc (that arc's framework set) for ServiceRegistrationValidator.
 */
function serviceCtx(
  controllers: ControllerRegistration[],
  middleware: MiddlewareRegistration[],
  graph: CfValidationGraph,
  frameworkTokens: ReadonlySet<ServiceToken<FlareService>>,
): ServiceValidationContext {
  return {
    scoped: graph.scoped,
    singletons: graph.singletons,
    controllers,
    middleware,
    prebuiltTokens: new Set<ServiceToken<FlareService>>([...graph.prebuiltTokens, ...frameworkTokens]),
  };
}

/** Indexes every registered service by its token for closure walks. */
function serviceIndex(
  graph: CfValidationGraph,
): Map<ServiceToken<FlareService>, ServiceRegistration<FlareService>> {
  const byToken = new Map<ServiceToken<FlareService>, ServiceRegistration<FlareService>>();
  for (const reg of [...graph.scoped, ...graph.singletons]) byToken.set(reg.token, reg);
  return byToken;
}
