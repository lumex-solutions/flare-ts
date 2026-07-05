/**
 * WebSocket descriptor vocabulary and branded contract tokens for route authoring.
 */
import type { OpaqueSchemaToken, SchemaToken, TypedPrimitive } from "@flare-ts/lib/schema";
import type { ContractEntry, TypedContract } from "../../../../contract/contract.js";
import type { FlareWebSocketMessage } from "../../transport/flare-web-socket-message.js";
import { contract } from "../../../../contract/contract.js";

/** The raw WebSocket message wire types: text (`string`) or binary (`Uint8Array`). */
export type WebSocketRaw = string | Uint8Array;

/** Primitive descriptors accepted for a typed upgrade query parameter. */
export type WebSocketQueryPrimitive =
  | TypedPrimitive<string>
  | TypedPrimitive<string | undefined>
  | TypedPrimitive<number>
  | TypedPrimitive<number | undefined>
  | TypedPrimitive<boolean>
  | TypedPrimitive<boolean | undefined>;

/**
 * Static shape of one WebSocket route: inbound/outbound schemas and typed upgrade inputs. All fields
 * optional; spelled loose in route options or shared via a `socketContract` entry.
 */
export type WebSocketDescriptor = {
  /** Schema each inbound message is validated against; the validated value types the `message` handler. */
  incoming?: OpaqueSchemaToken;
  /** Schema for outbound values; when present, the connection's `send` serializes its argument. */
  outgoing?: OpaqueSchemaToken;
  /** Primitive descriptors for the upgrade path params (e.g. `/chat/:room`), typed into `scope.input.params`. */
  params?: Record<string, TypedPrimitive<number> | TypedPrimitive<string>>;
  /** Primitive descriptors for the upgrade URL query, typed into `scope.input.query`. */
  query?: Record<string, WebSocketQueryPrimitive>;
  /** Subprotocols this endpoint accepts; the handshake selects the first the client also offers. */
  subprotocols?: readonly string[];
};

/**
 * The inbound message type a descriptor produces: the validated value when `incoming` is declared,
 * otherwise a {@link FlareWebSocketMessage} (the rich wrapper - inspect `.text()`/`.json()`/`.isBinary`).
 */
export type WebSocketIncoming<T extends WebSocketDescriptor> = T["incoming"] extends SchemaToken<infer U> ? U
  : FlareWebSocketMessage;

/** The outbound value type a descriptor accepts (raw wire type when no `outgoing` schema). */
export type WebSocketOutgoing<T extends WebSocketDescriptor> = T["outgoing"] extends SchemaToken<infer U> ? U
  : WebSocketRaw;

/** The typed upgrade path params (untyped string map when none declared). */
export type WebSocketParams<T extends WebSocketDescriptor> = T["params"] extends Record<string, TypedPrimitive<infer _>>
  ? { readonly [K in keyof T["params"]]: T["params"][K] extends TypedPrimitive<infer N> ? N : never; }
  : Readonly<Record<string, string>>;

/** The typed upgrade query (raw `URLSearchParams` when none declared). */
export type WebSocketQuery<T extends WebSocketDescriptor> = T["query"] extends Record<string, TypedPrimitive<infer _>>
  ? { readonly [K in keyof T["query"]]: T["query"][K] extends TypedPrimitive<infer N> ? N : never; }
  : URLSearchParams;

/**
 * The CONNECT-time typed input every WS handler's `scope.input` carries (stable for the connection's
 * life): the upgrade path params and query. Mirrors the HTTP `scope.input` shape.
 */
export type WebSocketInput<T extends WebSocketDescriptor> = {
  readonly params: WebSocketParams<T>;
  readonly query: WebSocketQuery<T>;
};

/**
 * The `message` handler's `scope.input`: the connect-time input plus the validated inbound `message`.
 * `message` is the WS analog of HTTP's `scope.input.body` - the per-invocation payload lives on
 * `scope.input`, NOT as a separate handler argument, so the WS handler shape does not diverge from HTTP.
 */
export type WebSocketMessageInput<T extends WebSocketDescriptor> = WebSocketInput<T> & {
  readonly message: WebSocketIncoming<T>;
};

/**
 * Branded WS contract entry for one route (e.g. `Chat.chat`): what a route's `contract:` option accepts,
 * and the WS sibling of the HTTP `RequestToken`. The brand is type-level only; at runtime the entry is
 * a plain {@link WebSocketDescriptor}.
 */
export type WebSocketToken<T extends WebSocketDescriptor = WebSocketDescriptor> = ContractEntry<"ws", T>;

/**
 * Defines a typed WebSocket contract - the `"ws"` kind of the generic `contract` core, the WS sibling of
 * `httpContract`. A descriptor map keyed by route name, each value a {@link WebSocketDescriptor}. Attach an
 * entry to a route via `host.ws.route(path, { contract: MySocket.chat })`, or spell the
 * descriptor fields loose in the options instead.
 *
 * @example
 * ```ts
 * const Chat = socketContract({
 *   chat: { incoming: MsgIn, outgoing: MsgOut, params: { room: str } },
 * });
 * ```
 */
export function socketContract<T extends Record<string, WebSocketDescriptor>>(descriptor: T): TypedContract<"ws", T> {
  return contract("ws", descriptor);
}
