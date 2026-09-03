/**
 * The RAW shape of one registered WebSocket endpoint: exactly the authoring facts the registrar
 * collected, nothing derived. `host.build()` compiles this into the arc's executable `WsPipeline`
 * (see build.ts). Keeping the two apart mirrors the HTTP arc (raw `conRegistrations` vs compiled
 * pipelines): a registration is what the dev declared; deriving anything from it is the compile
 * step's job.
 *
 * Both authoring forms normalize onto this: the function form supplies a {@link WsHandlerFns}
 * collected from its `WebSocketRouteHandle` registrars, the class form supplies a {@link WebSocketControllerClass}.
 * The handlers are type-erased here (they were fully typed at the registrar boundary); the compiled
 * controller drives the erased slots.
 */
import type { FlareService } from "../../../../services/composition/flare-service.js";
import type { ServiceToken } from "../../../../services/types/token.js";
import type { StateToken } from "../../../../state/flare-state.js";
import type { WsTypedInput } from "../../pipeline/input.js";
import type { WebSocketControllerClass } from "../classes/controller-base.js";
import type { WebSocketDescriptor } from "../contract/ws-contract.js";
import type { WebSocketUpgradeResult } from "./handlers.js";

/** Fields common to both authoring forms: what the registrar resolves before the kind-specific part. */
export type WsRegistrationBase = {
  readonly pattern: string;
  readonly subprotocols: readonly string[];
  readonly descriptor: WebSocketDescriptor | undefined;
  readonly inject: Readonly<Record<string, ServiceToken<FlareService>>>;
  readonly state: readonly StateToken[];
  /** From the `channel:` route option: channels to subscribe the connection to at open. */
  readonly channel: WebSocketChannelSelector | undefined;
  /**
   * The pre-handshake `upgrade` hook, or absent when the route has none. Deliberately MUTABLE (the
   * one non-readonly field): the function form attaches it through the `WebSocketRouteHandle` after
   * `route()` returned, the same live-write idiom as {@link WsHandlerFns}. The arc reads it per upgrade
   * through the registration (never a compiled snapshot), so a handle attach is always honored.
   */
  upgrade?: WsUpgradeRegistration | undefined;
  /**
   * Whether this route hibernates on a Durable Object (default true): the runtime owns the socket and the
   * DO may be evicted while idle. `false` opts into the resident backing (the DO holds the socket in memory).
   * Ignored off a DO - a plain Worker isolate cannot hibernate a socket, so it is always resident.
   */
  readonly hibernate: boolean;
};

/** The subscribe-at-open channel selector: computes the channel(s) this connection joins from its input. */
export type WebSocketChannelSelector = (scope: { input: WsTypedInput; }) => string | readonly string[];

/**
 * The lifecycle behaviors a function-form route registers via its `WebSocketRouteHandle`.
 *
 * Stored with CONCRETE (if type-erased on `ws`/`scope`) call signatures rather than `(...args: never[])`,
 * so the compile step's call sites are checked against the real arity/shape - if a handler's signature
 * changes (e.g. close's trailing args), build.ts stops compiling instead of silently passing stale positionals.
 * Declared in METHOD syntax deliberately: methods are bivariant even under strictFunctionTypes, so the
 * `WebSocketRouteHandle` registrars can assign their fully-typed handlers straight into these slots with no cast -
 * the erasure happens at this one declared boundary instead of four cast sites.
 */
export type WsHandlerFns = {
  open?(ws: unknown, scope: unknown): void | Promise<void>;
  message?(ws: unknown, scope: unknown): void | Promise<void>;
  close?(ws: unknown, scope: unknown, code: number, reason: string, wasClean: boolean): void | Promise<void>;
  error?(ws: unknown, scope: unknown, err: Error): void;
};

/**
 * The raw `upgrade` hook facts on a registration.
 *
 * What validation reads (`inject`/`provides`) plus the erased hook function (same declared-boundary
 * erasure as {@link WsHandlerFns}, hence the method syntax). Both authoring forms register through
 * their handle's `upgrade` registrar, so one shape serves both. `provides` declares which state
 * tokens the hook writes so provision checks can see them at build; the hook is not limited to them
 * at runtime.
 */
export type WsUpgradeRegistration = {
  readonly inject: Readonly<Record<string, ServiceToken<FlareService>>>;
  readonly provides: readonly StateToken[];
  handler(upgrade: unknown, scope: unknown): WebSocketUpgradeResult | Promise<WebSocketUpgradeResult>;
};

/** One registered WS endpoint: a function-form behavior set, or a controller class. */
export type WsRegistration =
  & WsRegistrationBase
  & (
    | { readonly kind: "handlers"; readonly behaviors: WsHandlerFns; }
    | { readonly kind: "controller"; readonly cls: WebSocketControllerClass; }
  );
