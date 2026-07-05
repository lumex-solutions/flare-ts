/**
 * Allow runtime-specific import here because all four runtimes support `node:async_hooks`.
 * The only caveat is on CF Workers, where the nodejs_compat flag must be enabled, but that's
 * a documented requirement for using Flare on that platform.
 *
 * AsyncLocalStorage context does not automatically flow into CF Workers `waitUntil()`
 * callbacks. If deferred work needs request context, snapshot the current store and re-enter it
 * with {@link runWithLogStore} inside the callback.
 */
// eslint-disable-next-line no-restricted-imports
import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonValue } from "@flare-ts/lib";
import type { FlareService } from "../services/composition/flare-service.js";
import type { Container } from "../services/container.js";
import type { ServiceToken } from "../services/types/types.js";
import type { Logger } from "./logger.js";
import type { CFWLoggerTransport, LoggerTransport } from "./transport.js";

/** Severity of a log record. Ordered from least to most severe. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Numeric ordering of {@link LogLevel} values used for filtering. */
export const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

/** Discriminated union of all built-in log context shapes. */
export type LogContext = HostLogContext | HttpLogContext | WebSocketLogContext;

/** Context attached to records emitted from host lifecycle code. */
export type HostLogContext<T extends LogMeta = LogMeta> = T & {
  source: "flare:host";
};

/** Context attached to records emitted from inside an HTTP request scope. */
export type HttpLogContext<T extends LogMeta = LogMeta> = T & {
  source: "flare:http";
  requestId: string;
  method: string;
  url: string;
  /** Correlation id: the front-door requestId that forwarded to this DO handler. DO context only. */
  parentRequestId?: string;
};

/**
 * Context attached to records emitted from inside a WebSocket connection's handlers. One context spans
 * the connection's whole life, keyed by the connection id (not an HTTP requestId). Per-message context
 * (e.g. a routed message name) is deliberately deferred to the message-vocabulary work, which defines
 * what a message's identity even is.
 */
export type WebSocketLogContext<T extends LogMeta = LogMeta> = T & {
  source: "flare:ws";
  /** The connection id (minted at upgrade), correlating every log from this connection. */
  connectionId: string;
  /** The upgrade path. */
  url: string;
};

/** Extension of {@link HttpLogContext} carrying stage and target metadata for error records. */
export type HttpErrorContext<T extends LogMeta = LogMeta> = HttpLogContext<T> & {
  stage?: string;
  target?: string;
};

/** Free-form structured metadata attached to a single log call. */
export type LogMeta<T extends Record<string, JsonValue> = Record<string, JsonValue>> = T;

/** Ambient state attached to every record emitted within a request scope. */
export type LogState = Record<string, JsonValue>;

/** Structured shape of a record's `error` field. */
export interface LogError extends Record<string, JsonValue> {
  name?: string;
  message: string;
  stack?: string;
}

/** Payload of an active {@link loggerALS} entry. */
export interface LogStore {
  context: LogContext;
  state?: LogState;
}

/** Fully assembled record handed to every transport's `write` method. */
export interface LogRecord {
  timestamp: number;
  level: LogLevel;
  message: string;
  context?: LogContext;
  state?: LogState;
  meta?: LogMeta;
  error?: LogError;
}

/** Constructor type for concrete {@link Logger} subclasses. */
export type LoggerClass = {
  new(container: Container): Logger;
  deps: readonly ServiceToken<FlareService>[];
};

/** Constructor type for concrete {@link LoggerTransport} subclasses. */
export type LoggerTransportClass = {
  new(container: Container): LoggerTransport;
  readonly transportName: string;
  deps?: readonly ServiceToken<FlareService>[];
};

/** Constructor type for concrete {@link CFWLoggerTransport} subclasses. */
export type CFWLoggerTransportClass = {
  new(container: Container): CFWLoggerTransport;
  readonly transportName: string;
  deps?: readonly ServiceToken<FlareService>[];
};

/**
 * AsyncLocalStorage that carries the active log context and state for the
 * current request scope. Populated by the host on entry, read by the logger
 * on every emit when `log.enableContext` is `true`.
 */
export const loggerALS = new AsyncLocalStorage<LogStore>();

/**
 * Snapshots the currently active log store so detached callbacks (for example,
 * Cloudflare `waitUntil`) can re-enter the same logging scope later.
 */
export function captureLogStore(): LogStore | undefined {
  const store = loggerALS.getStore();
  if (!store) return undefined;
  return {
    context: { ...store.context },
    ...(store.state ? { state: { ...store.state } } : {}),
  };
}

/**
 * Runs `fn` inside the provided log store. When `store` is undefined, runs
 * `fn` without entering AsyncLocalStorage.
 */
export function runWithLogStore<T>(store: LogStore | undefined, fn: () => T): T {
  if (!store) return fn();
  return loggerALS.run(store, fn);
}
