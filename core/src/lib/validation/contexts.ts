import type { JsonObject } from "@flare-ts/lib";
import type { CorsConfig } from "../arcs/http/composition/types/cors.js";
import type {
  ControllerRegistration,
  GroupRegistration,
  MiddlewareRegistration,
} from "../arcs/http/types/registration.js";
import type { ConfigToken, FlareWebSocketsConfig, OpaqueConfigToken } from "../config/flare-config.js";
import type { FlareService } from "../services/composition/flare-service.js";
import type { ServiceRegistration } from "../services/types/registration.js";
import type { ServiceToken } from "../services/types/types.js";

/**
 * Context passed to service-layer validators.
 * Includes all service registrations plus all controllers and middleware
 * (including those from groups) so service dependency checks are complete.
 */
export type ServiceValidationContext = {
  readonly scoped: ServiceRegistration<FlareService>[];
  readonly singletons: ServiceRegistration<FlareService>[];
  /** All controllers, top-level and from every registered group. */
  readonly controllers: ControllerRegistration[];
  /** Global (top-level) middleware registrations. */
  readonly middleware: MiddlewareRegistration[];
  /**
   * Tokens for singleton instances pre-created by the framework
   * (e.g. Logger) and placed directly into singletonInstances rather than
   * registered via a lazy factory. Treated as valid resolved deps.
   */
  readonly prebuiltTokens: ReadonlySet<ServiceToken<FlareService>>;
};

/**
 * Context passed to HTTP-layer validators.
 * Covers route structure, middleware chains, and contracts.
 */
export type HttpValidationContext = {
  /** All controllers, top-level and from every registered group. */
  readonly controllers: ControllerRegistration[];
  /** Global (top-level) middleware registrations. */
  readonly globalMiddleware: MiddlewareRegistration[];
  /** All registered route groups. */
  readonly groups: GroupRegistration[];
  /** Arc-level CORS policy, if configured via `host.http.cors()`. */
  readonly corsConfig?: CorsConfig | undefined;
  /**
   * Whether `cookies.secret` is set in the resolved config; gates the signed-cookies check.
   * Absent is treated as not configured (fail-closed), so a route declaring `signedCookies` errors.
   */
  readonly cookieSecretConfigured?: boolean;
};

/**
 * Context passed to WebSocket-layer validators.
 * Covers WS-internal route uniqueness, HTTP/WS cross-arc path conflicts, and config sanity.
 */
export type WsValidationContext = {
  /** Registered WebSocket route patterns (e.g. `/chat/:room`). */
  readonly wsPatterns: readonly string[];
  /** All HTTP controllers, so WS paths can be checked against HTTP routes for cross-arc conflicts. */
  readonly httpControllers: readonly ControllerRegistration[];
  /** The resolved `websockets` config section, for caps/timers sanity checks. */
  readonly config: FlareWebSocketsConfig | undefined;
};

/**
 * Context passed to config-layer validators.
 * Covers token registration consistency and key/field presence in the resolved config.
 */
export type ConfigValidationContext = {
  /** All config tokens registered on the host via cfg(). */
  readonly registeredTokens: ReadonlySet<OpaqueConfigToken>;
  /** Built-in tokens exempt from field-level presence checks (e.g. HOST_CONFIG, LOG_CONFIG). */
  readonly defaultTokens: ReadonlySet<OpaqueConfigToken>;
  /** The fully resolved config object produced by #compileConfig. */
  readonly resolvedConfig: Readonly<JsonObject>;
  /** Declared config arrays from every registered class (controllers, services, middleware). */
  readonly classConfigDeclarations: ReadonlyArray<ConfigToken<unknown>[] | undefined>;
};
