/**
 * The route-options grammar for `host.ws.route` / `host.ws.controller`: the two authoring forms and
 * the option fields they share. A route declares its descriptor exactly like HTTP: spell the fields
 * loose in the options (`incoming`/`outgoing`/`params`/`query`/`subprotocols`), or pass a branded
 * `socketContract` entry as `contract:` - never both.
 */
import type { InjectMap } from "../../../../services/types/inject.js";
import type { StateToken } from "../../../../state/types/state-token.js";
import type { WebSocketDescriptor, WebSocketToken } from "../contract/ws-contract.js";
import type { WebSocketChannelSelector } from "./registration.js";

/** The {@link WebSocketDescriptor} field names usable as loose inline route-option keys. */
export type WebSocketKey = "incoming" | "outgoing" | "params" | "query" | "subprotocols";

/** Registration options common to both route-option forms (DI, state, and connection flags). */
export type WebSocketRouteOptionsBase<D extends InjectMap = InjectMap> = {
  /** DI map: declared services appear on `scope` by name (function form). */
  readonly inject?: D;
  /** State tokens the connection's `ws.state` uses (build-validated). */
  readonly state?: readonly StateToken[];
  /** Channel(s) to subscribe the connection to at open, computed from its input (subscribe-at-open sugar). */
  readonly channel?: WebSocketChannelSelector;
  /**
   * On a Durable Object, whether this route hibernates (default `true`): the runtime owns the socket and the
   * DO may be evicted while idle, so you stop paying wall-clock during silence. Per-connection memory that
   * must survive a wake belongs in `ws.state` (serialized to the socket attachment); closure locals and
   * controller instance fields do not survive. `hibernate: false` opts into the resident backing (the DO
   * holds the socket in memory, unbounded state, but billable while open). Ignored off a DO.
   */
  readonly hibernate?: boolean;
};

/**
 * Loose form: the socket descriptor's fields (`incoming`/`outgoing`/`params`/`query`/`subprotocols`)
 * are spelled directly in the route options. `contract` is forbidden here - one form or the other,
 * never both (mirrors HTTP's route options exactly).
 */
export type LooseWebSocketRouteOptions<D extends InjectMap = InjectMap> =
  & WebSocketRouteOptionsBase<D>
  & WebSocketDescriptor
  & { contract?: never; };

/**
 * Branded form: the descriptor is supplied as a {@link WebSocketToken} from a `socketContract` entry.
 * The loose descriptor keys are forbidden here.
 */
export type ContractWebSocketRouteOptions<D extends InjectMap = InjectMap> =
  & WebSocketRouteOptionsBase<D>
  & { readonly contract: WebSocketToken; }
  & { [K in WebSocketKey]?: never; };

/** Per-route options for `host.ws.route` / `host.ws.controller`: loose inline fields OR a branded `contract`. */
export type WebSocketRouteOptions<D extends InjectMap = InjectMap> =
  | LooseWebSocketRouteOptions<D>
  | ContractWebSocketRouteOptions<D>;
