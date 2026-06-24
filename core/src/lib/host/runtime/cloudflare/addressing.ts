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
 * To carry DO state across the boundary, use the blessed seams (`room.mount` and
 * `forwardDurable`), which sanitize the reserved headers and then encode the framework-owned
 * state tokens from `ctx` onto the forwarded request:
 *
 * ```ts
 * // State-carrying path: forwardDurable sanitizes reserved headers and encodes only the
 * // framework-owned state tokens from ctx onto the forwarded request.
 * await forwardDurable(ctx, env.ROOM_DO, RoomDO, name, ctx.req.nativeRequest);
 * ```
 */

import { sanitizeForwardHeaders } from "./state-crossing.js";

/**
 * Wraps a native `DurableObjectStub` in a `Proxy` whose `.fetch()` strips the framework-reserved
 * `x-flare-state` / `x-flare-trace` headers before dispatch, while every other member (RPC method
 * closures, `Symbol.dispose`/`Symbol.asyncDispose`, ...) passes straight through.
 *
 * This makes `durable(...).fetch()` a state-free raw tunnel by construction: a client-forged state
 * envelope on a forwarded raw request can never reach the DO, so a developer cannot accidentally
 * inject DO `static state` by forwarding `ctx.req.nativeRequest`. State-carrying forwards must go
 * through `forwardDurable`, which encodes the framework-owned tokens after sanitizing.
 *
 * @internal Exported only for unit testing the proxy behavior in isolation.
 */
export function wrapStub<T extends Rpc.DurableObjectBranded | undefined>(
  stub: DurableObjectStub<T>,
): DurableObjectStub<T> {
  return new Proxy(stub, {
    get(target, prop) {
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
  }) as DurableObjectStub<T>;
}

/** Options for `durable(...)` placement. Extends the base get-options with `jurisdiction`. */
export type DurableAddressingOpts =
  & DurableObjectNamespaceGetDurableObjectOptions
  & { readonly jurisdiction?: DurableObjectJurisdiction; };

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
): DurableObjectStub<T> {
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
