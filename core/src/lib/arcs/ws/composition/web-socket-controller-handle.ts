/**
 * Build-time handle for attaching the pre-handshake `upgrade` hook after `host.ws.controller()`.
 */
import type { InjectMap } from "../../../services/types/inject.js";
import type { WebSocketDescriptor } from "./contract/ws-contract.js";
import type { WebSocketUpgradeHandler } from "./types/handlers.js";
import type { WsRegistrationBase } from "./types/registration.js";
import type { WebSocketUpgradeOptions } from "./types/route-options.js";
import { type ErasedUpgradeHandler, registerUpgradeHook } from "./upgrade-hook.js";

/**
 * The build-time handle `host.ws.controller(path, cls)` returns. The connection's lifecycle lives on
 * the class (`open`/`message`/`close`/`error` methods), so this handle carries only the one moment the
 * class cannot: the pre-handshake `upgrade` hook, which runs in request scope before any instance
 * exists - the same registration-site placement as a Durable Object mount's `resolve` gateway.
 * Generic over the route's descriptor `T` (from the class's contract), so the hook's `scope` is fully
 * typed. Constructed by the arc only (exported type-only from the package index, like
 * {@link WebSocketRouteHandle} it is dev-held, never dev-constructed).
 */
export class WebSocketControllerHandle<T extends WebSocketDescriptor = {}> {
  readonly #registration: Pick<WsRegistrationBase, "inject" | "upgrade">;
  constructor(registration: Pick<WsRegistrationBase, "inject" | "upgrade">) {
    this.#registration = registration;
  }

  /**
   * Registers the pre-handshake `upgrade` hook.
   *
   * The one moment with request context, before the handshake completes (and before the controller
   * instance exists). The bare form's scope carries no named deps (a controller route declares no
   * `inject` map); the options form declares the hook's OWN `inject` plus the state tokens it
   * `provides` via `scope.state`. Either way the hook resolves from the same per-connection container
   * the instance later uses, so a service it touches is an ordinary connection-scoped service.
   */
  upgrade(handler: WebSocketUpgradeHandler<{}, T>): this;
  upgrade<I extends InjectMap>(opts: WebSocketUpgradeOptions<I>, handler: WebSocketUpgradeHandler<I, T>): this;
  upgrade(
    // Same erasure boundary as the route handle: never-typed params keep every overload assignable.
    optsOrHandler: ErasedUpgradeHandler | WebSocketUpgradeOptions,
    maybeHandler?: ErasedUpgradeHandler,
  ): this {
    registerUpgradeHook(this.#registration, optsOrHandler, maybeHandler);
    return this;
  }
}
