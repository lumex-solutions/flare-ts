/**
 * Builds the app graph's nodes from what the host compiled: route nodes from the front door's HTTP
 * pipelines, service nodes from the registrations. Runs on the graph's first query.
 */
import type { MiddlewareClass } from "../arcs/http/composition/classes/middleware-base.js";
import type { Pipeline } from "../arcs/http/types/pipeline.js";
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

type ServiceIndex = Map<ServiceToken<FlareService>, ServiceEntry>;

type StageLayout = {
  /** Run order; the handler slot is left undefined because its name differs per method. */
  readonly stages: ReadonlyArray<RouteStage | undefined>;
  readonly middleware: ReadonlySet<MiddlewareClass>;
  readonly writes: readonly string[];
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
  const index = indexServices(source);
  const routes: RouteNode[] = [];
  const usedBy = new Map<ServiceToken<FlareService>, string[]>();
  for (const pipeline of source.pipelines) {
    const layout = stageLayout(pipeline, source);
    const resolved = resolvedServices(pipeline, layout.middleware, index);
    for (const route of routeNodes(pipeline, source, layout, resolved.map((token) => idOf(token, index)))) {
      routes.push(route);
      for (const token of resolved) {
        const ids = usedBy.get(token);
        if (ids) ids.push(route.id);
        else usedBy.set(token, [route.id]);
      }
    }
  }

  const services: ServiceNode[] = [];
  const serviceByToken = new Map<ServiceToken<FlareService>, ServiceNode>();
  for (const [token, entry] of index) {
    const node: ServiceNode = Object.freeze({
      id: entry.id,
      lifetime: entry.lifetime,
      deps: Object.freeze(entry.deps.map((dep) => idOf(dep, index))),
      config: Object.freeze(entry.config),
      usedBy: Object.freeze(usedBy.get(token) ?? []),
    });
    services.push(node);
    serviceByToken.set(token, node);
  }

  return { routes: Object.freeze(routes), services: Object.freeze(services), serviceByToken };
}

function indexServices(source: GraphSource): ServiceIndex {
  const index: ServiceIndex = new Map();
  const taken = new Set<string>();
  const add = (
    token: ServiceToken<FlareService>,
    lifetime: "singleton" | "scoped",
    deps: readonly ServiceToken<FlareService>[],
    config: readonly ConfigToken<unknown>[] | undefined,
  ): void => {
    if (index.has(token)) return;
    index.set(token, { id: uniqueId(token.name, taken), lifetime, deps, config: (config ?? []).map((c) => c.key) });
  };
  for (const reg of source.singletons) add(reg.token, "singleton", reg.cls.deps, reg.cls.config);
  for (const reg of source.scoped) add(reg.token, "scoped", reg.cls.deps, reg.cls.config);
  for (const token of source.prebuilt) {
    // A prebuilt token is the framework class itself (Logger, AppGraph); the token type carries only
    // its constructor, not the statics every FlareBase class declares.
    const cls = token as unknown as {
      deps?: readonly ServiceToken<FlareService>[];
      config?: readonly ConfigToken<unknown>[];
    };
    add(token, "singleton", cls.deps ?? [], cls.config);
  }
  return index;
}

// Two classes can share a name; the second and later get a deterministic suffix.
function uniqueId(name: string, taken: Set<string>): string {
  let id = name;
  for (let n = 2; taken.has(id); n++) id = `${name}#${n}`;
  taken.add(id);
  return id;
}

function idOf(token: ServiceToken<FlareService>, index: ServiceIndex): string {
  return index.get(token)?.id ?? token.name;
}

// Middleware stages are the same for every method at the path; only the handler stage differs.
function stageLayout(pipeline: Pipeline, source: GraphSource): StageLayout {
  const afterEnd = pipeline.execCount - pipeline.finallyCount;
  const stages: Array<RouteStage | undefined> = [];
  const middleware = new Set<MiddlewareClass>();
  const writes = new Set<string>();
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
    stages.push(Object.freeze({
      stage: i < pipeline.handlerExecIdx ? "before" : i < afterEnd ? "after" : "finally",
      name: cls.name,
      scope: resolved.scope,
    }));
  }
  return { stages, middleware, writes: Object.freeze([...writes]) };
}

// Everything a pipeline resolves: its handlers', middleware's, and error handlers' deps, then theirs,
// breadth-first so direct deps come before transitive ones.
function resolvedServices(
  pipeline: Pipeline,
  middleware: ReadonlySet<MiddlewareClass>,
  index: ServiceIndex,
): ServiceToken<FlareService>[] {
  const queue = [
    ...pipeline.registration.deps,
    ...[...middleware].flatMap((cls) => cls.deps),
    ...pipeline.errorHandlers.flatMap((handler) => handler.deps),
  ];
  const seen = new Set<ServiceToken<FlareService>>();
  for (let i = 0; i < queue.length; i++) {
    const token = queue[i]!;
    if (seen.has(token)) continue;
    seen.add(token);
    queue.push(...(index.get(token)?.deps ?? []));
  }
  return [...seen];
}

function routeNodes(
  pipeline: Pipeline,
  source: GraphSource,
  layout: StageLayout,
  serviceIds: readonly string[],
): RouteNode[] {
  const registration = pipeline.registration;
  const path = pipeline.flareRoute.route;
  const group = source.groups.find((g) => g.controllers.includes(registration))?.prefix;
  const state = Object.freeze({
    reads: Object.freeze(registration.state.map((token) => token.name)),
    writes: layout.writes,
  });
  const services = Object.freeze([...serviceIds]);

  return pipeline.handlers.flatMap((handler, methodIdx) => {
    if (!handler) return [];
    const method = SUPPORTED_METHODS[methodIdx]!;
    const id = `${method} ${path}`;
    const handlerName = registration.cls ? `${registration.name}.${handler.name}` : id;
    const handlerStage: RouteStage = Object.freeze({ stage: "handler", name: handlerName });
    return [
      new RouteNode({
        id,
        method,
        path,
        group,
        handler: handlerName,
        pipeline: Object.freeze(layout.stages.map((stage) => stage ?? handlerStage)),
        state,
        services,
      }, layout.middleware),
    ];
  });
}
