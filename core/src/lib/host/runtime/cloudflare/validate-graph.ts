import type { JsonObject } from "@flare-ts/lib";
import type { HttpArc } from "../../../arcs/http/http-arc.js";
import type { ControllerRegistration, MiddlewareRegistration } from "../../../arcs/http/types/registration.js";
import type { WebSocketArc } from "../../../arcs/ws/ws-arc.js";
import type { ConfigToken, FlareWebSocketsConfig, OpaqueConfigToken } from "../../../config/flare-config.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { ServiceRegistration } from "../../../services/types/registration.js";
import type { ServiceToken } from "../../../services/types/types.js";
import type {
  ConfigValidationContext,
  HttpValidationContext,
  ServiceValidationContext,
  WsValidationContext,
} from "../../../validation/contexts.js";
import type { ValidationError } from "../../../validation/types.js";
import type { FlareDurableObjectClass } from "./durable-object.js";
import { COMPILE_HTTP_ARC } from "../../../arcs/http/http-arc.js";
import { WebSocketChannels } from "../../../arcs/ws/channels/web-socket-channels.js";
import { COMPILE_WS_ARC, WS_REGISTRATIONS } from "../../../arcs/ws/ws-arc.js";
import { createConfigValidator } from "../../../validation/validators/config-composite-validator.js";
import { createHttpValidator } from "../../../validation/validators/http-composite-validator.js";
import { CaptiveDependencyValidator } from "../../../validation/validators/service/captive-dep-validator.js";
import { DependencyValidator } from "../../../validation/validators/service/dependency-validator.js";
import { LifecycleHookValidator } from "../../../validation/validators/service/lifecycle-hook-validator.js";
import { ServiceRegistrationValidator } from "../../../validation/validators/service/service-registration-validator.js";
import { WsConfigValidator } from "../../../validation/validators/ws/config-validator.js";
import { WsRouteConflictValidator } from "../../../validation/validators/ws/route-conflict-validator.js";
import { WsRouteSyntaxValidator } from "../../../validation/validators/ws/route-syntax-validator.js";
import { Bindings, DurableState } from "./services.js";
import { staticStateTokens } from "./state-crossing.js";

/** Read-only graph the adapter hands the validator: the front door arc, the per-DO arcs, the DOs, services. */
export interface CfValidationGraph {
  /** The shared front-door arc (host.http). */
  readonly frontDoor: HttpArc<"sync">;
  /** The Worker-hosted WebSocket arc (host.ws). */
  readonly frontDoorWs: WebSocketArc;
  /** Each registered DO class paired with its per-DO HTTP arc and its WebSocket arc when the DO handle's `ws` arc was used. */
  readonly durables: ReadonlyArray<
    { readonly cls: FlareDurableObjectClass; readonly arc: HttpArc<"sync">; readonly ws: WebSocketArc | undefined; }
  >;
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
 * Compiles the per-DO WebSocket arc for every registered DO.
 *
 * Unlike {@link compileDurableArcs} (called only for DOs with HTTP routes, since a zero-route HTTP arc
 * is nulled to a 404), this runs for ALL DOs: the WS arc is never nulled, and a DO may have only WS
 * routes (no HTTP), whose arc must still compile or `UPGRADE_WS` would throw at connection time.
 */
export function compileDurableWsArcs(
  durables: ReadonlyArray<{ readonly cls: FlareDurableObjectClass; readonly ws: WebSocketArc | undefined; }>,
): void {
  for (const { cls, ws } of durables) {
    if (!ws) continue; // this DO never used the DO handle's `ws` arc (opt-in): no WS arc to compile.
    try {
      ws[COMPILE_WS_ARC]();
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
  // WebSocketChannels is DO-only on Cloudflare: a plain Worker has no broadcast domain, so a front-door route
  // reaching it fails the same way DurableState does (direct inject via the per-arc token sets below,
  // transitive deps via reachabilityErrors).
  const workerTokens = new Set<ServiceToken<FlareService>>([Bindings]);
  const doTokens = new Set<ServiceToken<FlareService>>([Bindings, DurableState, WebSocketChannels]);
  const results: ValidationError[] = [];

  // HTTP per arc: front door (Worker context) + each per-DO arc (DO context). The cookie-secret fact is
  // host-level, so it is computed once and applied to every arc's context.
  const cookieSecretConfigured = Boolean((graph.resolvedConfig as { cookies?: { secret?: string; }; }).cookies?.secret);
  results.push(...createHttpValidator().validate(httpCtx(graph.frontDoor, cookieSecretConfigured)));
  for (const { arc } of graph.durables) {
    results.push(...createHttpValidator().validate(httpCtx(arc, cookieSecretConfigured)));
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

  // WebSocket arcs: route syntax + WS-internal / WS-vs-HTTP conflicts per context (host.ws against the
  // front door, each per-DO ws arc against its own http arc), then config sanity once (host-global).
  results.push(...wsValidationErrors(graph));

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
    WebSocketChannels,
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

/**
 * Runs WebSocket validation at CF granularity: route syntax + conflicts (WS-internal duplicates and
 * WS-vs-HTTP path collisions) per context -- host.ws against the front-door HTTP controllers, each
 * per-DO ws arc against that DO's HTTP controllers -- then `websockets` config sanity once, since the
 * config section is host-global and would otherwise report duplicate errors per context.
 */
function wsValidationErrors(graph: CfValidationGraph): ValidationError[] {
  const wsConfig = (graph.resolvedConfig as { websockets?: FlareWebSocketsConfig; }).websockets;
  const syntax = new WsRouteSyntaxValidator();
  const conflict = new WsRouteConflictValidator();
  const results: ValidationError[] = [];

  const contexts: ReadonlyArray<{ ws: WebSocketArc; http: HttpArc<"sync">; }> = [
    { ws: graph.frontDoorWs, http: graph.frontDoor },
    // Only DOs that used the DO handle's `ws` arc (opt-in) have a WS arc to validate.
    ...graph.durables.flatMap((d) => (d.ws ? [{ ws: d.ws, http: d.arc }] : [])),
  ];
  for (const { ws, http } of contexts) {
    const ctx: WsValidationContext = {
      wsPatterns: ws[WS_REGISTRATIONS]().map((r) => r.pattern),
      httpControllers: arcControllers(http),
      config: wsConfig,
    };
    results.push(...syntax.validate(ctx), ...conflict.validate(ctx));
  }

  // Channels need a broadcast domain, and the front-door Worker has none: workerd pins each connection
  // to the request that accepted it, so a `channel:` route there could never deliver. Only the declared
  // option is visible at build time; imperative ws.subscribe in a front-door handler fails at open with
  // the same guidance (the Worker context's channel backend).
  for (const reg of graph.frontDoorWs[WS_REGISTRATIONS]()) {
    if (reg.channel !== undefined) {
      results.push({
        severity: "error",
        code: "WS_CHANNEL_REQUIRES_DURABLE_OBJECT",
        message:
          `WebSocket route "${reg.pattern}" declares \`channel:\` on the front-door Worker, where connections cannot deliver to each other.`,
        hint: `Host the route on a Durable Object: register it via host.durableObject(...).ws and mount the DO.`,
      });
    }
  }

  // Config sanity once (host-global): no patterns/controllers needed.
  results.push(...new WsConfigValidator().validate({ wsPatterns: [], httpControllers: [], config: wsConfig }));
  return results;
}

/** Builds the HTTP validation context for one arc. */
function httpCtx(arc: HttpArc<"sync">, cookieSecretConfigured: boolean): HttpValidationContext {
  return {
    controllers: arcControllers(arc),
    globalMiddleware: arc.mwRegistrations,
    groups: arc.groups,
    corsConfig: arc.corsConfig,
    cookieSecretConfigured,
  };
}

/** The DO-only framework tokens, each with its front-door reachability error. Same policy, distinct guidance. */
const DO_ONLY_TOKENS = [
  {
    token: DurableState,
    code: "DURABLE_STATE_IN_WORKER_CONTEXT",
    why: "DurableState is seeded only in a Durable Object context.",
    hint: (name: string) => `Inject ${name} only from a per-DO arc / Durable Object, not from a front-door route.`,
  },
  {
    token: WebSocketChannels,
    code: "WS_CHANNELS_IN_WORKER_CONTEXT",
    why:
      "A plain Worker has no WebSocket broadcast domain (workerd pins each connection to the request that accepted it); WebSocketChannels is seeded per Durable Object instance.",
    hint: (name: string) =>
      `Publish from a Durable Object context instead: inject ${name} from a per-DO route (host.durableObject(...).http) or use ws.publish inside a WS handler.`,
  },
] as const;

/**
 * Service-graph reachability: a service whose dependency closure includes a DO-only framework token is
 * an error iff it is reachable from a front-door ENTRY (its controller inject deps OR its global/group
 * middleware inject deps): it would run in the Worker context, where that token's capability is not
 * seeded. DO-only-reachable dependents are allowed.
 */
function reachabilityErrors(graph: CfValidationGraph): ValidationError[] {
  const byToken = serviceIndex(graph);
  const frontDoorRoots = [
    ...arcControllers(graph.frontDoor).flatMap((c) => c.cls.deps),
    ...arcMiddleware(graph.frontDoor).flatMap((m) => m.cls.deps),
  ];
  const errors: ValidationError[] = [];
  for (const reg of [...graph.scoped, ...graph.singletons]) {
    for (const restricted of DO_ONLY_TOKENS) {
      if (!closureReaches([reg.token], restricted.token, byToken)) continue;
      if (closureReaches(frontDoorRoots, reg.token, byToken)) {
        errors.push({
          severity: "error",
          code: restricted.code,
          message:
            `Service ${reg.token.name} depends on ${restricted.token.name} but is reachable from a front-door route. ${restricted.why}`,
          hint: restricted.hint(reg.token.name),
        });
      }
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
