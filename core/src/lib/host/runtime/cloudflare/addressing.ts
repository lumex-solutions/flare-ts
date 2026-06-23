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
 * **Security: raw-fetch state injection risk.**
 *
 * `durable(...)` returns a plain stub with no state-crossing logic. This is intentional for
 * RPC calls and state-free forwarding. However, if you forward a raw inbound client request
 * directly to a Durable Object that declares `static state`, the client-supplied request
 * headers arrive unmodified at the DO, including any `x-flare-state` header the client may
 * have crafted:
 *
 * ```ts
 * // UNSAFE when RoomDO has static state - the client controls ctx.req.nativeRequest headers:
 * const stub = durable(env.ROOM_DO, name);
 * await stub.fetch(ctx.req.nativeRequest);
 * ```
 *
 * The blessed forwarding seams (`room.mount` and `forwardDurable`) unconditionally strip
 * and rewrite the `x-flare-state` and `x-flare-trace` headers before dispatch, so they are
 * not vulnerable to this. Use them for any forward that should carry DO state:
 *
 * ```ts
 * // SAFE: forwardDurable sanitizes reserved headers and encodes only the framework-owned
 * // state tokens from ctx onto the forwarded request.
 * await forwardDurable(ctx, env.ROOM_DO, RoomDO, name, ctx.req.nativeRequest);
 * ```
 *
 * DOs are not internet-addressable, so exploiting this requires a developer to deliberately
 * forward a raw client request rather than using the provided seams. Treat
 * `durable(...).fetch(rawClientRequest)` as a state-free raw tunnel only.
 */

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
  if (opts?.jurisdiction !== undefined) {
    const { jurisdiction, ...rest } = opts;
    const scoped = namespace.jurisdiction(jurisdiction);
    // After scoping, `rest` is a plain `DurableObjectNamespaceGetDurableObjectOptions`.
    const getOpts = Object.keys(rest).length > 0
      ? (rest as DurableObjectNamespaceGetDurableObjectOptions)
      : undefined;
    return getOpts !== undefined ? scoped.getByName(name, getOpts) : scoped.getByName(name);
  }
  if (opts !== undefined && Object.keys(opts).length > 0) {
    return namespace.getByName(name, opts as DurableObjectNamespaceGetDurableObjectOptions);
  }
  return namespace.getByName(name);
}
