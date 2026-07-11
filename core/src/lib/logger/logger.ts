/**
 * The structured logger service: level filtering, context stamping, transport fan-out,
 * and the transport lifecycle it drives.
 */
import type { Container } from "../services/container.js";
import type { LoggerTransport } from "./transport.js";
import { LOG_CONFIG } from "../config/flare-config.js";
import { FlareService } from "../services/composition/flare-service.js";
import { _log, clearBootstrapBuffer, peekBootstrapBuffer } from "./bootstrap.js";
import { loggerALS } from "./context.js";
import { type LogError, toErrorField } from "./fields.js";
import { LOG_LEVELS, type LogLevel, type LogMeta, type LogRecord } from "./types.js";

/**
 * Structured logger that emits records to one or more registered transports.
 *
 * Filters records below the configured minimum level globally and per-transport,
 * attaches request context from {@link loggerALS} when context capture is enabled,
 * and drives transport startup and shutdown in registration order.
 */
export class Logger extends FlareService {
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
    // Clear only AFTER the loop: a transport throw mid-flush leaves the buffer intact.
    for (const record of peekBootstrapBuffer()) {
      this.#emit(record.level, record.message, record.meta);
    }
    clearBootstrapBuffer();
  }

  /** @internal */
  protected emitTransportStartupStart(transport: LoggerTransport): number {
    const start = Date.now();
    // Startup traces go through the bootstrap buffer (_log): the transports are not
    // ready yet, so these records surface in the post-start flush.
    _log("trace", "Lifecycle event", {
      phase: "startup",
      component: "transport",
      event: "start",
      name: getTransportName(transport),
    });
    return start;
  }

  /** @internal */
  protected emitTransportStartupReady(transport: LoggerTransport, start: number): void {
    _log("trace", "Lifecycle event", {
      phase: "startup",
      component: "transport",
      event: "ready",
      name: getTransportName(transport),
      durationMs: Date.now() - start,
    });
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
  trace(message: string, meta?: LogMeta): void {
    this.#emit("trace", message, meta);
  }
  /** Emits a record at debug level. */
  debug(message: string, meta?: LogMeta): void {
    this.#emit("debug", message, meta);
  }
  /** Emits a record at info level. */
  info(message: string, meta?: LogMeta): void {
    this.#emit("info", message, meta);
  }
  /** Emits a record at warn level. */
  warn(message: string, meta?: LogMeta): void {
    this.#emit("warn", message, meta);
  }
  /**
   * Emits a record at error level.
   *
   * Pass an error value as the first argument to attach a structured `error` field
   * assembled via {@link toErrorField}.
   */
  error(message: string, meta?: LogMeta): void;
  error(error: unknown, message: string, meta?: LogMeta): void;
  error(messageOrError: string | unknown, messageOrMeta?: string | LogMeta, meta?: LogMeta): void {
    if (typeof messageOrError === "string") {
      // The string overload's second parameter is the meta object; the union type of the
      // implementation signature cannot see which overload the caller took.
      this.#emit("error", messageOrError, messageOrMeta as LogMeta | undefined);
      return;
    }

    const message = typeof messageOrMeta === "string" ? messageOrMeta : "Error";
    this.#emit("error", message, meta, toErrorField(messageOrError));
  }
  /**
   * Emits a record at fatal level.
   *
   * Pass an error value as the first argument to attach a structured `error` field
   * assembled via {@link toErrorField}.
   */
  fatal(message: string, meta?: LogMeta): void;
  fatal(error: unknown, message: string, meta?: LogMeta): void;
  fatal(messageOrError: string | unknown, messageOrMeta?: string | LogMeta, meta?: LogMeta): void {
    if (typeof messageOrError === "string") {
      // Same overload-erasure narrowing as error() above.
      this.#emit("fatal", messageOrError, messageOrMeta as LogMeta | undefined);
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
      const start = this.emitTransportStartupStart(transport);
      await transport.onStart?.();
      this.emitTransportStartupReady(transport, start);
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

function getTransportName(transport: LoggerTransport): string {
  // Statics live on the constructor; the instance type cannot express "constructor of a
  // LoggerTransport subclass", so the read narrows through the base class type.
  return (transport.constructor as typeof LoggerTransport).transportName;
}
