/**
 * Unit tests for {@link ConsoleTransport} formatting and output routing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import type { LogContext, LogError, LogLevel, LogMeta, LogRecord } from "../../../../../src/lib/logger/types.js";
import { HOST_CONFIG, LOG_CONFIG } from "../../../../../src/lib/config/flare-config.js";
import { ConsoleTransport } from "../../../../../src/lib/logger/transports/console.js";
import { Container } from "../../../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../../../src/lib/services/registration-map.js";
import { captureConsole, type ConsoleCapture, stripAnsi } from "../../../../portable/helpers/console-capture.js";

/**
 * Builds a Container seeded with `host` and `log` config sections.
 * The transports call `this.config(HOST_CONFIG)` / `this.config(LOG_CONFIG)`
 * which in turn delegate to `container.resolveCfg`.
 */
function makeContainer(
  host: Record<string, unknown> = { env: "development" },
  log: Record<string, unknown> = {},
): Container {
  return new Container(new FlareRegistrationMap(), new Map(), { host, log } as unknown as JsonObject);
}

function makeRecord(partial: Partial<LogRecord> & { level: LogLevel; message: string; }): LogRecord {
  return {
    timestamp: partial.timestamp ?? 0,
    level: partial.level,
    message: partial.message,
    ...(partial.context !== undefined ? { context: partial.context } : {}),
    ...(partial.state !== undefined ? { state: partial.state } : {}),
    ...(partial.meta !== undefined ? { meta: partial.meta } : {}),
    ...(partial.error !== undefined ? { error: partial.error } : {}),
  };
}

describe("asynchronous console transport output", () => {
  let capture: ConsoleCapture;

  beforeEach(() => {
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
  });

  // Primary Behavior
  it('transportName static is "console"', () => {
    expect(ConsoleTransport.transportName).toBe("console");
  });

  it("static config declares [LOG_CONFIG, HOST_CONFIG]", () => {
    expect(ConsoleTransport.config).toEqual([LOG_CONFIG, HOST_CONFIG]);
  });

  it('onStart() selects json format when log.format is unset and host.env !== "development"', () => {
    const t = new ConsoleTransport(makeContainer({ env: "production" }, {}));
    t.onStart();
    t.write(makeRecord({ level: "info", message: "hi" }));
    // json branch produces a JSON.parse-able single line, pretty does not.
    expect(capture.log).toHaveLength(1);
    expect(() => JSON.parse(capture.log[0]!)).not.toThrow();
  });

  it('onStart() selects pretty format when log.format is unset and host.env === "development"', () => {
    const t = new ConsoleTransport(makeContainer({ env: "development" }, {}));
    t.onStart();
    t.write(makeRecord({ level: "info", message: "hi" }));
    expect(capture.log).toHaveLength(1);
    // pretty output contains ANSI escape sequences; json would not.
    expect(capture.log[0]).toContain("\x1b[");
    expect(() => JSON.parse(capture.log[0]!)).toThrow();
  });

  it('onStart() explicit log.format = "json" overrides host.env = "development"', () => {
    const t = new ConsoleTransport(makeContainer({ env: "development" }, { format: "json" }));
    t.onStart();
    t.write(makeRecord({ level: "info", message: "hi" }));
    expect(() => JSON.parse(capture.log[0]!)).not.toThrow();
  });

  it('onStart() explicit log.format = "pretty" overrides host.env = "production"', () => {
    const t = new ConsoleTransport(makeContainer({ env: "production" }, { format: "pretty" }));
    t.onStart();
    t.write(makeRecord({ level: "info", message: "hi" }));
    expect(capture.log[0]).toContain("\x1b[");
    expect(() => JSON.parse(capture.log[0]!)).toThrow();
  });

  describe("write(record) in json mode", () => {
    function jsonTransport(): ConsoleTransport {
      const t = new ConsoleTransport(makeContainer({ env: "production" }, { format: "json" }));
      t.onStart();
      return t;
    }

    it("emits to console.log for info", () => {
      jsonTransport().write(makeRecord({ level: "info", message: "m" }));
      expect(capture.log).toHaveLength(1);
      expect(capture.warn).toHaveLength(0);
      expect(capture.error).toHaveLength(0);
    });

    it("emits to console.warn for warn", () => {
      jsonTransport().write(makeRecord({ level: "warn", message: "m" }));
      expect(capture.warn).toHaveLength(1);
      expect(capture.log).toHaveLength(0);
      expect(capture.error).toHaveLength(0);
    });

    it("emits to console.error for error", () => {
      jsonTransport().write(makeRecord({ level: "error", message: "m" }));
      expect(capture.error).toHaveLength(1);
      expect(capture.log).toHaveLength(0);
      expect(capture.warn).toHaveLength(0);
    });

    it("emits to console.error for fatal", () => {
      jsonTransport().write(makeRecord({ level: "fatal", message: "m" }));
      expect(capture.error).toHaveLength(1);
      expect(capture.log).toHaveLength(0);
      expect(capture.warn).toHaveLength(0);
    });

    it("emits to console.log for trace and debug", () => {
      jsonTransport().write(makeRecord({ level: "trace", message: "m" }));
      jsonTransport().write(makeRecord({ level: "debug", message: "m" }));
      expect(capture.log).toHaveLength(2);
      expect(capture.warn).toHaveLength(0);
      expect(capture.error).toHaveLength(0);
    });

    it("produces a single-line JSON.parse-able payload with required fields", () => {
      jsonTransport().write(makeRecord({ timestamp: 123, level: "info", message: "hi" }));
      const line = capture.log[0]!;
      expect(line.includes("\n")).toBe(false);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed).toEqual({ timestamp: 123, level: "info", message: "hi" });
    });

    it("only includes optional fields when present and preserves field order timestamp,level,message,context,state,meta,error", () => {
      const ctx: LogContext = { source: "flare:http", requestId: "r-1", method: "GET", url: "/x" };
      const state = { tenant: "t1" };
      const meta = { extra: 1 };
      const err: LogError = { name: "E", message: "boom" };
      jsonTransport().write(makeRecord({
        timestamp: 1,
        level: "error",
        message: "m",
        context: ctx,
        state,
        meta,
        error: err,
      }));
      const line = capture.error[0]!;
      const parsed = JSON.parse(line) as LogRecord;
      expect(Object.keys(parsed)).toEqual(["timestamp", "level", "message", "context", "state", "meta", "error"]);
      expect(parsed.context).toEqual(ctx);
      expect(parsed.state).toEqual(state);
      expect(parsed.meta).toEqual(meta);
      expect(parsed.error).toEqual(err);
    });

    it("omits optional fields that are not present on the record", () => {
      jsonTransport().write(makeRecord({ timestamp: 5, level: "info", message: "m" }));
      const parsed = JSON.parse(capture.log[0]!) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("context");
      expect(parsed).not.toHaveProperty("state");
      expect(parsed).not.toHaveProperty("meta");
      expect(parsed).not.toHaveProperty("error");
    });
  });

  describe("write(record) in pretty mode (no error)", () => {
    function prettyTransport(): ConsoleTransport {
      const t = new ConsoleTransport(makeContainer({ env: "development" }, { format: "pretty" }));
      t.onStart();
      return t;
    }

    it("produces a single line `<time>  <badge>  <source>  <message>`", () => {
      prettyTransport().write(makeRecord({ timestamp: 0, level: "info", message: "hello" }));
      expect(capture.log).toHaveLength(1);
      const line = capture.log[0]!;
      // No newline (single-line, no error block, no meta).
      expect(line.includes("\n")).toBe(false);
      const visible = stripAnsi(line);
      // The default source ("app") and the message must appear.
      expect(visible).toContain("INFO");
      expect(visible).toContain("app");
      expect(visible).toContain("hello");
      // The double-space separator pattern between segments.
      expect(visible.split("  ").length).toBeGreaterThanOrEqual(4);
    });

    it("inline summary with context.method and context.url includes the colorized method and the url", () => {
      const ctx: LogContext = { source: "flare:http", requestId: "r1", method: "GET", url: "/users" };
      prettyTransport().write(makeRecord({ level: "info", message: "served", context: ctx }));
      const line = capture.log[0]!;
      // Yellow ANSI wraps the method.
      expect(line).toContain("\x1b[33mGET\x1b[0m");
      // url is plain text within the line.
      expect(line).toContain("/users");
    });

    it("inline summary with context.requestId appends `request_id=<id>` segment", () => {
      const ctx: LogContext = { source: "flare:http", requestId: "abc-123", method: "GET", url: "/" };
      prettyTransport().write(makeRecord({ level: "info", message: "ok", context: ctx }));
      const line = capture.log[0]!;
      expect(stripAnsi(line)).toContain("request_id=abc-123");
    });
  });

  describe("write(record) in pretty mode (with error)", () => {
    function prettyTransport(): ConsoleTransport {
      const t = new ConsoleTransport(makeContainer({ env: "development" }, { format: "pretty" }));
      t.onStart();
      return t;
    }

    it("emits a multi-line block with top rule, error name+message, context section, meta section, stack frames, bottom rule", () => {
      const ctx: LogContext = { source: "flare:http", requestId: "r1", method: "POST", url: "/x" };
      const err: LogError = {
        name: "MyError",
        message: "blew up",
        stack: "MyError: blew up\n    at functionA (file.js:1:1)\n    at functionB (file.js:2:2)",
      };
      prettyTransport().write(
        makeRecord({
          level: "error",
          message: "request failed",
          context: ctx,
          state: { tenant: "t1" },
          meta: { hint: "see logs" },
          error: err,
        }),
      );
      expect(capture.error).toHaveLength(1);
      const block = capture.error[0]!;
      const lines = block.split("\n");
      expect(lines.length).toBeGreaterThan(5);
      const visible = stripAnsi(block);
      // Top rule line contains the error title.
      expect(visible).toContain("MyError");
      // Message line.
      expect(visible).toContain("blew up");
      // Context section label.
      expect(visible).toContain("context");
      // State section label.
      expect(visible).toContain("state");
      // Stack frames included.
      expect(visible).toContain("at functionA");
      expect(visible).toContain("at functionB");
      // Bottom rule: a long run of horizontal bars.
      expect(visible).toMatch(/─{20,}/);
    });

    it('error.name defaults to "Error" when absent', () => {
      const err: LogError = { message: "msg-without-name" };
      prettyTransport().write(makeRecord({ level: "error", message: "x", error: err }));
      const visible = stripAnsi(capture.error[0]!);
      expect(visible).toMatch(/Error\s+─/);
    });

    it("omits the context section when only `source` is present (source is excluded)", () => {
      const ctx: LogContext = { source: "flare:host" };
      const err: LogError = { name: "E", message: "x" };
      prettyTransport().write(makeRecord({ level: "error", message: "m", context: ctx, error: err }));
      const visible = stripAnsi(capture.error[0]!);
      // No "context" label row.
      expect(visible).not.toMatch(/\bcontext\b/);
    });

    it("omits the state section when state is undefined", () => {
      const ctx: LogContext = { source: "flare:host" };
      const err: LogError = { name: "E", message: "x" };
      prettyTransport().write(makeRecord({ level: "error", message: "m", context: ctx, error: err }));
      const visible = stripAnsi(capture.error[0]!);
      expect(visible).not.toMatch(/\bstate\b/);
    });

    it("stack lines are limited to 8 entries", () => {
      const frames: string[] = ["MyError: msg"];
      for (let i = 0; i < 20; i++) frames.push(`    at frame${i} (file.js:${i}:1)`);
      const err: LogError = { name: "MyError", message: "msg", stack: frames.join("\n") };
      prettyTransport().write(makeRecord({ level: "error", message: "m", error: err }));
      const visible = stripAnsi(capture.error[0]!);
      const atLines = visible.split("\n").filter((l) => /\bat frame\d+/.test(l));
      expect(atLines).toHaveLength(8);
    });

    it("stack lines are truncated to FRAME_WIDTH - 12 characters with an ellipsis when over budget", () => {
      // FRAME_WIDTH = 96 → max stack chars = 96 - 12 = 84.
      const longFrame = `at very-${"x".repeat(200)}`;
      const err: LogError = { name: "E", message: "x", stack: `E: x\n    ${longFrame}` };
      prettyTransport().write(makeRecord({ level: "error", message: "m", error: err }));
      const visible = stripAnsi(capture.error[0]!);
      const truncated = visible.split("\n").find((l) => l.includes("very-"))!;
      const frame = truncated.trim().replace(/^.*?(at )/, "$1");
      // The truncated frame ends with the ellipsis character.
      expect(frame.endsWith("…")).toBe(true);
      // The trimmed frame is at most 84 characters (FRAME_WIDTH - 12).
      expect(frame.length).toBeLessThanOrEqual(84);
    });

    it("drops the first line (error header) and keeps lines that trim to `at ...`", () => {
      const stack = [
        "MyError: this is the header line and should NOT appear",
        "    at firstFrame (a.js:1:1)",
        "garbage line without at keyword",
        "    at secondFrame (b.js:2:2)",
      ].join("\n");
      const err: LogError = { name: "MyError", message: "msg", stack };
      prettyTransport().write(makeRecord({ level: "error", message: "m", error: err }));
      const visible = stripAnsi(capture.error[0]!);
      expect(visible).not.toContain("this is the header line");
      expect(visible).not.toContain("garbage line");
      expect(visible).toContain("at firstFrame");
      expect(visible).toContain("at secondFrame");
    });
  });

  // Edge Cases
  describe("level routing", () => {
    function prettyTransport(): ConsoleTransport {
      const t = new ConsoleTransport(makeContainer({ env: "development" }, { format: "pretty" }));
      t.onStart();
      return t;
    }

    it("routes warn to console.warn", () => {
      prettyTransport().write(makeRecord({ level: "warn", message: "x" }));
      expect(capture.warn).toHaveLength(1);
      expect(capture.log).toHaveLength(0);
      expect(capture.error).toHaveLength(0);
    });

    it("routes error and fatal to console.error", () => {
      prettyTransport().write(makeRecord({ level: "error", message: "x" }));
      prettyTransport().write(makeRecord({ level: "fatal", message: "x" }));
      expect(capture.error).toHaveLength(2);
    });

    it("routes everything else (trace, debug, info) to console.log", () => {
      prettyTransport().write(makeRecord({ level: "trace", message: "x" }));
      prettyTransport().write(makeRecord({ level: "debug", message: "x" }));
      prettyTransport().write(makeRecord({ level: "info", message: "x" }));
      expect(capture.log).toHaveLength(3);
    });
  });
});

/**
 * Targeted coverage of module-scope formatting helpers via the public surface.
 * Helpers are not exported, so each case is exercised through `write(record)`
 * on a transport configured for pretty/json mode as appropriate.
 */
describe("formatting helpers (exercised via ConsoleTransport)", () => {
  let capture: ConsoleCapture;

  beforeEach(() => {
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
  });

  function prettyTransport(): ConsoleTransport {
    const t = new ConsoleTransport(makeContainer({ env: "development" }, { format: "pretty" }));
    t.onStart();
    return t;
  }

  function jsonTransport(): ConsoleTransport {
    const t = new ConsoleTransport(makeContainer({ env: "production" }, { format: "json" }));
    t.onStart();
    return t;
  }

  // Primary Behavior
  describe("pretty log timestamps in local time with zero padding", () => {
    it("zero-pads h/m/s to 2 digits and ms to 3, using local time, wrapped in ANSI", () => {
      const d = new Date(2020, 0, 1, 3, 4, 5, 7); // local time 03:04:05.007
      prettyTransport().write(makeRecord({ timestamp: d.getTime(), level: "info", message: "m" }));
      const line = capture.log[0]!;
      // Dim ANSI prefix and reset suffix around the time chunk.
      expect(line).toContain("\x1b[2m03:04:05.007\x1b[0m");
    });
  });

  describe("log source label styling by prefix", () => {
    it("when source starts with `flare:`, returns dim-styled with the colon replaced by `·`", () => {
      const ctx: LogContext = { source: "flare:host" };
      prettyTransport().write(makeRecord({ level: "info", message: "m", context: ctx }));
      const line = capture.log[0]!;
      // Dim ANSI prefix wraps `flare·host`.
      expect(line).toContain("\x1b[2mflare·host\x1b[0m");
    });

    it("otherwise returns italic-styled", () => {
      // Use the default source ("app") which does NOT start with "flare:".
      prettyTransport().write(makeRecord({ level: "info", message: "m" }));
      const line = capture.log[0]!;
      // Italic ANSI wraps "app".
      expect(line).toContain("\x1b[3mapp\x1b[0m");
    });
  });

  describe("pretty section value formatting including timestamps", () => {
    it("formats a value as a stripped-ANSI timestamp when key ends in `_timestamp` and value is a number", () => {
      const ts = new Date(2020, 0, 1, 12, 30, 45, 123).getTime();
      // Use state so the key "lastTimestamp" → snake "last_timestamp" reaches a `_timestamp` suffix.
      const err: LogError = { name: "E", message: "x" };
      prettyTransport().write(
        makeRecord({
          level: "error",
          message: "m",
          state: { lastTimestamp: ts },
          error: err,
        }),
      );
      const visible = stripAnsi(capture.error[0]!);
      expect(visible).toContain("12:30:45.123");
      // The rendered timestamp must not contain ANSI (it was stripped).
      const lineWithTimestamp = capture.error[0]!.split("\n").find((l) => l.includes("12:30:45.123"))!;
      // The timestamp section of the line should not carry the dim wrapper around the value.
      // (The key column is dim, but the value column for a stripped timestamp must not contain the ANSI dim wrapper around the digits.)
      expect(lineWithTimestamp).not.toContain("\x1b[2m12:30:45.123\x1b[0m");
    });

    it("falls back to formatValue for non-matching keys (duration_ms is NOT a timestamp)", () => {
      const err: LogError = { name: "E", message: "x" };
      prettyTransport().write(
        makeRecord({
          level: "error",
          message: "m",
          state: { durationMs: 1234 },
          error: err,
        }),
      );
      const visible = stripAnsi(capture.error[0]!);
      const stateLine = visible.split("\n").find((line) => line.includes("duration_ms"))!;
      // The value should be the plain number, not a formatted time string.
      expect(stateLine).toContain("1234");
      expect(stateLine).not.toMatch(/\b\d{2}:\d{2}:\d{2}\.\d{3}\b/);
    });
  });

  describe("camelCase keys rendered as snake_case in pretty output", () => {
    it("converts camelCase keys to snake_case in error sections", () => {
      const err: LogError = { name: "E", message: "x" };
      prettyTransport().write(
        makeRecord({
          level: "error",
          message: "m",
          state: { durationMs: 1 },
          error: err,
        }),
      );
      const visible = stripAnsi(capture.error[0]!);
      expect(visible).toContain("duration_ms");
      expect(visible).not.toContain("durationMs");
    });
  });

  describe("section label colors in pretty error blocks", () => {
    it("colorizes `context` blue, `state` cyan, `meta` yellow", () => {
      const ctx: LogContext = {
        source: "flare:http",
        requestId: "r1",
        method: "GET",
        url: "/x",
      };
      const err: LogError = { name: "E", message: "x" };
      prettyTransport().write(
        makeRecord({
          level: "error",
          message: "m",
          context: ctx,
          state: { tenant: "t1" },
          meta: { hint: "h", flag: true },
          error: err,
        }),
      );
      const block = capture.error[0]!;
      // Blue around the trimmed "context" label.
      expect(block).toMatch(/\x1b\[34mcontext\s*\x1b\[0m/);
      // Cyan around the trimmed "state" label.
      expect(block).toMatch(/\x1b\[36mstate\s*\x1b\[0m/);
      // Meta block values use yellow for booleans (via formatInspectable).
      expect(block).toMatch(/\x1b\[33mtrue\x1b\[0m/);
    });
  });

  describe("context and state section entry filtering", () => {
    it("filters keys in `omit` (source is omitted from context)", () => {
      const ctx: LogContext = {
        source: "flare:http",
        requestId: "r1",
        method: "GET",
        url: "/x",
      };
      const err: LogError = { name: "E", message: "x" };
      prettyTransport().write(makeRecord({ level: "error", message: "m", context: ctx, error: err }));
      const visible = stripAnsi(capture.error[0]!);
      // The context section must render request_id, method, url, NOT `source`.
      expect(visible).toContain("request_id");
      expect(visible).toContain("method");
      expect(visible).toContain("url");
      // `source` key should not appear as a key column in the context section.
      // The substring "flare:http" is the value; we want to make sure no `source` key column exists.
      const contextLines = visible.split("\n").filter((l) => /\b(source|request_id|method|url)\b/.test(l));
      expect(contextLines.some((l) => /\bsource\s/.test(l))).toBe(false);
    });

    it("filters entries whose value is undefined", () => {
      const ctx: LogContext = {
        source: "flare:http",
        requestId: "r1",
        method: "GET",
        url: "/x",
        // An undefined entry on the meta-extended type.
        extra: undefined,
      } as unknown as LogContext;
      const err: LogError = { name: "E", message: "x" };
      prettyTransport().write(makeRecord({ level: "error", message: "m", context: ctx, error: err }));
      const visible = stripAnsi(capture.error[0]!);
      expect(visible).not.toContain("extra");
    });
  });

  describe("stack frame rendering when stack is absent", () => {
    it("when error has no stack, no `at ...` frames are rendered", () => {
      const err: LogError = { name: "E", message: "x" }; // no stack
      prettyTransport().write(makeRecord({ level: "error", message: "m", error: err }));
      const visible = stripAnsi(capture.error[0]!);
      expect(visible).not.toMatch(/\bat \w+/);
    });
  });

  describe("meta block primitive and object rendering", () => {
    it("renders primitives with their ANSI color wrappers (string red, number cyan, boolean yellow, null/undefined dim)", () => {
      const meta = {
        s: "hello",
        n: 7,
        b: true,
        nl: null,
      } as unknown as LogMeta;
      prettyTransport().write(makeRecord({ level: "info", message: "m", meta }));
      const out = capture.log[0]!;
      // string in red quotes
      expect(out).toContain(`\x1b[31m"hello"\x1b[0m`);
      // number in cyan
      expect(out).toContain(`\x1b[36m7\x1b[0m`);
      // boolean in yellow
      expect(out).toContain(`\x1b[33mtrue\x1b[0m`);
      // null in dim
      expect(out).toContain(`\x1b[2mnull\x1b[0m`);
    });

    it("renders an empty array as `[]` and empty object as `{}`", () => {
      const meta = { a: [], o: {} } as unknown as LogMeta;
      prettyTransport().write(makeRecord({ level: "info", message: "m", meta }));
      const visible = stripAnsi(capture.log[0]!);
      expect(visible).toContain("a: []");
      expect(visible).toContain("o: {}");
    });

    it("JSON-stringifies object keys that are not valid identifiers", () => {
      const meta = { "weird-key": 1, ok: 2 } as unknown as LogMeta;
      prettyTransport().write(makeRecord({ level: "info", message: "m", meta }));
      const visible = stripAnsi(capture.log[0]!);
      // The non-identifier key is JSON-stringified (double-quoted).
      expect(visible).toContain(`"weird-key": 1`);
      // The valid identifier is plain.
      expect(visible).toMatch(/\bok: 2\b/);
    });

    it("renders circular references as `[Circular]` instead of re-descending", () => {
      const o: Record<string, unknown> = {};
      o.self = o;
      prettyTransport().write(makeRecord({ level: "info", message: "m", meta: o as unknown as LogMeta }));
      const visible = stripAnsi(capture.log[0]!);
      expect(visible).toContain("[Circular]");
    });
  });

  describe("JSON record optional field inclusion order", () => {
    it("only includes optional fields that are present, in order: context, state, meta, error", () => {
      // Just state + error (omitting context and meta).
      const err: LogError = { name: "E", message: "boom" };
      jsonTransport().write(makeRecord({ level: "error", message: "m", state: { x: 1 }, error: err }));
      const line = capture.error[0]!;
      const optionalKeys = [...line.matchAll(/"(context|state|meta|error)":/g)].map((m) => m[1]);
      expect(optionalKeys).toEqual(["state", "error"]);
    });
  });
});
