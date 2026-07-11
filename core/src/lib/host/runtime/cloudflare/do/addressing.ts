/**
 * Typed addressing helper for resolving a named Durable Object stub.
 *
 * A free function exported from `@flare-ts/core/cloudflare`. Uses the CF namespace API
 * directly so the returned stub carries the namespace's type parameter with zero `as any`.
 *
 * @example
 * host.http.get("/rooms/:name", { inject: { bindings: Bindings } }, async (ctx, scope) => {
 *   const stub = durable(scope.bindings.env.ROOM, ctx.req.rawRouteParams.name!);
 *   const state = await stub.getState();
 *   return new FlareResponse(200, state);
 * });
 *
 * @remarks
 * **Security: `durable(...).fetch()` is a state-free raw tunnel by construction.**
 *
 * The stub returned by `durable(...)` strips the framework-reserved `x-flare-state` and
 * `x-flare-trace` headers on every `.fetch()` call before dispatch. A client-forged state
 * envelope therefore can never reach a Durable Object through this path, even when you forward
 * a raw inbound client request to a DO that declares `static state`:
 *
 * ```ts
 * // Safe: the wrapped stub deletes any client-supplied x-flare-state / x-flare-trace headers
 * // before the request reaches the DO. No DO state crosses through durable().fetch().
 * const stub = durable(env.ROOM_DO, name);
 * await stub.fetch(ctx.req.nativeRequest);
 * ```
 *
 * RPC methods, `Symbol.dispose`/`Symbol.asyncDispose`, and every non-`fetch` member pass
 * through untouched, and a plain `fetch()` carrying no reserved headers is unaffected (method,
 * body, and all non-reserved headers cross intact). Treat `durable(...).fetch(...)` as a
 * state-free raw tunnel.
 *
 * The UNPROTECTED path is the raw binding without `durable()`
 * (`env.ROOM_DO.get(id).fetch(clientRequest)`): nothing strips a client-forged state envelope
 * there, and the receiving Durable Object trusts it (state-crossing.ts documents the trust
 * model). Route DO traffic through `durable()` or a mount, or strip the reserved headers
 * yourself before a raw forward.
 *
 * To carry DO state across the boundary, use the blessed seams (`DurableHandle.mount` and
 * the stub's own `forward`), which sanitize the reserved headers and then encode the
 * framework-owned state tokens from `ctx` onto the forwarded request:
 *
 * ```ts
 * // State-carrying path: forward() sanitizes reserved headers and encodes only the
 * // framework-owned state tokens from ctx onto the forwarded request.
 * await durable(env.ROOM_DO, name).forward(ctx, RoomDO);
 * ```
 */

import type { FlareHttpContext } from "../../../../arcs/http/transport/flare-http-context.js";
import type { FlareDurableObjectClass } from "./durable-object.js";
import { applyInboundEnvelope, reseedOutboundState, sanitizeForwardHeaders } from "./state-crossing.js";

/**
 * The stub `durable()` returns: the native stub with a raw-tunnel `fetch` plus the
 * state-carrying `forward`.
 */
export type DurableStub<T extends Rpc.DurableObjectBranded | undefined> = DurableObjectStub<T> & {
  /**
   * Forwards a request to this instance WITH state crossing: sanitizes the reserved
   * headers, encodes the framework-owned state tokens from `ctx`, dispatches, and
   * re-seeds outbound state from the response.
   *
   * `req` defaults to the current native request. Contrast `fetch`, the state-free
   * raw tunnel.
   */
  forward(ctx: FlareHttpContext, cls: FlareDurableObjectClass, req?: Request): Promise<Response>;
};

/** Options for `durable(...)` placement. Extends the base get-options with `jurisdiction`. */
export type DurableAddressingOpts =
  & DurableObjectNamespaceGetDurableObjectOptions
  & { readonly jurisdiction?: DurableObjectJurisdiction; };

/**
 * Wraps a native `DurableObjectStub` in a `Proxy` whose `.fetch()` strips the framework-reserved
 * `x-flare-state` / `x-flare-trace` headers before dispatch, while every other member (RPC method
 * closures, `Symbol.dispose`/`Symbol.asyncDispose`, ...) passes straight through.
 *
 * This makes `durable(...).fetch()` a state-free raw tunnel by construction: a client-forged state
 * envelope on a forwarded raw request can never reach the DO, so a developer cannot accidentally
 * inject DO `static state` by forwarding `ctx.req.nativeRequest`. State-carrying forwards go
 * through the stub's own `forward`, which encodes the framework-owned tokens after sanitizing.
 *
 * @internal Exported only for unit testing the proxy behavior in isolation.
 */
export function wrapStub<T extends Rpc.DurableObjectBranded | undefined>(
  stub: DurableObjectStub<T>,
): DurableStub<T> {
  return new Proxy(stub, {
    get(target, prop) {
      if (prop === "forward") {
        // State-carrying path: encode on the RAW target so the envelope survives
        // (routing through the wrapped fetch would strip it after encoding).
        // Mirrors installExplicitMount's forward block (router.ts): same apply/fetch/reseed
        // sequence, kept inline on both request paths rather than behind a shared frame.
        return async (ctx: FlareHttpContext, cls: FlareDurableObjectClass, req?: Request): Promise<Response> => {
          const forwarded = new Request(req ?? (ctx.req.nativeRequest as Request));
          applyInboundEnvelope(ctx, cls, forwarded);
          const res = await target.fetch(forwarded);
          return reseedOutboundState(ctx, cls, res);
        };
      }
      if (prop === "fetch") {
        return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const req = new Request(input as RequestInfo, init);
          sanitizeForwardHeaders(req.headers);
          return target.fetch(req);
        };
      }
      // Preserve RPC method closures and disposal symbols by reading off the real stub.
      return Reflect.get(target, prop, target);
    },
  }) as DurableStub<T>;
}

/**
 * Resolves a named Durable Object stub from a typed namespace.
 *
 * - No placement opts: calls `namespace.getByName(name)`.
 * - `locationHint` only: calls `namespace.getByName(name, { locationHint })`.
 * - `jurisdiction` (with or without `locationHint`): calls
 *   `namespace.jurisdiction(jurisdiction).getByName(name, remainingOpts)`.
 *
 * The returned stub carries the namespace type parameter `T`, so RPC methods on the
 * DO class are available without casting.
 *
 * @param namespace - The typed `DurableObjectNamespace<T>` from `scope.bindings.env.MY_BINDING`.
 * @param name - The stable string name for this DO instance.
 * @param opts - Optional placement and jurisdiction hints.
 */
export function durable<T extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<T>,
  name: string,
  opts?: DurableAddressingOpts,
): DurableStub<T> {
  let stub: DurableObjectStub<T>;
  if (opts?.jurisdiction !== undefined) {
    const { jurisdiction, ...rest } = opts;
    const scoped = namespace.jurisdiction(jurisdiction);
    // After scoping, `rest` is a plain `DurableObjectNamespaceGetDurableObjectOptions`.
    const getOpts = Object.keys(rest).length > 0
      ? (rest as DurableObjectNamespaceGetDurableObjectOptions)
      : undefined;
    stub = getOpts !== undefined ? scoped.getByName(name, getOpts) : scoped.getByName(name);
  } else if (opts !== undefined && Object.keys(opts).length > 0) {
    stub = namespace.getByName(name, opts as DurableObjectNamespaceGetDurableObjectOptions);
  } else {
    stub = namespace.getByName(name);
  }
  return wrapStub(stub);
}
