/**
 * Cross-layer route shapes for the WebSocket arc: the compiled, executable pipeline `host.build()`
 * derives from a raw registration, and the per-connection controller surface it carries. The WS analog
 * of the HTTP arc's `types/pipeline.ts`: build produces these, the arc's {@link WsConnection} and the
 * Durable Object hibernation engine drive them, and nothing else needs to cross that boundary.
 */
import type { SchemaToken, TypedPrimitive } from "@flare-ts/lib/schema";
import type { LogRunner } from "../../../logger/context.js";
import type { Container } from "../../../services/container.js";
import type { WsRegistration } from "../composition/types/registration.js";
import type { FlareWebSocketContext } from "../transport/flare-web-socket-context.js";
import type { WsTypedInput } from "./input.js";

/**
 * One route as the arc EXECUTES it: the raw {@link WsRegistration} plus everything `host.build()`
 * derived from it, compiled once per route (never per connection or per event). Pure DATA, like HTTP's
 * `Pipeline`: the operations over it (`buildInput`, `decodeMessage`) are shared functions taking the
 * pipeline, and `controller` is the one per-route behavior (HTTP's exec-fn analog).
 */
export type WsPipeline = {
  /** The raw authoring facts this pipeline was compiled from. */
  readonly registration: WsRegistration;
  /** The registration's pattern, lifted for the router compile and log contexts. */
  readonly pattern: string;
  /** Position in the arc's compiled pipeline list: the per-build route id hibernation attachments carry. */
  readonly index: number;
  /** Flattened `params` parser entries (undefined = undeclared): no per-event descriptor enumeration. */
  readonly params: ReadonlyArray<readonly [string, TypedPrimitive<string | number>]> | undefined;
  /** Flattened `query` parser entries (undefined = undeclared). */
  readonly query: ReadonlyArray<readonly [string, TypedPrimitive<string | number | boolean | undefined>]> | undefined;
  /** The `incoming` message schema (undefined = untyped route: raw wire messages pass through). */
  readonly incoming: SchemaToken<unknown> | undefined;
  /** Outbound serializer from the descriptor (undefined = raw passthrough). */
  readonly serialize: ((data: unknown) => string | Uint8Array) | undefined;
  /**
   * Binds this route's behavior to one connection, yielding its {@link WsController}. The authoring-form
   * branch (class vs synthesized-from-handlers) is resolved at compile, so both backings drive one
   * uniform surface.
   */
  readonly controller: WsControllerFactory;
};

/**
 * Per-connection controller factory: called once per resident connection (at open) and once per
 * hibernated event. Every method on the returned controller already runs under `run` (the connection's
 * logger runner), so drivers only sequence calls.
 */
export type WsControllerFactory = (
  container: Container,
  ws: FlareWebSocketContext<unknown>,
  input: WsTypedInput,
  run: LogRunner,
) => WsController;

/**
 * The ONE per-connection behavior surface both backings drive: a controller instance's lifecycle
 * methods. The class form is the author's instance (wrapped); the function form is synthesized onto
 * this same shape at build, exactly as HTTP compiles inline handlers into synthetic controllers.
 */
export type WsController = {
  open?(): void | Promise<void>;
  /** Receives the DECODED value; the per-message child scope (function form) is built internally. */
  message?(value: unknown): void | Promise<void>;
  close?(code: number, reason: string, wasClean: boolean): void | Promise<void>;
  /** Runs the error behavior under the runner, logging (never rethrowing) a throwing error handler. */
  error?(err: Error): void;
};

/** Segment index and name of one route param, captured at compile for extraction at match. */
export type WsRouteSegment = {
  readonly name: string;
  readonly index: number;
};

/** One matchable route held parallel to the router's match indices: its pipeline and its param segments. */
export type WsRoute = {
  readonly pipeline: WsPipeline;
  readonly segments: readonly WsRouteSegment[];
};
