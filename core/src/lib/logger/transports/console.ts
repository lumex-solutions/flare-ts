import type { LogContext, LogError, LogLevel, LogMeta, LogRecord } from "../types.js";
import { HOST_CONFIG, LOG_CONFIG } from "../../config/flare-config.js";
import { CFWLoggerTransport, LoggerTransport } from "../transport.js";

const A = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  white: "\x1b[97m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  bgMagenta: "\x1b[45m",
} as const;

interface LevelConfig {
  badge: string; // pre-built, zero per-call cost
}

const LEVELS: Record<LogLevel, LevelConfig> = {
  trace: { badge: "" },
  debug: { badge: "" },
  info: { badge: "" },
  warn: { badge: "" },
  error: { badge: "" },
  fatal: { badge: "" },
};

const LEVEL_STYLES: Record<LogLevel, [label: string, color: string]> = {
  trace: ["TRACE", A.gray],
  debug: ["DEBUG", A.gray],
  info: ["INFO ", A.cyan],
  warn: ["WARN ", A.yellow],
  error: ["ERROR", A.red],
  fatal: ["FATAL", A.bgMagenta],
};

for (const [level, cfg] of Object.entries(LEVELS) as [LogLevel, LevelConfig][]) {
  const [label, color] = LEVEL_STYLES[level];
  cfg.badge = `${color}${A.bold}${label}${A.reset}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${A.dim}${hh}:${mm}:${ss}.${ms}${A.reset}`;
}

const FRAMEWORK_SOURCE_RE = /^flare:/;

function formatSource(source: string): string {
  if (FRAMEWORK_SOURCE_RE.test(source)) {
    return `${A.dim}${source.replace(":", "·")}${A.reset}`;
  }
  return `${A.italic}${source}${A.reset}`;
}

const FRAME_WIDTH = 96;

/**
 * Console log transport that writes records as JSON in production or as a
 * colorized human-readable block in development.
 *
 * Format is chosen on startup from `log.format`, falling back to `host.env`.
 * Records at `warn` go to `console.warn`, `error` and `fatal` to `console.error`,
 * and everything else to `console.log`.
 */
export class ConsoleTransport extends LoggerTransport {
  static readonly transportName = "console";
  static readonly config = [LOG_CONFIG, HOST_CONFIG] as const;

  #format: "pretty" | "json" = "json";

  override onStart(): void {
    const hostCfg = this.config(HOST_CONFIG);
    const logCfg = this.config(LOG_CONFIG);
    this.#format = logCfg.format ?? (hostCfg.env === "development" ? "pretty" : "json");
  }

  write(record: LogRecord): void {
    const line = this.#format === "pretty" ? this.#pretty(record) : toJsonRecord(record);
    consoleWrite(record, line);
  }

  #pretty(record: LogRecord): string {
    const { level, message, context, state, meta, error } = record;
    const source = context?.source ?? "app";
    const time = formatTime(record.timestamp);
    const badge = LEVELS[level].badge;
    const src = formatSource(source);
    const inline = this.#inlineSummary(message, context);
    const line = `${time}  ${badge}  ${src}  ${inline}`;

    if (!error) {
      const metaBlock = meta ? formatObjectBlock(meta) : [];
      return metaBlock.length > 0 ? `${line}\n${metaBlock.join("\n")}` : line;
    }

    return `${line}\n${this.#errorBlock(error, context, state, meta)}`;
  }

  #inlineSummary(message: string, context: LogContext | undefined): string {
    const parts: string[] = [];

    if (context && "method" in context) {
      parts.push(`${A.yellow}${String(context.method)}${A.reset}`);
      parts.push(String(context.url));
    } else if (context && "connectionId" in context) {
      // A WebSocket connection context: the upgrade path, with no method (it is always the upgrade GET).
      parts.push(String(context.url));
    }

    parts.push(`${A.white}${message}${A.reset}`);

    if (context && "requestId" in context) {
      parts.push(`${A.dim}request_id=${String(context.requestId)}${A.reset}`);
    } else if (context && "connectionId" in context) {
      parts.push(`${A.dim}connection_id=${String(context.connectionId)}${A.reset}`);
    }

    return parts.join("  ");
  }

  #errorBlock(
    error: LogError,
    context: LogContext | undefined,
    state: LogMeta | undefined,
    meta: LogMeta | undefined,
  ): string {
    const title = error.name ?? "Error";
    const topRule = "─".repeat(Math.max(1, FRAME_WIDTH - visibleLength(title) - 8));
    const bottomRule = "─".repeat(FRAME_WIDTH);
    const border = (value: string) => `${A.red}${value}${A.reset}`;
    const lines: string[] = [
      "",
      `  ${border("┌─")} ${A.red}${title}${A.reset} ${A.red}${topRule}${A.reset}`,
      `  ${border("│")}  ${error.message}`,
      `  ${border("│")}`,
    ];

    const contextEntries = sectionEntries(context, new Set(["source"]));
    const stateEntries = sectionEntries(state);

    const sections = [
      formatErrorSection("context", contextEntries),
      formatErrorSection("state", stateEntries),
    ].filter((section) => section.length > 0);

    for (let i = 0; i < sections.length; i++) {
      lines.push(...sections[i]!);
      lines.push(`  ${border("│")}`);
    }

    const metaBlock = meta ? formatObjectBlock(meta, border) : [];
    if (metaBlock.length > 0) {
      lines.push(...metaBlock);
      lines.push(`  ${border("│")}`);
    }

    const stack = formatStack(error.stack);
    if (stack.length > 0) {
      lines.push(...stack);
    }

    lines.push(`  ${border("└")}${A.red}${bottomRule}${A.reset}`);
    return lines.join("\n");
  }
}

/**
 * Console log transport for Cloudflare Workers. Same formatting contract as
 * {@link ConsoleTransport}, but sizes the pretty-mode error frame to fit
 * inside wrangler dev's log prefix.
 */
export class CFWConsoleTransport extends CFWLoggerTransport {
  static readonly transportName = "console";
  static readonly config = [LOG_CONFIG, HOST_CONFIG] as const;

  #format: "pretty" | "json" = "json";

  override onStart(): void {
    const hostCfg = this.config(HOST_CONFIG);
    const logCfg = this.config(LOG_CONFIG);
    this.#format = logCfg.format ?? (hostCfg.env === "development" ? "pretty" : "json");
  }

  write(record: LogRecord): void {
    const line = this.#format === "pretty" ? this.#pretty(record) : toJsonRecord(record);
    consoleWrite(record, line);
  }

  #pretty(record: LogRecord): string {
    const { level, message, context, state, meta, error } = record;
    const source = context?.source ?? "app";
    const time = formatTime(record.timestamp);
    const badge = LEVELS[level].badge;
    const src = formatSource(source);
    const inline = this.#inlineSummary(message, context);
    const line = `${time}  ${badge}  ${src}  ${inline}`;

    if (!error) {
      const metaBlock = meta ? formatObjectBlock(meta) : [];
      return metaBlock.length > 0 ? `${line}\n${metaBlock.join("\n")}` : line;
    }

    return `${line}\n${this.#errorBlock(error, context, state, meta)}`;
  }

  #inlineSummary(message: string, context: LogContext | undefined): string {
    const parts: string[] = [];

    if (context && "method" in context) {
      parts.push(`${A.yellow}${String(context.method)}${A.reset}`);
      parts.push(String(context.url));
    } else if (context && "connectionId" in context) {
      // A WebSocket connection context: the upgrade path, with no method (it is always the upgrade GET).
      parts.push(String(context.url));
    }

    parts.push(`${A.white}${message}${A.reset}`);

    if (context && "requestId" in context) {
      parts.push(`${A.dim}request_id=${String(context.requestId)}${A.reset}`);
    } else if (context && "connectionId" in context) {
      parts.push(`${A.dim}connection_id=${String(context.connectionId)}${A.reset}`);
    }

    return parts.join("  ");
  }

  #errorBlock(
    error: LogError,
    context: LogContext | undefined,
    state: LogMeta | undefined,
    meta: LogMeta | undefined,
  ): string {
    const frameWidth = cfFrameWidth();
    const title = error.name ?? "Error";
    const topRule = "─".repeat(Math.max(1, frameWidth - visibleLength(title) - 8));
    const bottomRule = "─".repeat(frameWidth);
    const border = (value: string) => `${A.red}${value}${A.reset}`;
    const lines: string[] = [
      "",
      `  ${border("┌─")} ${A.red}${title}${A.reset} ${A.red}${topRule}${A.reset}`,
      `  ${border("│")}  ${error.message}`,
      `  ${border("│")}`,
    ];

    const contextEntries = sectionEntries(context, new Set(["source"]));
    const stateEntries = sectionEntries(state);

    const sections = [
      formatErrorSection("context", contextEntries),
      formatErrorSection("state", stateEntries),
    ].filter((section) => section.length > 0);

    for (let i = 0; i < sections.length; i++) {
      lines.push(...sections[i]!);
      lines.push(`  ${border("│")}`);
    }

    const metaBlock = meta ? formatObjectBlock(meta, border) : [];
    if (metaBlock.length > 0) {
      lines.push(...metaBlock);
      lines.push(`  ${border("│")}`);
    }

    const stack = formatStack(error.stack, frameWidth);
    if (stack.length > 0) {
      lines.push(...stack);
    }

    lines.push(`  ${border("└")}${A.red}${bottomRule}${A.reset}`);
    return lines.join("\n");
  }
}

function cfFrameWidth(): number {
  const columns = typeof process !== "undefined" ? process.stdout?.columns : undefined;
  if (typeof columns !== "number" || columns <= 0) {
    // Conservative fallback for wrangler dev terminals where width isn't exposed.
    return 64;
  }

  // Wrangler prepends its own log envelope, so reserve horizontal space to avoid
  // wrapping the top/bottom border lines in pretty error boxes.
  const WRANGLER_PREFIX_RESERVE = 24;
  return Math.max(40, Math.min(FRAME_WIDTH, columns - WRANGLER_PREFIX_RESERVE));
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  return JSON.stringify(v);
}

function formatPrettyKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function formatPrettyValue(key: string, value: unknown): string {
  if (typeof value === "number" && /(?:^|_)(?:timestamp|started_at|started|time)$/.test(formatPrettyKey(key))) {
    return stripAnsi(formatTime(value));
  }

  return formatValue(value);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function sectionEntries(
  fields: Record<string, unknown> | undefined,
  omit: Set<string> = new Set(),
): [string, unknown][] {
  if (!fields) return [];
  return Object.entries(fields)
    .filter(([key, value]) => !omit.has(key) && value !== undefined)
    .map(([key, value]) => [formatPrettyKey(key), value]);
}

function formatErrorSection(label: string, fields: [string, unknown][]): string[] {
  if (fields.length === 0) return [];

  const labelText = label.padEnd(7);
  const keyWidth = Math.max(...fields.map(([key]) => key.length));

  return fields.map(([key, value], idx) => {
    const group = idx === 0 ? colorSectionLabel(labelText, label) : " ".repeat(labelText.length);
    return `  ${A.red}│${A.reset}  ${group}  ${A.dim}${key.padEnd(keyWidth)}${A.reset}  ${
      formatPrettyValue(key, value)
    }`;
  });
}

function colorSectionLabel(label: string, raw: string): string {
  if (raw === "context") return `${A.blue}${label}${A.reset}`;
  if (raw === "state") return `${A.cyan}${label}${A.reset}`;
  if (raw === "meta") return `${A.yellow}${label}${A.reset}`;
  return label;
}

function formatStack(stack: string | undefined, frameWidth = FRAME_WIDTH): string[] {
  if (!stack) return [];

  // Keep stack rows inside the box to avoid wrapping that visually breaks borders.
  const maxStackChars = Math.max(16, frameWidth - 12);

  const lines = stack.split(/\r?\n/).slice(1);
  return lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, 8)
    .map((line) => {
      const clipped = line.length > maxStackChars ? `${line.slice(0, maxStackChars - 1)}…` : line;
      return `  ${A.red}│${A.reset}    ${A.dim}${clipped}${A.reset}`;
    });
}

function formatInspectable(value: unknown): string[] {
  return formatInspectableValue(value, 0, new WeakSet<object>());
}

function formatInspectableValue(value: unknown, depth: number, seen: WeakSet<object>): string[] {
  const pad = "  ".repeat(depth);
  const childPad = "  ".repeat(depth + 1);

  if (typeof value === "string") return [`${A.red}${JSON.stringify(value)}${A.reset}`];
  if (typeof value === "number") return [`${A.cyan}${String(value)}${A.reset}`];
  if (typeof value === "boolean") return [`${A.yellow}${String(value)}${A.reset}`];
  if (typeof value === "bigint") return [`${A.cyan}${String(value)}n${A.reset}`];
  if (typeof value === "symbol") return [`${A.magenta}${String(value)}${A.reset}`];
  if (typeof value === "function") return [`${A.magenta}[Function${value.name ? ` ${value.name}` : ""}]${A.reset}`];
  if (value === null) return [`${A.dim}null${A.reset}`];
  if (value === undefined) return [`${A.dim}undefined${A.reset}`];

  if (value instanceof Error) {
    return formatInspectableValue(
      {
        name: value.name,
        message: value.message,
        ...(value.stack ? { stack: value.stack } : {}),
      },
      depth,
      seen,
    );
  }

  if (typeof value !== "object") return [formatValue(value)];

  if (seen.has(value)) return [`${A.magenta}[Circular]${A.reset}`];
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return ["[]"];
    const lines = ["["];
    for (let i = 0; i < value.length; i++) {
      const child = formatInspectableValue(value[i], depth + 1, seen);
      lines.push(`${childPad}${child[0]}${i === value.length - 1 ? "" : ","}`);
      for (const line of child.slice(1)) lines.push(line);
    }
    lines.push(`${pad}]`);
    return lines;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return ["{}"];

  const lines = ["{"];
  for (let i = 0; i < entries.length; i++) {
    const [key, inner] = entries[i]!;
    const child = formatInspectableValue(inner, depth + 1, seen);
    const keyText = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
    lines.push(`${childPad}${A.green}${keyText}${A.reset}: ${child[0]}${i === entries.length - 1 ? "" : ","}`);
    for (const line of child.slice(1)) lines.push(line);
  }
  lines.push(`${pad}}`);
  return lines;
}

function formatObjectBlock(value: Record<string, unknown>, border?: (value: string) => string): string[] {
  const lines = formatInspectable(value);
  const prefix = border ? `  ${border("│")}  ` : "";
  return lines.map((line) => `${prefix}${line}`);
}

function toJsonRecord(record: LogRecord): string {
  const { timestamp, level, message, context, state, meta, error } = record;
  return JSON.stringify({
    timestamp,
    level,
    message,
    ...(context ? { context } : {}),
    ...(state ? { state } : {}),
    ...(meta ? { meta } : {}),
    ...(error ? { error } : {}),
  });
}

function consoleWrite(record: LogRecord, line: string): void {
  if (record.level === "error" || record.level === "fatal") {
    console.error(line);
  } else if (record.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
