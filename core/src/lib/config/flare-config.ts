/**
 * Typed config tokens over `flare.json`: the `flareConfig` factory, the token shapes it
 * mints, and the pre-defined tokens for Flare's own `host`, `cookies`, `log`, and
 * `websockets` sections.
 */
import { enums, schema } from "@flare-ts/lib";
import {
  array,
  bool,
  defaultTo,
  type DescriptorValue,
  int,
  optional,
  type SchemaToken,
  str,
  type TypedPrimitive,
} from "@flare-ts/lib/schema";
import type { FlareHost } from "../host/flare-host.js";
import type { LogLevel } from "../logger/types.js";

// `unknown` here is the descriptor's element type at the registry boundary: the
// concrete per-field types are recovered through `InferConfigField` / `InferConfigShape`
// when a descriptor object is passed to `flareConfig`. Narrowing it further would
// require an existential which TypeScript cannot express.
type ConfigDescriptorValue = DescriptorValue<unknown>;

/** The value type a single descriptor field resolves to: the primitive's or schema's payload. */
type InferConfigField<P> = P extends TypedPrimitive<infer T> ? T : P extends SchemaToken<infer T> ? T : never;

/**
 * Untyped face of a config token: the value-level shape the host registry handles
 * without carrying the section's TypeScript type parameter.
 */
export type OpaqueConfigToken = {
  readonly key: string;
  /**
   * Runtime field descriptors. Present when a descriptor was passed to {@link flareConfig}.
   * Keys are field names; used by {@link FlareHost.build} to validate that every declared
   * field is present and non-null in the resolved config section.
   */
  readonly descriptor?: Readonly<Record<string, ConfigDescriptorValue>>;
};
/**
 * Identifies a top-level section of the resolved Flare config object with type info.
 *
 * Created via {@link flareConfig}. Used with `this.config(token)` on {@link FlareBase}
 * subclasses and with the `config` resolver passed to inline handlers and builder callbacks.
 *
 * The `_type` field is a phantom type: it exists only at compile time to carry the
 * TypeScript type `T` through the token so that `this.config(token)` can return `T`.
 */
export type ConfigToken<T> = OpaqueConfigToken & {
  readonly _type?: T;
};

/** The config section shape derived from a {@link flareConfig} descriptor object. */
export type InferConfigShape<T extends Record<string, ConfigDescriptorValue>> = {
  [K in keyof T]: InferConfigField<T[K]>;
};

/**
 * Resolved shape of the `host` section of `flare.json`.
 *
 * Covers listen address, timeouts, body limits, and the request-id / timing toggles.
 */
export type HostConfig = {
  /** Current runtime environment name. Defaults to `"development"`. */
  env: string;
  /** HTTP listen port. Defaults to `3000`. */
  port: number;
  /** HTTP listen host. Defaults to `"localhost"`. */
  host: string;
  /** Graceful shutdown timeout in milliseconds. Defaults to `10000` (10 seconds). */
  shutdownTimeout: number;
  /**
   * Global default maximum request body size in bytes. Defaults to `2 * 1024 * 1024` (2 MB).
   * Can be overridden per-route via the `maxBodyBytes` field on a {@link RequestDescriptor}.
   */
  maxBodyBytes: number;
  /**
   * When `true` (default), Flare adds an `X-Request-Id` header to every response.
   * Set to `false` to disable.
   */
  requestIdHeader?: boolean;
  /**
   * When `true`, Flare captures `Date.now()` at request instantiation time and exposes it
   * as `request.startTime` for application middleware and handlers.
   */
  requestTiming?: boolean;
  /**
   * Server-level keep-alive timeout in milliseconds. Defaults to `65000` (65 s),
   * longer than typical load-balancer idle timeouts so the LB closes first,
   * avoiding the 502/504 race pattern where the server closes a socket the LB
   * is about to reuse.
   */
  keepAliveTimeout: number;
  /**
   * Maximum time in milliseconds the server waits for complete HTTP headers.
   * Defaults to `60000` (60 s). Mirrors `http.Server.headersTimeout`.
   */
  headersTimeout: number;
  /**
   * Maximum time in milliseconds for an entire request (headers + body).
   * Defaults to `300000` (5 minutes). Set to `0` to disable for trusted
   * deployments or endpoints that rely on infrastructure-level deadlines.
   * Mirrors `http.Server.requestTimeout`.
   */
  requestTimeout: number;
};

/**
 * Resolved shape of the `cookies` section of `flare.json`.
 *
 * Holds the secret(s) used to sign and verify cookies via `ctx.cookies.setSigned` /
 * `getSigned`.
 */
export type CookiesConfig = {
  /**
   * Secret used to sign cookies and to verify incoming signatures. Required for
   * any route that declares `signedCookies: true`; absent by default, in which
   * case signed-cookie methods throw at runtime.
   */
  secret?: string;
  /**
   * Older secrets still accepted when verifying (but never used to sign), so a
   * secret can be rotated without invalidating cookies signed under the prior one.
   */
  previousSecrets?: string[];
};

/**
 * Resolved shape of the `log` section of `flare.json`.
 *
 * Covers level threshold, output format, async-context stamping, and per-transport
 * level overrides.
 */
export type LogConfig = {
  /** Minimum log level to emit. Defaults to `"debug"` in development, `"info"` otherwise. */
  level: LogLevel;
  /** Log output format for {@link ConsoleTransport}. Defaults to `"pretty"` in development, `"json"` otherwise. */
  format: "pretty" | "json";
  /** When `true`, the logger uses AsyncLocalStorage to stamp all LogRecords with a source and id. Defaults to `false`. */
  enableContext: boolean;
  /** Per-transport minimum level overrides. Keys are transport `static name` values. */
  transports?: Record<string, { level: LogLevel; }>;
};

/**
 * Creates a typed config token for a top-level section of `flare.json`.
 *
 * Pass a descriptor object whose keys are field names and whose
 * values are Flare primitives (`string`, `int`, `bool`, `date`). Mark a field
 * optional with `optional()`, `defaultTo()`, or `schema(...).optional()`.
 * Required fields (bare primitives) must be present in the resolved config.
 * The descriptor is retained at runtime so {@link FlareHost.build} can validate
 * that all required fields are present. TypeScript infers the section type
 * directly from the descriptor; no manual type annotation needed.
 *
 * Declare it at module scope, register it on the host via `host.cfg(token)`,
 * and add it to `static config` on any class that needs it.
 *
 * @param key - The top-level key in `flare.json` that this token maps to.
 * @param descriptor - Field descriptor keyed by field name. Required keys must appear in `flare.json` (or env).
 *
 * @example
 * ```ts
 * // config.ts
 * export const DbConfig = flareConfig('db', { url: str, password: str });
 *
 * // host.ts
 * host.cfg(DbConfig);
 *
 * // db-service.ts
 * class DbService extends FlareService {
 *   static config = [DbConfig];
 *
 *   async onStart() {
 *     const { url, password } = this.config(DbConfig);
 *   }
 * }
 * ```
 */
export function flareConfig<T extends Record<string, ConfigDescriptorValue>>(
  key: string,
  descriptor: T,
): ConfigToken<InferConfigShape<T>> {
  return { key, descriptor };
}

// TODO: Extract host and logging defaults into constants

/** Pre-defined token for Flare-internal host config (`host.env`, `host.port`). */
export const HOST_CONFIG: ConfigToken<HostConfig> = flareConfig("host", {
  env: defaultTo("development", str),
  port: defaultTo(3000, int),
  host: defaultTo("localhost", str),
  shutdownTimeout: defaultTo(10000, int),
  maxBodyBytes: defaultTo(2 * 1024 * 1024, int),
  requestIdHeader: defaultTo(true, bool),
  requestTiming: defaultTo(false, bool),
  keepAliveTimeout: defaultTo(65000, int),
  headersTimeout: defaultTo(60000, int),
  requestTimeout: defaultTo(300000, int),
});

/**
 * Pre-defined token for Flare-internal cookie config (`cookies.secret`). Both fields are optional, so
 * the type is left to inference: {@link CookiesConfig} is the resolved shape.
 */
export const COOKIES_CONFIG = flareConfig("cookies", {
  secret: optional(str),
  previousSecrets: optional(array(str)),
});

/**
 * Resolved shape of the `websockets` config section: the per-connection size caps and
 * liveness timers.
 */
export type WebSocketsConfig = {
  /** Largest assembled message (all fragments) accepted; a larger one closes 1009. */
  maxMessageSize: number;
  /** Largest single frame accepted. */
  maxFrameSize: number;
  /** Maximum number of fragments per message. */
  maxFragments: number;
  /** Outbound queue ceiling; a peer that stops reading and lets this much pile up is dropped. */
  maxBufferedBytes: number;
  /** Interval between keepalive pings (0 disables). */
  keepAliveIntervalMs: number;
  /** Close after this long with no inbound activity (0 disables). */
  idleTimeoutMs: number;
  /** After initiating close, force the socket shut if the peer does not echo within this long (0 disables). */
  closeGraceMs: number;
  /**
   * How inbound protocol pings are answered (Node transport only; the Cloudflare runtime answers pings
   * itself). `"each"` (the default) pongs every ping immediately, which is what heartbeat clients that
   * track pings by payload expect; a genuine ping flood trips the outbound buffer cap and closes.
   * `"coalesce"` answers once per drained read batch with the most recent ping's payload (an RFC 6455
   * 5.5.3 MAY), bounding pong amplification instead of closing.
   */
  pongPolicy: "each" | "coalesce";
  /**
   * App-level keepalive ping payload. When both this and {@link autoResponsePong} are set, a hibernating
   * Durable Object auto-answers this exact inbound text message with the pong WITHOUT waking (no billable
   * duration), so a client heartbeat never defeats hibernation. Max 2048 chars each. Cloudflare-only.
   */
  autoResponsePing?: string | undefined;
  /** The pong payload the runtime returns for an {@link autoResponsePing}. */
  autoResponsePong?: string | undefined;
};

/**
 * The built-in `websockets` defaults.
 *
 * The single source both the config token below and any WS arc compiled WITHOUT a
 * resolved config (a bare unit test) derive from, so the two can never drift.
 */
export const WEBSOCKETS_DEFAULTS = {
  maxMessageSize: 1024 * 1024,
  maxFrameSize: 1024 * 1024,
  maxFragments: 256,
  maxBufferedBytes: 16 * 1024 * 1024,
  keepAliveIntervalMs: 30_000,
  idleTimeoutMs: 120_000,
  closeGraceMs: 5_000,
  pongPolicy: "each",
} as const;

/** Pre-defined token for Flare-internal WebSocket config (size caps and liveness timers). */
export const WEBSOCKETS_CONFIG: ConfigToken<WebSocketsConfig> = flareConfig("websockets", {
  maxMessageSize: defaultTo(WEBSOCKETS_DEFAULTS.maxMessageSize, int),
  maxFrameSize: defaultTo(WEBSOCKETS_DEFAULTS.maxFrameSize, int),
  maxFragments: defaultTo(WEBSOCKETS_DEFAULTS.maxFragments, int),
  maxBufferedBytes: defaultTo(WEBSOCKETS_DEFAULTS.maxBufferedBytes, int),
  keepAliveIntervalMs: defaultTo(WEBSOCKETS_DEFAULTS.keepAliveIntervalMs, int),
  idleTimeoutMs: defaultTo(WEBSOCKETS_DEFAULTS.idleTimeoutMs, int),
  closeGraceMs: defaultTo(WEBSOCKETS_DEFAULTS.closeGraceMs, int),
  pongPolicy: defaultTo(WEBSOCKETS_DEFAULTS.pongPolicy, enums(["each", "coalesce"])),
  autoResponsePing: optional(str),
  autoResponsePong: optional(str),
});

const TRANSPORT_SCHEMA = schema({ level: enums(["trace", "debug", "info", "warn", "error", "fatal"]) });

/** Pre-defined token for Flare-internal log config (`log.level`, `log.format`). */
export const LOG_CONFIG: ConfigToken<LogConfig> = flareConfig("log", {
  level: defaultTo("info", enums(["trace", "debug", "info", "warn", "error", "fatal"])),
  format: defaultTo("json", enums(["pretty", "json"])),
  enableContext: defaultTo(false, bool),
  transports: schema([{ $record: TRANSPORT_SCHEMA }]).optional(),
});
