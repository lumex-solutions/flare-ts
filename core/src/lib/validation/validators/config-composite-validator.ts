import type { ConfigValidationContext } from "../contexts.js";
import { CompositeValidator } from "../composite-validator.js";
import { MissingConfigKeyValidator } from "./config/missing-config-key-validator.js";
import { UnregisteredTokenValidator } from "./config/unregistered-token-validator.js";

/**
 * Creates the composite validator for the config layer.
 *
 * Runs in order: unregistered tokens -> missing keys/fields.
 * All validators run and collect their results; build does not halt on the first error.
 */
export function createConfigValidator(): CompositeValidator<ConfigValidationContext> {
  return new CompositeValidator<ConfigValidationContext>([
    new UnregisteredTokenValidator(),
    new MissingConfigKeyValidator(),
  ]);
}
