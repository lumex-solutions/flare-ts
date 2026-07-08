/**
 * Unit tests for the bootstrap log buffer: buffering before logger startup, the fatal
 * fast path, and drain-through-transport behavior.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { _log } from "../../../../src/lib/logger/bootstrap.js";
import { Logger } from "../../../../src/lib/logger/logger.js";
import { makeContainer, RecordingTransport, resetBootstrapBuffer } from "../../../portable/helpers/logger-fixtures.js";

beforeEach(async () => {
  await resetBootstrapBuffer();
});

describe("bootstrap log buffer before logger startup", () => {
  // Primary Behavior
  it("buffers non-fatal levels and the buffer is drained by Logger.onStart()", async () => {
    _log("info", "x");
    _log("debug", "y", { z: 1 });

    const container = makeContainer({ level: "trace" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();

    const seen = transport.records.map((r) => ({ level: r.level, message: r.message, meta: r.meta }));
    expect(seen).toContainEqual({ level: "info", message: "x", meta: undefined });
    expect(seen).toContainEqual({ level: "debug", message: "y", meta: { z: 1 } });
  });

  // Edge Cases
  it("fatal level bypasses the buffer: writes directly to console.error with the [flare] FATAL: prefix", () => {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };

    try {
      _log("fatal", "ouch");
    } finally {
      console.error = original;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("[flare] FATAL: ouch\n");
  });

  it("fatal with meta appends JSON.stringify(meta) after the message", () => {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };

    try {
      _log("fatal", "ouch", { detail: 42 });
    } finally {
      console.error = original;
    }

    expect(calls[0]![0]).toBe(`[flare] FATAL: ouch ${JSON.stringify({ detail: 42 })}\n`);
  });

  it("fatal with no meta does NOT append a trailing space", () => {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };

    try {
      _log("fatal", "ouch");
    } finally {
      console.error = original;
    }

    expect(calls[0]![0]).toBe("[flare] FATAL: ouch\n");
    // Explicitly: no trailing space before the newline.
    expect(calls[0]![0]).not.toMatch(/ \n$/);
  });

  it("buffered records carry level, message, and meta (when provided), but no context", async () => {
    _log("info", "x", { a: 1 });

    const container = makeContainer({ level: "trace" });
    const transport = new RecordingTransport(container);
    const logger = new Logger([transport], container);

    await logger.onStart();

    const r = transport.records.find((r) => r.message === "x");
    expect(r).toBeDefined();
    expect(r!.level).toBe("info");
    expect(r!.meta).toEqual({ a: 1 });
    // No ALS access during _log, so context is never populated on the buffered record itself.
    // (Once the buffer is drained through #emit, context is only added if enableContext is true;
    // here it is the default `false`.)
    expect(r!.context).toBeUndefined();
  });
});
