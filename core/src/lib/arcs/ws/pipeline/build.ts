/** Build-time compilation for the WebSocket arc: turns raw registrations into executable pipelines. */
import type { SchemaToken } from "@flare-ts/lib/schema";
import { compileSerializer } from "@flare-ts/lib/schema";
import type { ConfigToken, FlareWebSocketsConfig } from "../../../config/flare-config.js";
import type { LogRunner } from "../../../logger/logger.js";
import type { FlareRouter } from "../../../routing/flare-router.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { Container } from "../../../services/container.js";
import type { ScopeConfig } from "../../../services/types/scope.js";
import type { ServiceToken } from "../../../services/types/types.js";
import type { WebSocketControllerClass } from "../composition/classes/controller-base.js";
import type { WebSocketHandlerScope, WebSocketMessageHandlerScope } from "../composition/types/handlers.js";
import type { WsHandlerFns, WsRegistration } from "../composition/types/registration.js";
import type { WsAcceptOptions } from "../transport/socket.js";
import type { WsTypedInput } from "./input.js";
import type { WsController, WsControllerFactory, WsPipeline, WsRoute, WsRouteSegment } from "./route.js";
import { WEBSOCKETS_DEFAULTS } from "../../../config/flare-config.js";
import { _log, toErrorField } from "../../../logger/logger.js";
import { buildFlareRouter, scoreRoute } from "../../../routing/flare-router.js";
import { attachScopeDeps } from "../../../services/scope.js";

const COLON = 58; // ":"
const NO_SEGMENTS: readonly string[] = [];
const NO_ROUTE_SEGMENTS: readonly WsRouteSegment[] = [];

// Fallback caps/timers when no resolved config is supplied (an arc compiled outside a full host build,
// e.g. a unit test), derived from the SAME constant the WEBSOCKETS_CONFIG token defaults to so the
// no-config path can never drift from the resolved-config path.
const DEFAULT_LIMITS = {
  maxMessageSize: WEBSOCKETS_DEFAULTS.maxMessageSize,
  maxFrameSize: WEBSOCKETS_DEFAULTS.maxFrameSize,
  maxFragments: WEBSOCKETS_DEFAULTS.maxFragments,
  maxBufferedBytes: WEBSOCKETS_DEFAULTS.maxBufferedBytes,
} as const;
const DEFAULT_TIMINGS = {
  keepAliveIntervalMs: WEBSOCKETS_DEFAULTS.keepAliveIntervalMs,
  idleTimeoutMs: WEBSOCKETS_DEFAULTS.idleTimeoutMs,
  closeGraceMs: WEBSOCKETS_DEFAULTS.closeGraceMs,
} as const;
const DEFAULT_PONG_POLICY = WEBSOCKETS_DEFAULTS.pongPolicy;

/** The runtime scope shape the synthesized controller builds (the erased face of the public scope types). */
type SynthesizedScope = {
  config: ScopeConfig;
  input: WsTypedInput & { readonly message?: unknown; };
};

/**
 * Compiles the raw registrations into the arc's executable pipelines and the router over them.
 * Anonymous return like HTTP's `compileHttp`: the arc destructures into its members.
 * `pipelines` is in REGISTRATION order (`pipelines[i].index === i`, the durable route-id space
 * hibernation attachments carry); `routes` is the same set re-ordered most-specific-first for matching.
 *
 * Each registration becomes a {@link WsPipeline}: parser entries flattened once, schema tokens lifted,
 * outbound serializer resolved, and the per-connection controller factory compiled (function form
 * synthesized onto the controller surface). Reuses {@link buildFlareRouter} for shared literal/`:param`
 * matching; each pattern is scanned once for specificity score, param positions, and depth.
 */
export function compileWsRoutes(
  registrations: readonly WsRegistration[],
  config: FlareWebSocketsConfig | undefined,
): {
  pipelines: readonly WsPipeline[];
  router: FlareRouter | undefined;
  routes: readonly WsRoute[];
  acceptOptions: WsAcceptOptions;
} {
  const acceptOptions = resolveAcceptOptions(config);
  const pipelines = registrations.map((registration, index): WsPipeline => ({
    registration,
    pattern: registration.pattern,
    index,
    params: registration.descriptor?.params ? Object.entries(registration.descriptor.params) : undefined,
    query: registration.descriptor?.query ? Object.entries(registration.descriptor.query) : undefined,
    // The cast restates what erasure loses: `OpaqueSchemaToken` in the descriptor is the same token
    // the compile step needs as `SchemaToken<unknown>` for decode.
    incoming: registration.descriptor?.incoming as SchemaToken<unknown> | undefined,
    // Outbound: an `outgoing` schema compiles the SAME schema-driven serializer HTTP's `response`
    // schemas use (declared fields only, escape scans skipped where the field domain allows); without
    // one, raw passthrough. The cast restates what erasure loses: every value reaching `serialize`
    // came through `ws.send` typed `WebSocketOutgoing<T>` from the same declared schema.
    serialize: registration.descriptor?.outgoing
      ? (compileSerializer(registration.descriptor.outgoing) as (data: unknown) => string)
      : undefined,
    // The authoring-form branch is resolved here, once per route; both backings drive the one uniform
    // controller surface it produces. The function form closes over the registration's LIVE handler set,
    // so handlers attached via the route handle after route() returned are still honored.
    controller: registration.kind === "controller"
      ? controllerClassFactory(registration.cls)
      : synthesizeWsController(registration.behaviors, registration.inject),
  }));

  const n = pipelines.length;
  if (n === 0) return { pipelines, router: undefined, routes: [], acceptOptions };

  const scored: Array<{ pipeline: WsPipeline; segments: readonly WsRouteSegment[]; score: number; }> = new Array(n);
  let maxDepth = 0;
  for (let r = 0; r < n; r++) {
    const pipeline = pipelines[r]!;
    const segs = pipeline.pattern === "/" ? NO_SEGMENTS : pipeline.pattern.slice(1).split("/");
    if (segs.length > maxDepth) maxDepth = segs.length;

    // Specificity uses the shared scorer (one implementation across arcs); this scan only locates params.
    let segments: WsRouteSegment[] | undefined;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i]!.charCodeAt(0) === COLON) (segments ??= []).push({ name: segs[i]!.slice(1), index: i });
    }
    scored[r] = { pipeline, segments: segments ?? NO_ROUTE_SEGMENTS, score: scoreRoute(pipeline.pattern) };
  }

  // Array.sort is stable, so equal-specificity routes keep their registration order.
  scored.sort((a, b) => b.score - a.score);

  const patterns: string[] = new Array(n);
  const routes: WsRoute[] = new Array(n);
  for (let i = 0; i < n; i++) {
    patterns[i] = scored[i]!.pipeline.pattern;
    routes[i] = { pipeline: scored[i]!.pipeline, segments: scored[i]!.segments };
  }
  return { pipelines, router: buildFlareRouter(patterns, maxDepth), routes, acceptOptions };
}

function resolveAcceptOptions(config: FlareWebSocketsConfig | undefined): WsAcceptOptions {
  const limits = config
    ? {
      maxMessageSize: config.maxMessageSize,
      maxFrameSize: config.maxFrameSize,
      maxFragments: config.maxFragments,
      maxBufferedBytes: config.maxBufferedBytes,
    }
    : { ...DEFAULT_LIMITS };
  const timings = config
    ? {
      keepAliveIntervalMs: config.keepAliveIntervalMs,
      idleTimeoutMs: config.idleTimeoutMs,
      closeGraceMs: config.closeGraceMs,
    }
    : { ...DEFAULT_TIMINGS };
  return { subprotocols: [], limits, timings, pongPolicy: config?.pongPolicy ?? DEFAULT_PONG_POLICY };
}

/** Compiles the class form: the factory instantiates the author's controller and wraps it in the runner. */
function controllerClassFactory(cls: WebSocketControllerClass): WsControllerFactory {
  return (container, ws, input, run): WsController => {
    // The ONE erased-construction boundary shared by both backings: the instance was typed against the
    // SAME descriptor this pipeline was compiled from.
    const instance = new cls(container, ws as never, input as never) as unknown as WsController;
    return {
      open: () => run(() => instance.open?.()),
      message: (value) => run(() => instance.message?.(value)),
      close: (code, reason, wasClean) => run(() => instance.close?.(code, reason, wasClean)),
      error: (err) => runErrorHandler(run, () => instance.error?.(err)),
    };
  };
}

/**
 * Compiles the function form by synthesizing it onto the controller surface (HTTP's synthetic-controller
 * move): the factory prepares the connect-time scope (built lazily, once, and reused across the
 * connection's methods), and each method closes over `(ws, scope)`. The message method builds the
 * per-message child scope internally and is OMITTED entirely when no message handler is registered, so a
 * message-less route never pays that per-message allocation.
 */
function synthesizeWsController(
  behaviors: WsHandlerFns,
  inject: Readonly<Record<string, ServiceToken<FlareService>>>,
): WsControllerFactory {
  return (container, ws, input, run): WsController => {
    let scope: SynthesizedScope | undefined;
    const getScope = (): SynthesizedScope => (scope ??= buildScope(container, input, inject));
    const controller: WsController = {
      // The pairing casts restate what the erased handler slots cannot: these handlers were typed
      // against the SAME descriptor this pipeline's input/decode were compiled from.
      open: () => run(() => behaviors.open?.(ws, getScope() as WebSocketHandlerScope)),
      close: (code, reason, wasClean) =>
        run(() => behaviors.close?.(ws, getScope() as WebSocketHandlerScope, code, reason, wasClean)),
      error: (err) => runErrorHandler(run, () => behaviors.error?.(ws, getScope() as WebSocketHandlerScope, err)),
    };
    const message = behaviors.message;
    if (message) {
      controller.message = (value): void | Promise<void> => {
        // Per-message scope: inherits the connection scope's memoized deps + config via the prototype, but
        // carries its OWN input, so a handler reading `scope.input.message` after an await sees ITS OWN
        // message, never a later one - each in-flight message owns its input on its own scope object, so
        // concurrent messages cannot cross-contaminate.
        const msgScope = Object.create(getScope()) as { input: SynthesizedScope["input"]; };
        msgScope.input = { params: input.params, query: input.query, message: value };
        return run(() => message(ws, msgScope as WebSocketMessageHandlerScope));
      };
    }
    return controller;
  };
}

/** Builds the connect-time function-form scope: `config` + `input` + lazily-resolved injected deps. */
function buildScope(
  container: Container,
  input: WsTypedInput,
  inject: Readonly<Record<string, ServiceToken<FlareService>>>,
): SynthesizedScope {
  const base = {
    config: <T>(token: ConfigToken<T>): T => container.resolveCfg(token),
    input,
  };
  return attachScopeDeps(base, inject, (token) => container.resolveDep(token));
}

/** Runs an error handler under the runner, logging (never rethrowing) if it throws: the ONE error-handler failure policy both forms and both backings share. */
function runErrorHandler(run: LogRunner, invoke: () => void): void {
  try {
    run(invoke);
  } catch (e) {
    _log("error", "WebSocket error handler failed", { error: toErrorField(e) });
  }
}
