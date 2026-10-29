/**
 * Builds the app graph's nodes from what the host compiled: route nodes from the front door's HTTP
 * pipelines, service nodes from the registrations. Runs on the graph's first query.
 */
import type { MiddlewareClass } from "../arcs/http/composition/classes/middleware-base.js";
import type { ConfigToken } from "../config/flare-config.js";
import type { FlareService } from "../services/composition/flare-service.js";
import type { ServiceToken } from "../services/types/token.js";
import type { GraphSource, RouteStage, ServiceNode } from "./types.js";
import { resolveStageMiddleware } from "../arcs/http/build.js";
import { SUPPORTED_METHODS } from "../arcs/http/routing/types/methods.js";
import { RouteNode } from "./route-node.js";

type ServiceEntry = {
  readonly id: string;
  readonly lifetime: "singleton" | "scoped";
  readonly deps: readonly ServiceToken<FlareService>[];
  readonly config: readonly string[];
};

/** The graph's nodes, with the token lookup service queries need. */
export type GraphModel = {
  /** In the order the router tries them. */
  readonly routes: readonly RouteNode[];
  readonly services: readonly ServiceNode[];
  readonly serviceByToken: ReadonlyMap<ServiceToken<FlareService>, ServiceNode>;
};

/** Builds every route and service node from the host's compiled front door and its registrations. */
export function buildGraph(source: GraphSource): GraphModel {
  const entries = new Map<ServiceToken<FlareService>, ServiceEntry>();
  const taken = new Set<string>();
  const add = (
    token: ServiceToken<FlareService>,
    lifetime: "singleton" | "scoped",
    deps: readonly ServiceToken<FlareService>[],
    config: readonly ConfigToken<unknown>[] | undefined,
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
  for (const token of source.prebuilt) {
    // Erasure in a heterogeneous collection: a prebuilt token is the framework class itself (Logger,
    // AppGraph), and the token type carries only its constructor, not the statics every FlareBase declares.
    const cls = token as unknown as {
      deps?: readonly ServiceToken<FlareService>[];
      config?: readonly ConfigToken<unknown>[];
    };
    add(token, "singleton", cls.deps ?? [], cls.config);
  }

  const routes: RouteNode[] = [];
  const usedBy = new Map<ServiceToken<FlareService>, string[]>();
  for (const pipeline of source.pipelines) {
    const registration = pipeline.registration;

    // Middleware stages are the same for every method at the path; only the handler stage differs.
    const stages: Array<RouteStage | undefined> = [];
    const middleware = new Set<MiddlewareClass>();
    const writes = new Set<string>();
    const afterEnd = pipeline.execCount - pipeline.finallyCount;
    for (let i = 0; i < pipeline.execCount; i++) {
      if (i === pipeline.handlerExecIdx) {
        stages.push(undefined);
        continue;
      }
      const resolved = resolveStageMiddleware(pipeline, source.middleware, i);
      if (!resolved) continue;
      const cls = resolved.registration.cls;
      middleware.add(cls);
      for (const token of cls.provides ?? []) writes.add(token.name);
      let kind: "before" | "after" | "finally" = "finally";
      if (i < pipeline.handlerExecIdx) kind = "before";
      else if (i < afterEnd) kind = "after";
      stages.push(Object.freeze({ kind, name: cls.name, scope: resolved.scope }));
    }

    // Breadth-first, so a route's direct deps are listed before the ones they pull in.
    const queue = [
      ...registration.deps,
      ...[...middleware].flatMap((cls) => cls.deps),
      ...pipeline.errorHandlers.flatMap((handler) => handler.deps),
    ];
    const resolvedTokens = new Set<ServiceToken<FlareService>>();
    for (let i = 0; i < queue.length; i++) {
      const token = queue[i]!;
      if (resolvedTokens.has(token)) continue;
      resolvedTokens.add(token);
      queue.push(...(entries.get(token)?.deps ?? []));
    }

    const path = pipeline.flareRoute.route;
    const group = source.groups.find((g) => g.controllers.includes(registration))?.prefix;
    const state = Object.freeze({
      reads: Object.freeze(registration.state.map((token) => token.name)),
      writes: Object.freeze([...writes]),
    });
    const services = Object.freeze([...resolvedTokens].map((token) => idOf(token, entries)));
    pipeline.handlers.forEach((handler, methodIdx) => {
      if (!handler) return;
      const method = SUPPORTED_METHODS[methodIdx]!;
      const id = `${method} ${path}`;
      const handlerName = registration.cls ? `${registration.name}.${handler.name}` : id;
      const handlerStage: RouteStage = Object.freeze({ kind: "handler", name: handlerName });
      routes.push(
        new RouteNode({
          id,
          method,
          path,
          group,
          handler: handlerName,
          pipeline: Object.freeze(stages.map((stage) => stage ?? handlerStage)),
          state,
          services,
        }, middleware),
      );
      for (const token of resolvedTokens) {
        const ids = usedBy.get(token);
        if (ids) ids.push(id);
        else usedBy.set(token, [id]);
      }
    });
  }

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

  return { routes: Object.freeze(routes), services: Object.freeze(services), serviceByToken };
}

function idOf(
  token: ServiceToken<FlareService>,
  entries: ReadonlyMap<ServiceToken<FlareService>, ServiceEntry>,
): string {
  return entries.get(token)?.id ?? token.name;
}
