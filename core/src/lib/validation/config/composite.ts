/**
 * The config validation layer: the context shape config validators inspect and the
 * composite factory that assembles them.
 */
import type { JsonObject } from "@flare-ts/lib";
import type { ConfigToken, OpaqueConfigToken } from "../../config/flare-config.js";
import { CompositeValidator } from "../composite-validator.js";
import { MissingConfigKeyValidator } from "./missing-config-key-validator.js";
import { UnregisteredTokenValidator } from "./unregistered-token-validator.js";

/**
 * Context passed to config-layer validators.
 *
 * Covers token registration consistency and key/field presence in the resolved config.
 *
 * @internal
 */
export type ConfigValidationContext = {
  /** All config tokens registered on the host via cfg(). */
  readonly registeredTokens: ReadonlySet<OpaqueConfigToken>;
  /** Built-in tokens exempt from field-level presence checks (e.g. HOST_CONFIG, LOG_CONFIG). */
  readonly defaultTokens: ReadonlySet<OpaqueConfigToken>;
  /** The fully resolved config object produced by #compileConfig. */
  readonly resolvedConfig: Readonly<JsonObject>;
  /** Declared config arrays from every registered class (controllers, services, middleware). */
  readonly classConfigDeclarations: ReadonlyArray<readonly ConfigToken<unknown>[] | undefined>;
};

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
