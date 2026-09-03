/**
 * Build-time handle for attaching WebSocket route lifecycle behaviors after `host.ws.route()`.
 */
import type { InjectMap } from "../../../services/types/inject.js";
import type { WebSocketDescriptor } from "./contract/ws-contract.js";
import type {
  WebSocketCloseHandler,
  WebSocketErrorHandler,
  WebSocketMessageHandler,
  WebSocketOpenHandler,
  WebSocketUpgradeHandler,
} from "./types/handlers.js";
import type { WsHandlerFns, WsRegistrationBase } from "./types/registration.js";
import type { WebSocketUpgradeOptions } from "./types/route-options.js";
import { type ErasedUpgradeHandler, registerUpgradeHook } from "./upgrade-hook.js";

/**
 * The build-time handle `host.ws.route(path, opts)` returns: attach the connection's lifecycle behaviors
 * with individual registrar calls, the same way `host.http.get`/`post` register behaviors (never an
 * object literal). Runs once at registration; the handlers are static and receive the live connection
 * per event. Generic over the route's inject map `D` and descriptor `T`, so `scope`/`socket` are fully typed.
 *
 * Two-lifetime split mirrors the Durable Object: the route handle is to the live connection what
 * `DurableHandle` is to the request context - build-time config vs the runtime object. Constructed by
 * the arc only (exported type-only from the package index, like `HttpGroup` it is dev-held, never
 * dev-constructed); it collects behaviors into the registration's shared {@link WsHandlerFns}, and the
 * pre-handshake `upgrade` hook into the registration's `upgrade` slot.
 */
export class WebSocketRouteHandle<D extends InjectMap = {}, T extends WebSocketDescriptor = {}> {
  readonly #behaviors: WsHandlerFns;
  readonly #registration: Pick<WsRegistrationBase, "inject" | "upgrade">;
  constructor(behaviors: WsHandlerFns, registration: Pick<WsRegistrationBase, "inject" | "upgrade">) {
    this.#behaviors = behaviors;
    this.#registration = registration;
  }

  // Each registrar assigns its fully-typed handler into the erased-`ws`/`scope` slot; the slots are
  // method-syntax (bivariant), so this is the one declared widening boundary and needs no casts, while
  // the slots' concrete arity is still enforced at the invocation sites.

  /** Registers the OPEN behavior. */
  open(handler: WebSocketOpenHandler<D, T>): this {
    this.#assertUnset("open");
    this.#behaviors.open = handler;
    return this;
  }

  /** Registers the per-message behavior. */
  message(handler: WebSocketMessageHandler<D, T>): this {
    this.#assertUnset("message");
    this.#behaviors.message = handler;
    return this;
  }

  /** Registers the terminal-close behavior. */
  close(handler: WebSocketCloseHandler<D, T>): this {
    this.#assertUnset("close");
    this.#behaviors.close = handler;
    return this;
  }

  /** Registers the transport/protocol-error behavior. */
  error(handler: WebSocketErrorHandler<D, T>): this {
    this.#assertUnset("error");
    this.#behaviors.error = handler;
    return this;
  }

  /**
   * Registers the pre-handshake `upgrade` hook.
   *
   * The one moment with request context, before the handshake completes. The bare form shares the
   * route's `inject` map (the hook's deps resolve from the same per-connection container the handlers
   * use); the options form declares the hook's OWN `inject` plus the state tokens it `provides` via
   * `scope.state`.
   */
  upgrade(handler: WebSocketUpgradeHandler<D, T>): this;
  upgrade<I extends InjectMap>(opts: WebSocketUpgradeOptions<I>, handler: WebSocketUpgradeHandler<I, T>): this;
  upgrade(
    // never-typed params make every overload's fully-typed handler assignable here; the registration's
    // method-syntax slot re-widens it to the erased shape (the same one-boundary erasure as behaviors).
    optsOrHandler: ErasedUpgradeHandler | WebSocketUpgradeOptions,
    maybeHandler?: ErasedUpgradeHandler,
  ): this {
    registerUpgradeHook(this.#registration, optsOrHandler, maybeHandler);
    return this;
  }

  // "One call each" is the documented registrar contract; a second call would silently replace the first
  // handler (a classic merge artifact), so fail fast at registration time instead.
  #assertUnset(slot: keyof WsHandlerFns): void {
    if (this.#behaviors[slot]) {
      throw new Error(`[flare] host.ws route already has a "${slot}" handler: each behavior can be attached once`);
    }
  }
}
