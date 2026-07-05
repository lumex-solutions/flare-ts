/**
 * Composite validator factory for the WebSocket arc validation layer.
 */
import type { WsValidationContext } from "../contexts.js";
import { CompositeValidator } from "../composite-validator.js";
import { WsConfigValidator } from "./ws/config-validator.js";
import { WsRouteConflictValidator } from "./ws/route-conflict-validator.js";
import { WsRouteSyntaxValidator } from "./ws/route-syntax-validator.js";

/**
 * Creates the composite validator for the WebSocket arc layer.
 *
 * Runs in order: route syntax -> route conflicts (WS-internal duplicates + HTTP/WS cross-arc) -> config
 * sanity. All validators run and collect their results; the build does not halt on the first error.
 */
export function createWsValidator(): CompositeValidator<WsValidationContext> {
  return new CompositeValidator<WsValidationContext>([
    new WsRouteSyntaxValidator(),
    new WsRouteConflictValidator(),
    new WsConfigValidator(),
  ]);
}
