/**
 * The Cloudflare runtime: the cf adapter, FlareAppCF's export() terminal, and Durable Object mount registration.
 */
import type { JsonObject } from "@flare-ts/lib";
import type { HttpArc } from "../../../arcs/http/http-arc.js";
import type { CfLoggerTransportClass } from "../../../logger/runtime/cloudflare/cf-transport.js";
import type { TestRequestInput } from "../../../testing/types/flare-test-req.js";
import type { ValidationError } from "../../../validation/types.js";
import type { IFlareHost } from "../../flare-host.js";
import type { HostRuntimeAdapter } from "../../types/adapter.js";
import type { FlareDurableObjectClass, SeedMap } from "./do/durable-object.js";
import type { CloudflareHostExtension, DurableHandle } from "./registration.js";
import type { MountRecord, PendingMountRecord } from "./router.js";
import type { CfValidationGraph } from "./validate-graph.js";
import { WebSocketChannels } from "../../../arcs/ws/channels/web-socket-channels.js";
import { WS_REGISTRATIONS } from "../../../arcs/ws/ws-arc.js";
import { CfConsoleTransport } from "../../../logger/runtime/cloudflare/cf-console-transport.js";
import { CfLogger } from "../../../logger/runtime/cloudflare/cf-logger.js";
import { FlareValidationError } from "../../../validation/flare-validation-error.js";
import { FlareAppBase } from "../../flare-app-base.js";
import { COMPILE_INSTANCE_CONTAINER, REGISTER_BUILD_HOOK, SET_HOST_STATE } from "../../types/const.js";
import { Bindings } from "./bindings.js";
import { buildCfTestRequest, WORKER_CHANNELS_UNSUPPORTED } from "./handlers/cf-handler-base.js";
import { WorkerHandler } from "./handlers/worker-handler.js";
import { durableRegistration, registerDurableObject } from "./registration.js";
import { installExplicitMount, snapshotFrontDoorPatterns } from "./router.js";
import { compileDurableArcs, compileDurableWsArcs, validateCfGraph } from "./validate-graph.js";
import { consumedTokensByClass, createMountValidator } from "./validation/composite.js";

/** Fetch handler returned by {@link FlareAppCF.export}; the default export of a Worker. */
export type WorkerExportedHandle = {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response>;
};

/**
 * Cloudflare adapter shape: the base {@link HostRuntimeAdapter} plus a `setup` hook. Its `extendHost`
 * stamps only the {@link CloudflareHostExtension} (durableObject); it does not return the singleton
 * extension, so `host.singleton()` does not exist on a Cloudflare host.
 */
export type CloudflareAdapter =
  & HostRuntimeAdapter<FlareAppCF, CfLoggerTransportClass, "sync", CloudflareHostExtension>
  & { setup(host: IFlareHost): void; };

/**
 * Compiled Cloudflare application returned by `host.build()`, exposing the export terminal.
 *
 * - {@link export}: the Worker fetch handler (the module default export).
 */
export class FlareAppCF extends FlareAppBase {
  /**
   * Starts the shared graph and returns the Worker fetch handler, seeded with the isolate env on first request.
   */
  export(): WorkerExportedHandle {
    this.start();
    this.host[SET_HOST_STATE]("ready");

    let handler: WorkerHandler | undefined;
    let initFailure: { error: unknown; } | undefined;
    return {
      fetch: async (request, env) => {
        // First request seeds the per-isolate container. Keep it failure-atomic: latch the error so a
        // poisoned graph returns a clean 500 (never escapes the isolate) instead of re-running the
        // partial seed on every subsequent request.
        if (initFailure) throw initFailure.error;
        if (!handler) {
          try {
            const seed: SeedMap = new Map();
            seed.set(Bindings, (c) => new Bindings(c, env));
            // Runtime backstop only: a plain Worker has no broadcast domain, so this instance throws
            // the actionable guidance on publish. Declared WebSocketChannels deps already fail host.build().
            seed.set(WebSocketChannels, (c) => new WebSocketChannels(c, WORKER_CHANNELS_UNSUPPORTED));
            const container = this.host[COMPILE_INSTANCE_CONTAINER](seed);
            // host.ws is the Worker-hosted WebSocket arc (plain-Worker connections, e.g. a proxy/echo
            // endpoint); the handler intercepts matching upgrades before HTTP routing.
            handler = new WorkerHandler(this.host, container, this.http as HttpArc<"sync">, this.host.ws);
          } catch (error) {
            initFailure = { error };
            throw error;
          }
        }
        return handler.fetch(request);
      },
    };
  }
}

/**
 * Cloudflare runtime adapter (Worker isolate). `host.build()` returns a {@link FlareAppCF} whose
 * terminal (`.export()`) produces the export shape. Use {@link buildCf} to bind a bundled `flare.json`
 * and `env`; this bare adapter defaults both to empty.
 */
export const cf: CloudflareAdapter = {
  runtime: "cloudflare",
  lifecycle: "sync",
  // A fresh object each read - CF has no filesystem, so the bare adapter carries no config and must
  // not share a mutable default. `buildCf(flareJson)` supplies the bundled config instead.
  get flareJsonFile(): JsonObject {
    return {};
  },
  env: {},
  defaultLoggerTransports: [CfConsoleTransport],
  createApp(host) {
    return new FlareAppCF(host);
  },
  createLogger(transports, container) {
    return new CfLogger(transports, container);
  },
  createTestRequest(input: TestRequestInput) {
    return buildCfTestRequest(input);
  },
  // Sets `deferSingletonCompile` because there are no user singletons on CF; services resolve
  // lazily per context. The extendHost hook owns validation (ownValidation), so the host skips
  // its generic suite; .export() does NOT revalidate.
  setup(host) {
    host[REGISTER_BUILD_HOOK]((ctx) => {
      ctx.deferSingletonCompile = true;
    });
  },
  extendHost(host: IFlareHost): CloudflareHostExtension {
    const durableObjects: FlareDurableObjectClass[] = [];
    const mounts: PendingMountRecord[] = [];

    // Mount hook: registered before the validate hook so mount routes exist when duplicate-route
    // validation runs. Snapshots developer routes, checks subtree/missing-resolver conflicts,
    // then installs the mount routes.
    host[REGISTER_BUILD_HOOK](() => {
      if (mounts.length === 0) return;
      // The CF adapter's lifecycle is pinned "sync"; IFlareHost.http cannot carry that.
      const frontDoor = host.http as HttpArc<"sync">;

      // Attach each DO's registered resolver to its mount records:
      //   - resolve-kind (literal trailing): required; the validator errors when absent.
      //   - param-kind: optional; attach when registered, leave undefined when not.
      const pending: PendingMountRecord[] = mounts.map((m) => {
        const resolver = durableRegistration(m.cls)?.resolver;
        return resolver !== undefined ? { ...m, resolve: resolver } : m;
      });

      const { patterns: devPatterns, groupPrefixes } = snapshotFrontDoorPatterns(frontDoor);
      // host.ws routes count as front-door routes here: the Worker intercepts a matching upgrade BEFORE
      // the mount forward, so a WS route inside a mounted subtree would silently steal connections the
      // DO owns. Same exclusivity invariant, same build error.
      const wsPatterns = host.ws[WS_REGISTRATIONS]().map((r) => r.pattern);

      // One aggregated mount pass: missing resolvers, subtree conflicts, and state
      // provision collect together and throw once, before any mount route installs.
      const errors = createMountValidator().validate({
        mounts: pending,
        frontDoor,
        frontDoorPatterns: [...devPatterns, ...wsPatterns],
        groupPrefixes,
        consumedByClass: consumedTokensByClass(durableObjects),
      });
      if (errors.length > 0) throw new FlareValidationError(errors);

      // The resolve validator proved every resolve-kind record has its resolver, so the
      // pending shape narrows to the install-ready MountRecord.
      const finalMounts = pending as readonly MountRecord[];
      for (const record of finalMounts) {
        installExplicitMount(frontDoor, record);
      }
    });

    // Own the build's validation. The host runs this after all build hooks (so installed mount routes
    // are visible), then owns the outcome (throws on errors, emits warnings). On success it also
    // compiles the per-DO arcs.
    host[REGISTER_BUILD_HOOK]((buildCtx) => {
      buildCtx.ownValidation((): ValidationError[] => {
        // Identify zero-route DOs: their arcs get nulled so the DurableHandler returns 404 for them, but
        // they still participate in dep validation (a DO can exist for state only, with no HTTP routes).
        const zeroRoute = new Set<FlareDurableObjectClass>();
        for (const cls of durableObjects) {
          const arc = durableRegistration(cls)?.arc;
          if (arc && arc.conRegistrations.length === 0 && arc.groups.length === 0) {
            zeroRoute.add(cls);
          }
        }
        // Zero-route DOs still need dep validation: they get a stub entry (their existing empty
        // arc) so durableDepErrors sees their static deps. `ws` is undefined for a DO that never
        // used the DO handle's `ws` arc (opt-in). Arc is non-null here; nulling happens below.
        const allDurables = durableObjects.map((cls) => {
          const reg = durableRegistration(cls)!;
          return { cls, arc: reg.arc!, ws: reg.wsArc };
        });
        // The validation graph includes ALL DOs for dep/reachability checks but only arced DOs for
        // HTTP arc validation.
        const arcedDurables = allDurables.filter((d) => !zeroRoute.has(d.cls));
        const graph: CfValidationGraph = {
          frontDoor: host.http as HttpArc<"sync">,
          frontDoorWs: host.ws,
          durables: allDurables,
          scoped: [...buildCtx.scopedRegistrations],
          singletons: [...buildCtx.singletonRegistrations],
          prebuiltTokens: buildCtx.prebuiltTokens,
          configRegistrations: buildCtx.configRegistrations,
          defaultConfigTokens: buildCtx.defaultConfigTokens,
          resolvedConfig: buildCtx.resolvedConfig,
        };
        const results = validateCfGraph(graph);
        // On any error, return the results for the host to throw; do not compile a rejected graph.
        if (results.some((e) => e.severity === "error")) return results;
        // No errors: null-out zero-route arcs (the DurableHandler 404s for them) and compile the arced ones.
        for (const cls of zeroRoute) durableRegistration(cls)!.arc = null;
        compileDurableArcs({ ...graph, durables: arcedDurables });
        // WS arcs compile for EVERY DO (never nulled; a DO may be WS-only with no HTTP routes).
        compileDurableWsArcs(allDurables);
        return results;
      });
    });

    return {
      durableObject: ((
        cls: FlareDurableObjectClass,
        optsOrBuilder?: { binding?: string; } | ((handle: DurableHandle) => void),
        maybeBuilder?: (handle: DurableHandle) => void,
      ) => {
        // Two-arg builder form: `durableObject(cls, builder)`. Detect a function in the 2nd slot and
        // treat it as the builder, defaulting opts.
        const opts = typeof optsOrBuilder === "function" ? undefined : optsOrBuilder;
        const builder = typeof optsOrBuilder === "function" ? optsOrBuilder : maybeBuilder;
        durableObjects.push(cls);
        const handle = registerDurableObject(host, cls, opts?.binding ?? cls.name, mounts);
        // Co-location builder form: invoke the optional builder with the handle before returning.
        // The handle is still returned so callers may add further registrations after the builder.
        if (builder !== undefined) builder(handle);
        return handle;
      }) as CloudflareHostExtension["durableObject"],
    };
  },
};

/**
 * Builds a Cloudflare adapter bound to a bundled `flare.json` and optional `env`.
 *
 * On Cloudflare there is no filesystem, so the config is supplied at module scope rather than read
 * from disk.
 */
export function buildCf(flareJsonFile: JsonObject, env: Record<string, string | undefined> = {}): CloudflareAdapter {
  return {
    runtime: cf.runtime,
    lifecycle: cf.lifecycle,
    flareJsonFile,
    env,
    defaultLoggerTransports: cf.defaultLoggerTransports,
    createApp: cf.createApp,
    createLogger: cf.createLogger,
    createTestRequest: cf.createTestRequest,
    setup: cf.setup,
    extendHost: cf.extendHost!,
  };
}
