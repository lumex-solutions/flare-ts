/**
 * Pins ConsoleTransport rendering: JSON vs pretty by env/format override,
 * console.log/warn/error routing by level, and pretty error-block structure.
 * Driven through the in-process `app.test()` harness with captured console
 * output so rendered strings are inspectable without binding a real port.
 * Ensure the host enters test mode before any FlareHost is constructed.
 */
process.env.FLARE_MODE = "test";

import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { LogContext } from "../../../../../src/lib/logger/types.js";
import { FlareHost } from "../../../../../src/index.js";
import { runWithLogStore } from "../../../../../src/index.js";
import { nodeAdapter } from "../../../../node/helpers/node-adapter.js";
import { captureConsole, type ConsoleCapture, stripAnsi } from "../../../../portable/helpers/console-capture.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

// Console capture: each describe captures console.log/warn/error so we can
// assert on the ConsoleTransport's rendered output without it actually
// reaching the test runner's terminal.

function newTestHost(adapter: ReturnType<typeof nodeAdapter>) {
  const host = new FlareHost(adapter);
  registerMinimalPingRoute(host);
  return host;
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

// Adapter helpers: inject a synthetic flare.json while preserving the real
// runtime adapter's default ConsoleTransport (or CfConsoleTransport) so this
// suite exercises the actual transport that ships with each adapter.
function makeNodeAdapter(config: JsonObject) {
  return nodeAdapter(config, { FLARE_MODE: "test" });
}

// Primary Behavior

describe("Primary Behavior", () => {
  let cap: ConsoleCapture;

  afterEach(() => {
    cap?.restore();
  });

  it('booting a Node host in env="production" emits records on stdout/stderr as single-line JSON', async () => {
    const host = newTestHost(makeNodeAdapter({
      host: { env: "production" },
      log: { level: "info" },
    }));
    const app = await host.build().test();
    try {
      cap = captureConsole();
      host.logger.info("prod-info");
      host.logger.error("prod-err");

      // Single-line JSON, no ANSI, parseable.
      const infoLine = cap.log.find((l) => l.includes("prod-info"))!;
      const errLine = cap.error.find((l) => l.includes("prod-err"))!;
      expect(infoLine).toBeDefined();
      expect(errLine).toBeDefined();
      expect(infoLine.includes("\n")).toBe(false);
      expect(errLine.includes("\n")).toBe(false);
      expect(infoLine).not.toContain("\x1b[");
      expect(errLine).not.toContain("\x1b[");
      expect(() => JSON.parse(infoLine) as unknown).not.toThrow();
      expect(() => JSON.parse(errLine) as unknown).not.toThrow();
    } finally {
      await app.stop();
    }
  });

  it('booting a Node host in env="development" emits records on stdout/stderr as colorized pretty blocks', async () => {
    const host = newTestHost(makeNodeAdapter({
      host: { env: "development" },
      log: { level: "info" },
    }));
    const app = await host.build().test();
    try {
      cap = captureConsole();
      host.logger.info("dev-info");
      host.logger.error("dev-err");

      const infoLine = cap.log.find((l) => l.includes("dev-info"))!;
      const errLine = cap.error.find((l) => l.includes("dev-err"))!;
      expect(infoLine).toBeDefined();
      expect(errLine).toBeDefined();
      // Pretty mode includes ANSI escape sequences.
      expect(infoLine).toContain("\x1b[");
      expect(errLine).toContain("\x1b[");
      // And is NOT JSON-parseable.
      expect(() => JSON.parse(infoLine) as unknown).toThrow();
    } finally {
      await app.stop();
    }
  });

  it('explicit log.format="json" overrides env="development"; log.format="pretty" overrides env="production"', async () => {
    // env=development + format=json yields JSON output for an info record.
    const host1 = newTestHost(makeNodeAdapter({
      host: { env: "development" },
      log: { level: "info", format: "json" },
    }));
    const app1 = await host1.build().test();
    try {
      cap = captureConsole();
      host1.logger.info("override-json");
      const line = cap.log.find((l) => l.includes("override-json"))!;
      expect(line).toBeDefined();
      expect(line).not.toContain("\x1b[");
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    } finally {
      cap.restore();
      await app1.stop();
    }

    // env=production + format=pretty yields ANSI pretty output for an info record.
    const host2 = newTestHost(makeNodeAdapter({
      host: { env: "production" },
      log: { level: "info", format: "pretty" },
    }));
    const app2 = await host2.build().test();
    try {
      cap = captureConsole();
      host2.logger.info("override-pretty");
      const line = cap.log.find((l) => l.includes("override-pretty"))!;
      expect(line).toBeDefined();
      expect(line).toContain("\x1b[");
      expect(() => JSON.parse(line) as unknown).toThrow();
    } finally {
      await app2.stop();
    }
  });

  it("an info record goes to console.log; warn to console.warn; error and fatal to console.error", async () => {
    const host = newTestHost(makeNodeAdapter({
      host: { env: "production" },
      log: { level: "trace" },
    }));
    const app = await host.build().test();
    try {
      cap = captureConsole();
      host.logger.info("route-info");
      host.logger.warn("route-warn");
      host.logger.error("route-error");
      host.logger.fatal("route-fatal");

      expect(cap.log.find((l) => l.includes("route-info"))).toBeDefined();
      expect(cap.log.find((l) => l.includes("route-warn"))).toBeUndefined();
      expect(cap.log.find((l) => l.includes("route-error"))).toBeUndefined();
      expect(cap.log.find((l) => l.includes("route-fatal"))).toBeUndefined();

      expect(cap.warn.find((l) => l.includes("route-warn"))).toBeDefined();
      expect(cap.warn.find((l) => l.includes("route-info"))).toBeUndefined();

      expect(cap.error.find((l) => l.includes("route-error"))).toBeDefined();
      expect(cap.error.find((l) => l.includes("route-fatal"))).toBeDefined();
      expect(cap.error.find((l) => l.includes("route-info"))).toBeUndefined();
      expect(cap.error.find((l) => l.includes("route-warn"))).toBeUndefined();
    } finally {
      await app.stop();
    }
  });
});

// Edge Cases

describe("Edge Cases", () => {
  let cap: ConsoleCapture;

  afterEach(() => {
    cap?.restore();
  });

  it("pretty mode, no error: produces exactly one line `<time> <BADGE> <source> <message>` (plus optional meta block underneath)", async () => {
    const host = newTestHost(makeNodeAdapter({
      host: { env: "development" },
      log: { level: "info" },
    }));
    const app = await host.build().test();
    try {
      cap = captureConsole();
      // 1) info with no meta produces exactly one line (no newline).
      host.logger.info("plain-line");
      const plain = cap.log.find((l) => l.includes("plain-line"))!;
      expect(plain).toBeDefined();
      expect(plain.includes("\n")).toBe(false);
      const visible = stripAnsi(plain);
      // The visible content has the badge label, default source "app", and message.
      expect(visible).toContain("INFO");
      expect(visible).toContain("app");
      expect(visible).toContain("plain-line");

      // 2) info with meta: first line is the inline summary, followed by a
      // meta block underneath (more than one line, joined by "\n").
      host.logger.info("with-meta", { hint: "look here" });
      const withMetaBlock = cap.log.find((l) => l.includes("with-meta"))!;
      expect(withMetaBlock).toBeDefined();
      const metaLines = withMetaBlock.split("\n");
      expect(metaLines.length).toBeGreaterThan(1);
      // The header line carries the message and is itself a single visible line.
      expect(stripAnsi(metaLines[0]!)).toContain("with-meta");
      // The meta block contains the key/value rendered by formatInspectable.
      const metaVisible = stripAnsi(metaLines.slice(1).join("\n"));
      expect(metaVisible).toContain("hint");
      expect(metaVisible).toContain("look here");
    } finally {
      await app.stop();
    }
  });

  it("pretty mode, error with stack: multi-line block with top rule, error name+message, context section (when present), state section (when present), meta block (when present), up to 8 stack frames, bottom rule", async () => {
    const host = newTestHost(makeNodeAdapter({
      host: { env: "development" },
      log: { level: "info", enableContext: true },
    }));
    const app = await host.build().test();
    try {
      cap = captureConsole();
      // Build a real Error with a long synthetic stack so the renderer must
      // cap at 8 frames.
      const err = new Error("inner-boom");
      err.name = "MyErr";
      const frames: string[] = ["MyErr: inner-boom"];
      for (let i = 0; i < 12; i++) frames.push(`    at frame${i} (file.js:${i + 1}:1)`);
      err.stack = frames.join("\n");

      // Inject a request-scope context and state via loggerALS so the renderer
      // fills the context and state sections.
      const ctx: LogContext = {
        source: "flare:http",
        requestId: "rid-1",
        method: "POST",
        url: "/items",
      };
      runWithLogStore({ context: ctx, state: { tenantId: "t-7" } }, () => {
        host.logger.error(err, "wrap-msg", { hint: "see-docs" });
      });

      const block = cap.error.find((l) => l.includes("wrap-msg"))!;
      expect(block).toBeDefined();
      const lines = block.split("\n");
      expect(lines.length).toBeGreaterThan(8);
      const visible = stripAnsi(block);

      // Top rule with the error name.
      expect(visible).toMatch(/┌─\s+MyErr/);
      // Error message row.
      expect(visible).toMatch(/│\s+inner-boom/);
      // Context section label (rendered because context carries request/method/url).
      expect(visible).toContain("context");
      // State section label.
      expect(visible).toContain("state");
      // Meta block contains the key.
      expect(visible).toContain("hint");
      expect(visible).toContain("see-docs");
      // Stack frames present and capped at 8.
      const atLines = visible.split("\n").filter((l) => /\bat frame\d+/.test(l));
      expect(atLines).toHaveLength(8);
      // Bottom rule.
      expect(visible).toMatch(/└─+/);
    } finally {
      await app.stop();
    }
  });

  it("pretty mode, error without stack: stack section is omitted entirely", async () => {
    const host = newTestHost(makeNodeAdapter({
      host: { env: "development" },
      log: { level: "info" },
    }));
    const app = await host.build().test();
    try {
      cap = captureConsole();
      // An Error without a stack property: overwrite the inherited `stack`
      // with undefined so toErrorField does NOT attach a stack to record.error.
      const err = new Error("no-stack-msg");
      err.name = "NoStackErr";
      Object.defineProperty(err, "stack", { value: undefined });

      host.logger.error(err, "no-stack-wrap");

      const block = cap.error.find((l) => l.includes("no-stack-wrap"))!;
      expect(block).toBeDefined();
      const visible = stripAnsi(block);

      // Title row and message row are present.
      expect(visible).toMatch(/┌─\s+NoStackErr/);
      expect(visible).toMatch(/│\s+no-stack-msg/);
      // No stack frames whatsoever.
      expect(visible).not.toMatch(/\bat\s/);
    } finally {
      await app.stop();
    }
  });

  it("JSON mode: emits a single line with JSON.parse-able content and field order timestamp, level, message, [context], [state], [meta], [error]", async () => {
    const host = newTestHost(makeNodeAdapter({
      host: { env: "production" },
      log: { level: "info", enableContext: true },
    }));
    const app = await host.build().test();
    try {
      cap = captureConsole();
      const ctx: LogContext = {
        source: "flare:http",
        requestId: "rid-j-1",
        method: "GET",
        url: "/u",
      };
      runWithLogStore({ context: ctx, state: { tenant: "t1" } }, () => {
        host.logger.error(new Error("jboom"), "jmsg", { extra: 9 });
      });

      const line = cap.error.find((l) => l.includes("jmsg"))!;
      expect(line).toBeDefined();
      expect(line.includes("\n")).toBe(false);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed["level"]).toBe("error");
      expect(parsed["message"]).toBe("jmsg");
      expect(parsed["context"]).toEqual(ctx);
      expect(parsed["state"]).toEqual({ tenant: "t1" });
      expect(parsed["meta"]).toEqual({ extra: 9 });
      expect(Object.keys(parsed)).toEqual(["timestamp", "level", "message", "context", "state", "meta", "error"]);
    } finally {
      await app.stop();
    }
  });

  it("HTTP context inline summary: a record with context.method and context.url shows them in the inline summary; context.requestId appears as request_id=... at the end of the summary", async () => {
    const host = newTestHost(makeNodeAdapter({
      host: { env: "development" },
      log: { level: "info", enableContext: true },
    }));
    const app = await host.build().test();
    try {
      cap = captureConsole();
      const ctx: LogContext = {
        source: "flare:http",
        requestId: "rid-abc",
        method: "POST",
        url: "/items",
      };
      runWithLogStore({ context: ctx }, () => {
        host.logger.info("inline-msg");
      });

      const line = cap.log.find((l) => l.includes("inline-msg"))!;
      expect(line).toBeDefined();
      const visible = stripAnsi(line);
      // Method, URL, and request_id segment all present.
      expect(visible).toContain("POST");
      expect(visible).toContain("/items");
      expect(visible).toContain("request_id=rid-abc");
      // The request_id segment is the last visible segment of the inline
      // summary. Strip ANSI and split on the "  " separator the transport uses.
      const segments = visible.split("  ").filter((s) => s.length > 0);
      expect(segments[segments.length - 1]).toBe("request_id=rid-abc");
    } finally {
      await app.stop();
    }
  });
});

// Failure Modes

describe("Failure Modes", () => {
  let cap: ConsoleCapture;

  afterEach(() => {
    cap?.restore();
  });

  it("a record with a circular object in meta does not throw; formatInspectableValue substitutes [Circular] for repeated references", async () => {
    const host = newTestHost(makeNodeAdapter({
      host: { env: "development" },
      log: { level: "info" },
    }));
    const app = await host.build().test();
    try {
      cap = captureConsole();
      // Build a meta object that contains a back-reference to itself.
      // LogMeta is typed as Record<string, JsonValue>, which excludes
      // self-referencing values; cast through `unknown` to reach the runtime
      // path the spec describes (formatInspectableValue handles `seen` cycles).
      const meta: Record<string, unknown> = { tag: "loop" };
      meta["self"] = meta;

      // Must not throw, and the rendered block must contain the [Circular]
      // sentinel exactly as produced by formatInspectableValue.
      expect(() => {
        host.logger.info("circular-meta", meta as unknown as Record<string, never>);
      }).not.toThrow();

      const line = cap.log.find((l) => l.includes("circular-meta"))!;
      expect(line).toBeDefined();
      const visible = stripAnsi(line);
      expect(visible).toContain("[Circular]");
      // The non-cyclic key is still printed.
      expect(visible).toContain("tag");
      expect(visible).toContain("loop");
    } finally {
      await app.stop();
    }
  });

  it("an error block whose error name contains ANSI escapes still produces a top rule of the intended visible width (via visibleLength)", async () => {
    const host = newTestHost(makeNodeAdapter({
      host: { env: "development" },
      log: { level: "info" },
    }));
    const app = await host.build().test();
    try {
      cap = captureConsole();
      // Inject ANSI escapes inside the error name. visibleLength must strip
      // those before computing the top-rule width; if it did not, the dashes
      // would be ~9 short (the bold-red escape is 9 visible-zero chars).
      const ansiName = "\x1b[31m\x1b[1mAnsiErr\x1b[0m";
      const err = new Error("ansi-name-msg");
      err.name = ansiName;

      host.logger.error(err, "ansi-name-wrap");

      const block = cap.error.find((l) => l.includes("ansi-name-wrap"))!;
      expect(block).toBeDefined();
      const lines = block.split("\n");
      // Locate the top-rule line ("┌─ ...") and the bottom-rule line ("└...").
      const topRuleLine = lines.find((l) => l.includes("┌─"))!;
      const bottomRuleLine = lines.find((l) => l.includes("└"))!;
      expect(topRuleLine).toBeDefined();
      expect(bottomRuleLine).toBeDefined();

      // FRAME_WIDTH = 96 for the Node ConsoleTransport.
      // Top rule visible content: "  ┌─ <title> <dashes...>" where
      //   dashes count = max(1, FRAME_WIDTH - visibleLength(title) - 8)
      //   and the visible title length is `len("AnsiErr") === 7`.
      // dashes = 96 - 7 - 8 = 81.
      // The whole visible line is "  ┌─ AnsiErr " + 81 dashes = 2 + 2 + 1 + 7 + 1 + 81 = 94.
      // Bottom rule visible content: "  └" + 96 dashes = 2 + 1 + 96 = 99.
      expect(visibleLength(topRuleLine)).toBe(94);
      expect(visibleLength(bottomRuleLine)).toBe(99);
      // And the visible portion of the title row contains the un-escaped name.
      expect(stripAnsi(topRuleLine)).toContain("AnsiErr");
    } finally {
      await app.stop();
    }
  });

  it("an extremely long stack frame is truncated with `…` rather than wrapping past the frame width", async () => {
    const host = newTestHost(makeNodeAdapter({
      host: { env: "development" },
      log: { level: "info" },
    }));
    const app = await host.build().test();
    try {
      cap = captureConsole();
      // FRAME_WIDTH = 96, so max stack chars = 96 - 12 = 84.
      const longFrame = `at very-${"x".repeat(300)}`;
      const err = new Error("long-frame-msg");
      err.name = "E";
      err.stack = `E: long-frame-msg\n    ${longFrame}`;

      host.logger.error(err, "long-frame-wrap");

      const block = cap.error.find((l) => l.includes("long-frame-wrap"))!;
      expect(block).toBeDefined();
      const visible = stripAnsi(block);
      const truncated = visible.split("\n").find((l) => l.includes("very-"))!;
      expect(truncated).toBeDefined();
      const frame = truncated.trim().replace(/^.*?(at )/, "$1");
      // The truncated frame ends with the ellipsis character.
      expect(frame.endsWith("…")).toBe(true);
      // The trimmed frame (without surrounding indent/border) is at most
      // FRAME_WIDTH - 12 = 84 characters.
      expect(frame.length).toBeLessThanOrEqual(84);
    } finally {
      await app.stop();
    }
  });
});

// Cross-Feature Interactions

describe("Cross-Feature Interactions", () => {
  let cap: ConsoleCapture;

  afterEach(() => {
    cap?.restore();
  });

  it('a record carrying context.source="flare:http" and error causes the error block\'s context section to display the HTTP context fields (with logger/request-context)', async () => {
    const host = newTestHost(makeNodeAdapter({
      host: { env: "development" },
      log: { level: "info", enableContext: true },
    }));
    const app = await host.build().test();
    try {
      cap = captureConsole();
      const ctx: LogContext = {
        source: "flare:http",
        requestId: "rid-cross",
        method: "PUT",
        url: "/things/42",
      };
      runWithLogStore({ context: ctx }, () => {
        host.logger.error(new Error("ctx-err"), "ctx-wrap");
      });

      const block = cap.error.find((l) => l.includes("ctx-wrap"))!;
      expect(block).toBeDefined();
      const visible = stripAnsi(block);
      // Context section label rendered.
      expect(visible).toContain("context");
      // HTTP context field keys are pretty-printed (camelCase to snake_case):
      //   requestId becomes request_id, method stays method, url stays url.
      // The `source` field is intentionally excluded from the section body.
      expect(visible).toContain("request_id");
      expect(visible).toContain("rid-cross");
      expect(visible).toContain("method");
      expect(visible).toContain("PUT");
      expect(visible).toContain("url");
      expect(visible).toContain("/things/42");
      // Confirm `source` is not rendered as a context row inside the block.
      // (It still appears in the inline summary as "flare·http", but the
      // context-section rows include the field key adjacent to its value.
      // Scan for the literal pretty-key row "  source  " which would only
      // appear if source had been included.)
      expect(visible).not.toMatch(/\bsource\s+flare:http/);
    } finally {
      await app.stop();
    }
  });

  it("a record built via error(err, msg) and reaching the pretty error block displays err.name and err.message in the title and message rows (with logger/error-records)", async () => {
    const host = newTestHost(makeNodeAdapter({
      host: { env: "development" },
      log: { level: "info" },
    }));
    const app = await host.build().test();
    try {
      cap = captureConsole();
      // Use a concrete subclass so err.name is meaningful and distinct from
      // the wrapping log message.
      const err = new TypeError("type-err-msg");
      host.logger.error(err, "type-err-wrap");

      const block = cap.error.find((l) => l.includes("type-err-wrap"))!;
      expect(block).toBeDefined();
      const lines = block.split("\n");

      // Title row: "  ┌─ <err.name> <dashes>"; visible portion starts with
      // ┌─ and contains the error name "TypeError".
      const titleRow = lines.find((l) => l.includes("┌─"))!;
      expect(titleRow).toBeDefined();
      expect(stripAnsi(titleRow)).toContain("TypeError");

      // Message row: the first "│  " row carries err.message verbatim.
      const messageRow = lines.find((l) => /│\s+type-err-msg/.test(stripAnsi(l)))!;
      expect(messageRow).toBeDefined();
      expect(stripAnsi(messageRow)).toContain("type-err-msg");

      // And the log-call's wrapping message survives in the inline summary
      // line above the framed block.
      const headerLine = lines[0]!;
      expect(stripAnsi(headerLine)).toContain("type-err-wrap");
    } finally {
      await app.stop();
    }
  });
});
