/**
 * Console record formatting shared by the console transports: ANSI styling, the pretty
 * badge/time/source pieces, error-frame sections, JSON emission, and the console sink.
 */
import type { LogError } from "../fields.js";
import type { LogContext, LogLevel, LogMeta, LogRecord } from "../types.js";

// ANSI style codes used by the pretty format.
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

type LevelConfig = {
  badge: string; // pre-built, zero per-call cost
};

// Per-level pretty badges, pre-built at module load.
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

// Object.entries erases the key type to string; LEVELS is keyed by LogLevel by
// construction, which the loop needs back to index LEVEL_STYLES.
for (const [level, cfg] of Object.entries(LEVELS) as [LogLevel, LevelConfig][]) {
  const [label, color] = LEVEL_STYLES[level];
  cfg.badge = `${color}${A.bold}${label}${A.reset}`;
}

/**
 * Width of the pretty error frame on standard terminals; runtime-specific width
 * policies (the frameWidth seam) cap against it.
 *
 * @internal
 */
export const FRAME_WIDTH = 96;

/**
 * Resolves the console output format the way both console transports document it:
 * explicit `log.format` wins, otherwise pretty in development and JSON elsewhere.
 *
 * @internal
 */
export function resolveConsoleFormat(env: string, format: "pretty" | "json" | undefined): "pretty" | "json" {
  return format ?? (env === "development" ? "pretty" : "json");
}

// Formats a timestamp as dimmed HH:MM:SS.mmm.
function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${A.dim}${hh}:${mm}:${ss}.${ms}${A.reset}`;
}

const FRAMEWORK_SOURCE_RE = /^flare:/;

/** Serializes a record as one JSON line. @internal */
export function toJsonRecord(record: LogRecord): string {
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

/** Routes a formatted line to console.log/warn/error by record level. @internal */
export function consoleWrite(record: LogRecord, line: string): void {
  if (record.level === "error" || record.level === "fatal") {
    console.error(line);
  } else if (record.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Renders a record in pretty mode: the badge/time/source/summary line, the meta block,
 * and (when an error is attached) the framed error block.
 *
 * `getFrameWidth` is the ONE seam the console transports diverge on: the Node transport
 * uses the fixed terminal width, the Cloudflare transport sizes to wrangler dev's
 * prefix. It is invoked only on the error path, preserving each caller's laziness.
 *
 * @internal
 */
export function renderPretty(record: LogRecord, getFrameWidth: () => number = nodeFrameWidth): string {
  const { level, message, context, state, meta, error } = record;
  const source = context?.source ?? "app";
  const time = formatTime(record.timestamp);
  const badge = LEVELS[level].badge;
  const src = formatSource(source);
  const inline = inlineSummary(message, context);
  const line = `${time}  ${badge}  ${src}  ${inline}`;

  if (!error) {
    const metaBlock = meta ? formatObjectBlock(meta) : [];
    return metaBlock.length > 0 ? `${line}\n${metaBlock.join("\n")}` : line;
  }

  return `${line}\n${errorBlock(error, context, state, meta, getFrameWidth())}`;
}

// Formats a record source: framework sources dimmed with a middle dot, app sources italic.
function formatSource(source: string): string {
  if (FRAMEWORK_SOURCE_RE.test(source)) {
    return `${A.dim}${source.replace(":", "·")}${A.reset}`;
  }
  return `${A.italic}${source}${A.reset}`;
}

// Removes ANSI escape sequences.
function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

// Length of a string with ANSI escapes removed.
function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

// Filters and snake_cases a context/state object into section entries.
function sectionEntries(
  fields: Record<string, unknown> | undefined,
  omit: Set<string> = new Set(),
): [string, unknown][] {
  if (!fields) return [];
  return Object.entries(fields)
    .filter(([key, value]) => !omit.has(key) && value !== undefined)
    .map(([key, value]) => [formatPrettyKey(key), value]);
}

// Renders one labeled section of the pretty error frame.
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

// Renders the clipped stack rows of the pretty error frame.
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

// Renders a meta object as an indented inspectable block, optionally framed.
function formatObjectBlock(value: Record<string, unknown>, border?: (value: string) => string): string[] {
  const lines = formatInspectable(value);
  const prefix = border ? `  ${border("│")}  ` : "";
  return lines.map((line) => `${prefix}${line}`);
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

// A numeric value whose snake_cased key looks like a timestamp is rendered as a time
// string instead of an epoch number; everything else falls through to formatValue.
function formatPrettyValue(key: string, value: unknown): string {
  if (typeof value === "number" && /(?:^|_)(?:timestamp|started_at|started|time)$/.test(formatPrettyKey(key))) {
    return stripAnsi(formatTime(value));
  }

  return formatValue(value);
}

function colorSectionLabel(label: string, raw: string): string {
  if (raw === "context") return `${A.blue}${label}${A.reset}`;
  if (raw === "state") return `${A.cyan}${label}${A.reset}`;
  if (raw === "meta") return `${A.yellow}${label}${A.reset}`;
  return label;
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

// The Node transports' fixed frame width, as the default seam value.
function nodeFrameWidth(): number {
  return FRAME_WIDTH;
}

function inlineSummary(message: string, context: LogContext | undefined): string {
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

function errorBlock(
  error: LogError,
  context: LogContext | undefined,
  state: LogMeta | undefined,
  meta: LogMeta | undefined,
  frameWidth: number,
): string {
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
