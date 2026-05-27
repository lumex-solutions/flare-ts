import type { JsonValue } from "@flare-ts/lib";
import type { Container } from "../services/container.js";
import type { CFWLoggerTransport, LoggerTransport } from "./transport.js";
import { LOG_CONFIG } from "../config/flare-config.js";
import { FlareService } from "../services/composition/flare-service.js";
import { LOG_LEVELS, type LogError, loggerALS, type LogLevel, type LogMeta, type LogRecord } from "./types.js";

/**
 * Structured logger that emits records to one or more registered transports.
 *
 * Filters records below the configured minimum level globally and per-transport,
 * attaches request context from {@link loggerALS} when context capture is enabled,
 * and drives transport startup and shutdown in registration order.
 *
 * @typeParam T - Shape of the `meta` object accepted by log methods.
 */
export class Logger<T extends Record<string, JsonValue> = Record<string, JsonValue>> extends FlareService {
  static readonly deps = [] as const;
  static readonly config = [LOG_CONFIG] as const;

  #transports: LoggerTransport[] = [];
  #minLevel: LogLevel = "info";
  #enableContext = false;
  #transportLevels = new Map<string, LogLevel>();

  constructor(transports: LoggerTransport[], container: Container) {
    super(container);
    this.#transports = transports;
  }

  /** @internal */
  protected get transports(): readonly LoggerTransport[] {
    return this.#transports;
  }

  /** @internal */
  protected configure(): void {
    const logCfg = this.config(LOG_CONFIG);

    this.#minLevel = logCfg.level;
    this.#enableContext = logCfg.enableContext ?? false;

    for (const transport of this.#transports) {
      const transportName = getTransportName(transport);
      const transportCfg = logCfg.transports?.[transportName];
      if (transportCfg) {
        this.#transportLevels.set(transportName, transportCfg.level);
      }
    }
  }

  /** @internal */
  protected flushBootstrapBuffer(): void {
    // Flush bootstrap buffer after transports are ready, to ensure no records are lost.
    for (const record of _buffer) {
      this.#emit(record.level, record.message, record.meta);
    }
    _buffer.length = 0;
  }

  /** @internal */
  protected emitTransportShutdownStart(transport: LoggerTransport, transportLimit: number): number {
    const transportName = getTransportName(transport);
    const start = Date.now();
    this.#emit(
      "trace",
      "Lifecycle event",
      {
        phase: "shutdown",
        component: "transport",
        event: "start",
        name: transportName,
      },
      undefined,
      transportLimit,
    );
    return start;
  }

  /** @internal */
  protected emitTransportShutdownReady(transport: LoggerTransport, start: number, transportLimit: number): void {
    this.#emit(
      "trace",
      "Lifecycle event",
      {
        phase: "shutdown",
        component: "transport",
        event: "ready",
        name: getTransportName(transport),
        durationMs: Date.now() - start,
      },
      undefined,
      transportLimit,
    );
  }

  /** Emits a record at trace level. */
  trace(message: string, meta?: LogMeta<T>): void {
    this.#emit("trace", message, meta);
  }
  /** Emits a record at debug level. */
  debug(message: string, meta?: LogMeta<T>): void {
    this.#emit("debug", message, meta);
  }
  /** Emits a record at info level. */
  info(message: string, meta?: LogMeta<T>): void {
    this.#emit("info", message, meta);
  }
  /** Emits a record at warn level. */
  warn(message: string, meta?: LogMeta<T>): void {
    this.#emit("warn", message, meta);
  }
  /**
   * Emits a record at error level. Pass an error value as the first argument
   * to attach a structured `error` field assembled via {@link toErrorField}.
   */
  error(message: string, meta?: LogMeta<T>): void;
  error(error: unknown, message: string, meta?: LogMeta<T>): void;
  error(messageOrError: string | unknown, messageOrMeta?: string | LogMeta<T>, meta?: LogMeta<T>): void {
    if (typeof messageOrError === "string") {
      this.#emit("error", messageOrError, messageOrMeta as LogMeta<T> | undefined);
      return;
    }

    const message = typeof messageOrMeta === "string" ? messageOrMeta : "Error";
    this.#emit("error", message, meta, toErrorField(messageOrError));
  }
  /**
   * Emits a record at fatal level. Pass an error value as the first argument
   * to attach a structured `error` field assembled via {@link toErrorField}.
   */
  fatal(message: string, meta?: LogMeta<T>): void;
  fatal(error: unknown, message: string, meta?: LogMeta<T>): void;
  fatal(messageOrError: string | unknown, messageOrMeta?: string | LogMeta<T>, meta?: LogMeta<T>): void {
    if (typeof messageOrError === "string") {
      this.#emit("fatal", messageOrError, messageOrMeta as LogMeta<T> | undefined);
      return;
    }

    const message = typeof messageOrMeta === "string" ? messageOrMeta : "Fatal error";
    this.#emit("fatal", message, meta, toErrorField(messageOrError));
  }

  /** Starts every registered transport in registration order, then flushes the bootstrap buffer. */
  override onStart(): Promise<void> | void {
    return this.#startAsync();
  }

  /** Stops every registered transport in reverse registration order. */
  override onStop(): Promise<void> | void {
    return this.#stopAsync();
  }

  #emit(
    level: LogLevel,
    message: string,
    meta?: LogMeta,
    error?: LogError,
    transportLimit = this.#transports.length,
  ): void {
    const record: LogRecord = {
      timestamp: Date.now(),
      level,
      message,
    };

    if (meta) record.meta = meta;
    if (error) record.error = error;
    if (this.#enableContext) {
      const store = loggerALS.getStore();

      if (store) {
        record.context = store.context;
        if (store.state) record.state = store.state;
      }
    }

    const levelNum = LOG_LEVELS[level];
    const minLevelNum = LOG_LEVELS[this.#minLevel];

    for (let i = 0; i < transportLimit; i++) {
      const transport = this.#transports[i]!;
      const transportLevel = this.#transportLevels.get(getTransportName(transport));
      const transportLevelNum = LOG_LEVELS[transportLevel ?? this.#minLevel];

      const effectiveMinLevelNum = transportLevel ? transportLevelNum : minLevelNum;
      if (levelNum < effectiveMinLevelNum) continue;
      transport.write(record);
    }
  }

  async #startAsync(): Promise<void> {
    this.configure();

    for (const transport of this.transports) {
      const transportName = getTransportName(transport);
      const start = Date.now();
      _log("trace", "Lifecycle event", {
        phase: "startup",
        component: "transport",
        event: "start",
        name: transportName,
      });
      await transport.onStart?.();
      _log("trace", "Lifecycle event", {
        phase: "startup",
        component: "transport",
        event: "ready",
        name: transportName,
        durationMs: Date.now() - start,
      });
    }

    this.flushBootstrapBuffer();
  }

  async #stopAsync(): Promise<void> {
    for (let i = this.transports.length - 1; i >= 0; i--) {
      const transport = this.transports[i]!;
      const start = this.emitTransportShutdownStart(transport, i + 1);
      await transport.onStop?.();
      this.emitTransportShutdownReady(transport, start, i);
    }
  }
}

/**
 * Synchronous logger variant for Cloudflare Workers.
 *
 * Behaves like {@link Logger} except that `onStart` and `onStop` run without
 * awaiting promises, matching the CFW host lifecycle.
 *
 * @typeParam T - Shape of the `meta` object accepted by log methods.
 */
export class CFWLogger<T extends Record<string, JsonValue> = Record<string, JsonValue>> extends Logger<T> {
  constructor(transports: CFWLoggerTransport[], container: Container) {
    super(transports, container);
  }

  override onStart(): void {
    this.configure();

    for (const transport of this.transports as CFWLoggerTransport[]) {
      transport.onStart?.();
    }

    this.flushBootstrapBuffer();
  }

  override onStop(): void {
    for (let i = this.transports.length - 1; i >= 0; i--) {
      const transport = this.transports[i]! as CFWLoggerTransport;
      const start = this.emitTransportShutdownStart(transport, i + 1);
      transport.onStop?.();
      this.emitTransportShutdownReady(transport, start, i);
    }
  }
}

function getTransportName(transport: LoggerTransport): string {
  return (transport.constructor as typeof LoggerTransport).transportName;
}

const _buffer: LogRecord[] = [];
/**
 * Buffers framework-internal log calls made before the real {@link Logger} is ready.
 *
 * Fatals are written to stderr immediately. Every other level is appended to a
 * module-scope buffer that is drained through the configured transports during
 * `Logger.onStart()`.
 *
 * @internal
 */
export const _log = (level: LogLevel, message: string, meta?: LogMeta): void => {
  if (level === "fatal") {
    console.error(`[flare] FATAL: ${message}${meta ? " " + JSON.stringify(meta) : ""}\n`);
    return;
  }

  const record: LogRecord = {
    timestamp: Date.now(),
    level,
    message,
  };

  if (meta) record.meta = meta;

  _buffer.push(record);
};

/**
 * Normalizes a thrown value into a structured {@link LogError}.
 *
 * Returns `{ name, message, stack? }` for `Error` instances, or `{ message }`
 * built from `String(err)` for any other value.
 */
export function toErrorField(err: unknown): LogError {
  if (!(err instanceof Error)) return { message: String(err) };

  const name = err.name === "Error" ? err.constructor.name : err.name;
  const field: LogError = { name, message: err.message };
  if (err.stack) field.stack = err.stack;
  return field;
}
