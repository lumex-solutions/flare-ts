/**
 * Builds the app graph's nodes from what the host compiled: route nodes from the HTTP pipelines and
 * WebSocket routes of the front door and each Durable Object, service nodes from the registrations.
 * Runs on the graph's first query.
 */
import type { JsonSchema, OpaqueSchemaToken } from "@flare-ts/lib/schema";
import { schema, toJsonSchema } from "@flare-ts/lib/schema";
import type { MiddlewareClass } from "../arcs/http/composition/classes/middleware-base.js";
import type { OpaqueConfigToken } from "../config/flare-config.js";
import type { FlareService } from "../services/composition/flare-service.js";
import type { ServiceToken } from "../services/types/token.js";
import type { ArcSource, GraphSource, PipelineStep, RouteNode, ServiceNode } from "./types.js";
import { resolveStepMiddleware } from "../arcs/http/build.js";
import { stream } from "../arcs/http/composition/contract/http-contract.js";
import { SUPPORTED_METHODS } from "../arcs/http/routing/types/methods.js";
import { HttpRouteNode } from "./http-route-node.js";
import { WebSocketRouteNode } from "./web-socket-route-node.js";

type ServiceEntry = {
  readonly id: string;
  readonly lifetime: "singleton" | "scoped";
  readonly deps: readonly ServiceToken<FlareService>[];
  readonly config: readonly string[];
};

/** The graph's nodes, with the lookups queries need. */
export type GraphModel = {
  /** Route nodes in the order the router tries them. */
  readonly routes: readonly RouteNode[];
  readonly routeById: ReadonlyMap<string, RouteNode>;
  /** Each route's path split into segments, for path filters. */
  readonly routeSegments: ReadonlyMap<RouteNode, readonly string[]>;
  readonly services: readonly ServiceNode[];
  readonly serviceByToken: ReadonlyMap<ServiceToken<FlareService>, ServiceNode>;
};

/** Builds every route and service node from the host's compiled arcs and its registrations. */
export function buildGraph(source: GraphSource): GraphModel {
  const entries = new Map<ServiceToken<FlareService>, ServiceEntry>();
  const taken = new Set<string>();
  const add = (
    token: ServiceToken<FlareService>,
    lifetime: "singleton" | "scoped",
    deps: readonly ServiceToken<FlareService>[],
    config: readonly OpaqueConfigToken[] | undefined,
  ): void => {
    if (entries.has(token)) return;
    // Two classes can share a name; the second and later get a deterministic suffix.
    let id = token.name;
    for (let n = 2; taken.has(id); n++) id = `${token.name}#${n}`;
    taken.add(id);
    entries.set(token, { id, lifetime, deps, config: (config ?? []).map((c) => c.key) });
  };
  for (const reg of source.singletons) add(reg.token, "singleton", reg.cls.deps, reg.cls.config);
  for (const reg of source.scoped) add(reg.token, "scoped", reg.cls.deps, reg.cls.config);
  const addFramework = (token: ServiceToken<FlareService>, lifetime: "singleton" | "scoped"): void => {
    // Erasure in a heterogeneous collection: a framework token is the service class itself (Logger,
    // Bindings), and the token type carries only its constructor, not the statics every FlareBase declares.
    const cls = token as unknown as {
      deps?: readonly ServiceToken<FlareService>[];
      config?: readonly OpaqueConfigToken[];
    };
    add(token, lifetime, cls.deps ?? [], cls.config);
  };
  for (const token of source.prebuilt) addFramework(token, "singleton");
  for (const token of source.seeded) addFramework(token, "scoped");

  const routes: RouteNode[] = [];
  const routeById = new Map<string, RouteNode>();
  const routeSegments = new Map<RouteNode, readonly string[]>();
  const usedBy = new Map<ServiceToken<FlareService>, string[]>();
  // Breadth-first, so a route's direct deps are listed before the ones they pull in.
  const servicesOf = (direct: readonly ServiceToken<FlareService>[]): ServiceToken<FlareService>[] => {
    const queue = [...direct];
    const resolved = new Set<ServiceToken<FlareService>>();
    for (let i = 0; i < queue.length; i++) {
      const token = queue[i]!;
      if (resolved.has(token)) continue;
      resolved.add(token);
      queue.push(...(entries.get(token)?.deps ?? []));
    }
    return [...resolved];
  };
  const addRoute = (route: RouteNode, tokens: readonly ServiceToken<FlareService>[]): void => {
    routes.push(route);
    routeById.set(route.id, route);
    routeSegments.set(route, Object.freeze(segmentsOf(route.path)));
    for (const token of tokens) {
      const ids = usedBy.get(token);
      if (ids) ids.push(route.id);
      else usedBy.set(token, [route.id]);
    }
  };

  const addArcs = (arcs: ArcSource, durableObject: string | undefined): void => {
    const prefix = durableObject === undefined ? "" : `${durableObject} `;
    for (const pipeline of arcs.pipelines) {
      const registration = pipeline.registration;

      // Middleware steps are the same for every method at the path; only the handler step differs.
      const steps: Array<PipelineStep | undefined> = [];
      const middleware = new Set<MiddlewareClass>();
      const writes = new Set<string>();
      for (let i = 0; i < pipeline.execCount; i++) {
        if (i === pipeline.handlerExecIdx) {
          steps.push(undefined);
          continue;
        }
        const resolved = resolveStepMiddleware(pipeline, arcs.middleware, i);
        if (!resolved) continue;
        const cls = resolved.registration.cls;
        middleware.add(cls);
        for (const token of cls.provides ?? []) writes.add(token.name);
        steps.push(Object.freeze({ kind: resolved.kind, name: cls.name, from: resolved.from }));
      }

      const tokens = servicesOf([
        ...registration.deps,
        ...[...middleware].flatMap((cls) => cls.deps),
        ...pipeline.errorHandlers.flatMap((handler) => handler.deps),
      ]);
      const path = pipeline.flareRoute.route;
      const group = arcs.groups.find((g) => g.controllers.includes(registration))?.prefix;
      const state = Object.freeze({
        reads: Object.freeze(registration.state.map((token) => token.name)),
        writes: Object.freeze([...writes]),
      });
      const services = Object.freeze(tokens.map((token) => idOf(token, entries)));
      pipeline.handlers.forEach((handler, methodIdx) => {
        if (!handler) return;
        const method = SUPPORTED_METHODS[methodIdx]!;
        const id = `${prefix}${method} ${path}`;
        const handlerName = registration.cls ? `${registration.name}.${handler.name}` : id;
        const handlerStep: PipelineStep = Object.freeze({ kind: "handler", name: handlerName });
        const descriptor = pipeline.flareRoute.requestDescriptors[methodIdx];
        const input: { route?: JsonSchema; query?: JsonSchema; body?: JsonSchema; } = {};
        if (descriptor?.route) input.route = frozenCopy(toJsonSchema(schema(descriptor.route)));
        if (descriptor?.query) input.query = frozenCopy(toJsonSchema(schema(descriptor.query)));
        if (descriptor?.body === stream) {
          input.body = Object.freeze<JsonSchema>({ type: "string", format: "binary" });
        } else if (descriptor?.body) {
          // The stream sentinel was excluded above, which the type system cannot connect to this union.
          input.body = frozenCopy(toJsonSchema(descriptor.body as OpaqueSchemaToken));
        }
        addRoute(
          new HttpRouteNode({
            id,
            method,
            path,
            group,
            durableObject,
            handler: handlerName,
            pipeline: Object.freeze(steps.map((step) => step ?? handlerStep)),
            input: Object.freeze(input),
            state,
            services,
          }, middleware),
          tokens,
        );
      });
    }

    for (const registration of arcs.webSockets) {
      const id = `${prefix}WS ${registration.pattern}`;
      const tokens = servicesOf([
        ...Object.values(registration.inject),
        ...(registration.kind === "controller" ? registration.cls.deps : []),
        ...Object.values(registration.upgrade?.inject ?? {}),
      ]);
      const descriptor = registration.descriptor;
      const input: { params?: JsonSchema; query?: JsonSchema; incoming?: JsonSchema; } = {};
      if (descriptor?.params) input.params = frozenCopy(toJsonSchema(schema(descriptor.params)));
      if (descriptor?.query) input.query = frozenCopy(toJsonSchema(schema(descriptor.query)));
      if (descriptor?.incoming) input.incoming = frozenCopy(toJsonSchema(descriptor.incoming));
      addRoute(
        new WebSocketRouteNode({
          id,
          path: registration.pattern,
          durableObject,
          handler: registration.kind === "controller" ? registration.cls.name : id,
          input: Object.freeze(input),
          state: Object.freeze({
            reads: Object.freeze(registration.state.map((token) => token.name)),
            writes: Object.freeze((registration.upgrade?.provides ?? []).map((token) => token.name)),
          }),
          services: Object.freeze(tokens.map((token) => idOf(token, entries))),
        }),
        tokens,
      );
    }
  };
  addArcs(source.frontDoor, undefined);
  for (const durable of source.durableObjects) addArcs(durable, durable.name);

  const services: ServiceNode[] = [];
  const serviceByToken = new Map<ServiceToken<FlareService>, ServiceNode>();
  for (const [token, entry] of entries) {
    const node: ServiceNode = Object.freeze({
      id: entry.id,
      lifetime: entry.lifetime,
      deps: Object.freeze(entry.deps.map((dep) => idOf(dep, entries))),
      config: Object.freeze(entry.config),
      usedBy: Object.freeze(usedBy.get(token) ?? []),
    });
    services.push(node);
    serviceByToken.set(token, node);
  }

  return { routes: Object.freeze(routes), routeById, routeSegments, services: Object.freeze(services), serviceByToken };
}

/** Splits a path into its non-empty segments. */
export function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

// Lib hands back its primitives' own schema objects, so the graph freezes a copy, never lib's originals.
function frozenCopy(source: JsonSchema): JsonSchema {
  const copy = structuredClone(source);
  const pending: object[] = [copy];
  for (let i = 0; i < pending.length; i++) {
    for (const child of Object.values(Object.freeze(pending[i]!))) {
      if (typeof child === "object" && child !== null) pending.push(child);
    }
  }
  return copy;
}

function idOf(
  token: ServiceToken<FlareService>,
  entries: ReadonlyMap<ServiceToken<FlareService>, ServiceEntry>,
): string {
  return entries.get(token)?.id ?? token.name;
}
