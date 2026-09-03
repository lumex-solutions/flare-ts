/**
 * The one registration policy for the pre-handshake `upgrade` hook, shared by the function-form
 * {@link WebSocketRouteHandle} and the controller-form `WebSocketControllerHandle`: overload
 * resolution, inject-key validation, the once-only guard, and the write into the registration's
 * `upgrade` slot.
 */
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { ServiceToken } from "../../../services/types/token.js";
import type { StateToken } from "../../../state/flare-state.js";
import type { WebSocketUpgradeResult } from "./types/handlers.js";
import type { WsRegistrationBase } from "./types/registration.js";
import type { WebSocketUpgradeOptions } from "./types/route-options.js";
import { assertInjectKeys } from "../../../services/scope.js";

const NO_PROVIDES: readonly StateToken[] = [];

/** The erased hook shape the registrars pass through (never-typed params keep every overload assignable). */
export type ErasedUpgradeHandler = (
  upgrade: never,
  scope: never,
) => WebSocketUpgradeResult | Promise<WebSocketUpgradeResult>;

/**
 * Registers one `upgrade` hook on `registration`. The bare form shares the route's `inject` map (the
 * hook's deps resolve from the same per-connection container the handlers use); the options form
 * declares the hook's OWN `inject` plus the state tokens it `provides` via `scope.state`.
 */
export function registerUpgradeHook(
  registration: Pick<WsRegistrationBase, "inject" | "upgrade">,
  optsOrHandler: ErasedUpgradeHandler | WebSocketUpgradeOptions,
  maybeHandler: ErasedUpgradeHandler | undefined,
): void {
  if (registration.upgrade) {
    throw new Error(`[flare] host.ws route already has an "upgrade" hook: each behavior can be attached once`);
  }
  // Overload resolution mirrors host.ws.controller: the handler is either the sole arg or the second.
  const handler = typeof optsOrHandler === "function" ? optsOrHandler : maybeHandler;
  const opts = typeof optsOrHandler === "function" ? undefined : optsOrHandler;
  if (typeof handler !== "function") {
    // A JS (or type-erased) caller can invoke the opts overload without a handler; fail at registration.
    throw new Error("[flare] host.ws upgrade hook requires a handler function");
  }
  // `InjectMap` is an open record; the cast narrows to the service-token shape the registration stores,
  // exactly as the route registrar narrows its own `inject` option.
  const inject = (opts?.inject ?? registration.inject) as Readonly<Record<string, ServiceToken<FlareService>>>;
  assertInjectKeys(inject);
  // The upgrade scope carries `state` alongside `config`/`input`; the route's own inject map was only
  // checked against the handler scope's reserved keys, so re-check the extra one here for both forms.
  if ("state" in inject) {
    throw new Error(`inject key "state" is reserved on the upgrade scope. Rename the dependency.`);
  }
  registration.upgrade = { inject, provides: opts?.provides ?? NO_PROVIDES, handler };
}
