/**
 * Cross-layer input shapes for the WebSocket arc: what a route match produces raw, what the compiled
 * route's input builder parses it into, and the outcome of decoding one inbound message. Shared by the
 * build step (which compiles the per-route builders), the arc's resident connection, and the Durable
 * Object hibernation drivers.
 */

/** The raw upgrade inputs a match produces: decoded path params and the query string. */
export type WsRawInput = {
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
};

/**
 * The connect-time query: the raw `URLSearchParams` when the route declares no `query`, else the
 * parsed record (a `WebSocketQueryPrimitive` produces exactly `string | number | boolean | undefined`).
 */
export type WsQueryInput = Readonly<Record<string, string | number | boolean | undefined>> | URLSearchParams;

/**
 * The typed connect-time input exposed as `scope.input.{params,query}` (message added per-inbound
 * elsewhere). `params` values are `string` for undeclared params and `string | number` for declared ones
 * (a descriptor's `params` parsers produce exactly those two types); `query` is the {@link WsQueryInput}
 * union. Handlers see the descriptor-narrowed view (`WebSocketInput`); this is its erased
 * runtime shape.
 */
export type WsTypedInput = {
  readonly params: Readonly<Record<string, string | number>>;
  readonly query: WsQueryInput;
};

/**
 * Outcome of decoding one inbound message through a compiled route's `decode`. `value` is the validated
 * message, typed by the SAME descriptor the sibling `message` handler was registered against (the
 * pairing a heterogeneous route list cannot state, so it is erased here). On `ok: false` the decode has
 * ALREADY applied the one rejection policy (logged and closed 1008); the driver only stops delivering.
 */
export type WsDecodedMessage =
  | { readonly ok: true; readonly value: unknown; }
  | { readonly ok: false; };
