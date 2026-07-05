/**
 * Node-rooted deliberately: frame width derives from process.stdout.columns, a node console
 * concern the portable root must not touch (the portable console suite covers everything else).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import type { LogError, LogLevel, LogRecord } from "../../../../../src/lib/logger/types.js";
import { CFWConsoleTransport } from "../../../../../src/lib/logger/transports/console.js";
import { Container } from "../../../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../../../src/lib/services/registration-map.js";

/** Captures every call routed to console.log/warn/error during the test. */
interface ConsoleCapture {
  log: string[];
  warn: string[];
  error: string[];
  restore(): void;
}

function makeContainer(
  host: Record<string, unknown> = { env: "development" },
  log: Record<string, unknown> = {},
): Container {
  return new Container(new FlareRegistrationMap(), new Map(), { host, log } as unknown as JsonObject);
}

/** ANSI escape stripper used by helper assertions. */
function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function captureConsole(): ConsoleCapture {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const cap: ConsoleCapture = {
    log: [],
    warn: [],
    error: [],
    restore(): void {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
  console.log = (msg?: unknown): void => {
    cap.log.push(String(msg));
  };
  console.warn = (msg?: unknown): void => {
    cap.warn.push(String(msg));
  };
  console.error = (msg?: unknown): void => {
    cap.error.push(String(msg));
  };
  return cap;
}

function makeRecord(partial: Partial<LogRecord> & { level: LogLevel; message: string; }): LogRecord {
  return {
    timestamp: partial.timestamp ?? 0,
    level: partial.level,
    message: partial.message,
    ...(partial.error !== undefined ? { error: partial.error } : {}),
  };
}

describe("error block frame width from terminal columns", () => {
  let capture: ConsoleCapture;

  beforeEach(() => {
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
  });

  // Save and restore process.stdout.columns around each case so we don't leak state.
  // The instance may or may not have its own `columns` property descriptor depending on
  // the environment (tty vs piped); capture it and restore exactly what was there.
  let columnsDescriptor: PropertyDescriptor | undefined;
  let columnsExisted = false;

  beforeEach(() => {
    columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    columnsExisted = columnsDescriptor !== undefined;
  });

  afterEach(() => {
    if (columnsExisted && columnsDescriptor) {
      Object.defineProperty(process.stdout, "columns", columnsDescriptor);
    } else {
      // No own property to begin with; remove anything we added.
      delete (process.stdout as { columns?: number; }).columns;
    }
  });

  function setColumns(value: number | undefined): void {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      enumerable: true,
      get: () => value,
    });
  }

  function buildBlock(): string {
    const t = new CFWConsoleTransport(makeContainer({ env: "development" }, { format: "pretty" }));
    t.onStart();
    const err: LogError = { name: "E", message: "x", stack: "E: x\n    at f (a.js:1:1)" };
    t.write(makeRecord({ level: "error", message: "m", error: err }));
    const block = capture.error.at(-1)!;
    return stripAnsi(block);
  }

  function bottomRuleLength(visible: string): number {
    // Bottom rule line is the last line, beginning with two spaces, then `└`, then a run of `─`.
    const bottom = visible.split("\n").pop()!;
    const match = bottom.match(/─+$/);
    return match ? match[0].length : 0;
  }

  it("when process.stdout.columns is undefined, frame width is 64", () => {
    setColumns(undefined);
    const visible = buildBlock();
    expect(bottomRuleLength(visible)).toBe(64);
  });

  it("when columns is 120, frame width is min(FRAME_WIDTH=96, 120 - 24) = 96", () => {
    setColumns(120);
    const visible = buildBlock();
    expect(bottomRuleLength(visible)).toBe(96);
  });

  it("when columns is 60, frame width is clamped to 40 (lower bound)", () => {
    setColumns(60);
    const visible = buildBlock();
    expect(bottomRuleLength(visible)).toBe(40);
  });

  it("when columns is 200, frame width is capped at FRAME_WIDTH (96)", () => {
    setColumns(200);
    const visible = buildBlock();
    expect(bottomRuleLength(visible)).toBe(96);
  });

  it("stack truncation respects the dynamic frameWidth, not the constant", () => {
    // columns=undefined -> frameWidth=64 -> max stack chars = max(16, 64 - 12) = 52
    setColumns(undefined);
    const longFrame = `at very-${"x".repeat(200)}`;
    const t = new CFWConsoleTransport(makeContainer({ env: "development" }, { format: "pretty" }));
    t.onStart();
    const err: LogError = { name: "E", message: "x", stack: `E: x\n    ${longFrame}` };
    t.write(makeRecord({ level: "error", message: "m", error: err }));
    const visible = stripAnsi(capture.error.at(-1)!);
    const truncated = visible.split("\n").find((l) => l.includes("very-"))!.trim();
    const frame = truncated.replace(/^.*?(at )/, "$1");
    expect(frame.endsWith("…")).toBe(true);
    expect(frame.length).toBeLessThanOrEqual(52);
  });
});
