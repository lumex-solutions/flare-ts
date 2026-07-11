/**
 * Log vocabulary: levels, the context shapes records carry, the record type, and the
 * transport constructor type host composition consumes.
 */
import type { JsonValue } from "@flare-ts/lib";
import type { Container } from "../services/container.js";
import type { LogError } from "./fields.js";
import type { LoggerTransport } from "./transport.js";

/**
 * Severity of a log record.
 *
 * Ordered from least to most severe.
 */
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
export type HostLogContext = LogMeta & {
  source: "flare:host";
};

/** Context attached to records emitted from inside an HTTP request scope. */
export type HttpLogContext = LogMeta & {
  source: "flare:http";
  requestId: string;
  method: string;
  url: string;
  /** Correlation id: the front-door requestId that forwarded to this DO handler. DO context only. */
  parentRequestId?: string;
};

/**
 * Context attached to records emitted from inside a WebSocket connection's handlers.
 *
 * One context spans the connection's whole life, keyed by the connection id (not an
 * HTTP requestId).
 */
export type WebSocketLogContext = LogMeta & {
  source: "flare:ws";
  /** The connection id (minted at upgrade), correlating every log from this connection. */
  connectionId: string;
  /** The upgrade path. */
  url: string;
};

/** Extension of {@link HttpLogContext} carrying stage and target metadata for error records. */
export type HttpErrorContext = HttpLogContext & {
  stage?: string;
  target?: string;
};

/** Free-form structured metadata attached to a single log call. */
export type LogMeta = Record<string, JsonValue>;

/** Ambient state attached to every record emitted within a request scope. */
export type LogState = Record<string, JsonValue>;

/** Fully assembled record handed to every transport's `write` method. */
export type LogRecord = {
  timestamp: number;
  level: LogLevel;
  message: string;
  context?: LogContext;
  state?: LogState;
  meta?: LogMeta;
  error?: LogError;
};

/** Constructor type for concrete {@link LoggerTransport} subclasses. */
export type LoggerTransportClass = {
  new(container: Container): LoggerTransport;
  readonly transportName: string;
  /** Transports cannot inject services; the base pins `deps` to `never[]`, restated here. */
  deps?: readonly never[];
};

export type { LogError } from "./fields.js";
