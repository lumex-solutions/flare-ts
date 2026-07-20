/**
 * The WebSocket validation layer: the context shape WS validators inspect and the
 * composite factory that assembles them.
 */
import type { ControllerRegistration } from "../../arcs/http/types/registration.js";
import type { WebSocketsConfig } from "../../config/flare-config.js";
import { CompositeValidator } from "../composite-validator.js";
import { WsConfigValidator } from "./config-validator.js";
import { WsRouteConflictValidator } from "./route-conflict-validator.js";
import { WsRoutePriorityAmbiguityValidator } from "./route-priority-ambiguity-validator.js";
import { WsRouteSyntaxValidator } from "./route-syntax-validator.js";

/**
 * Context passed to WebSocket-layer validators.
 *
 * Covers WS-internal route uniqueness, HTTP/WS cross-arc path conflicts, and config sanity.
 *
 * @internal
 */
export type WsValidationContext = {
  /** Registered WebSocket route patterns (e.g. `/chat/:room`). */
  readonly wsPatterns: readonly string[];
  /** All HTTP controllers, so WS paths can be checked against HTTP routes for cross-arc conflicts. */
  readonly httpControllers: readonly ControllerRegistration[];
  /** The resolved `websockets` config section, for caps/timers sanity checks. */
  readonly config: WebSocketsConfig | undefined;
};

/**
 * Creates the composite validator for the WebSocket arc layer.
 *
 * Runs in order: route syntax -> route conflicts (WS-internal duplicates + HTTP/WS cross-arc) -> route
 * priority ambiguity -> config sanity. All validators run and collect their results; the build does
 * not halt on the first error.
 */
export function createWsValidator(): CompositeValidator<WsValidationContext> {
  return new CompositeValidator<WsValidationContext>([
    new WsRouteSyntaxValidator(),
    new WsRouteConflictValidator(),
    new WsRoutePriorityAmbiguityValidator(),
    new WsConfigValidator(),
  ]);
}
