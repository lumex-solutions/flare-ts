// Ensure the host enters test mode before any FlareHost is constructed.
process.env.FLARE_MODE = "test";

import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { FlareHost } from "../../../src/index.js";
import { toErrorField } from "../../../src/lib/logger/logger.js";
import { LoggerTransport } from "../../../src/lib/logger/transport.js";
import { ConsoleTransport } from "../../../src/lib/logger/transports/console.js";
import { loggerALS, type LogContext, type LogRecord } from "../../../src/lib/logger/types.js";
import { registerMinimalPingRoute } from "../../helpers/host-fixtures.js";
import { nodeAdapter } from "../../helpers/node-adapter.js";

// Recording transport — captures every record so error-field shape can be
// asserted exactly as it lands on a transport.

class RecordingTransport extends LoggerTransport {
  static override readonly transportName = "rec";
  static override deps: never[] = [];
  static readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    RecordingTransport.records.push(record);
  }
}

function resetRecords(): void {
  RecordingTransport.records.length = 0;
}

// Strip ANSI escapes so pretty-mode renderings can be matched against the
// visible content the spec describes (title with error name, first row with
// error message).
function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

// Adapter helper: inject test config and drop the default ConsoleTransport so
// the recording transport is the only sink for non-pretty tests.
function makeAdapter(config: JsonObject, options?: { keepDefaultTransports?: boolean; }) {
  return nodeAdapter(
    config,
    { FLARE_MODE: "test" },
    options?.keepDefaultTransports ? {} : { defaultLoggerTransports: [] },
  );
}

function newTestHost(adapter: ReturnType<typeof nodeAdapter>) {
  const host = new FlareHost(adapter);
  registerMinimalPingRoute(host);
  return host;
}

// Primary Behavior

describe("Primary Behavior", () => {
  afterEach(() => {
    resetRecords();
  });

  it("error(err, msg) produces a record with level=error, the context message, and a normalized error field", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      const cause = new Error("boom");
      host.logger.error(cause, "context message");

      const rec = RecordingTransport.records.find((r) => r.message === "context message");
      expect(rec).toBeDefined();
      expect(rec!.level).toBe("error");
      expect(rec!.message).toBe("context message");
      expect(rec!.error).toBeDefined();
      expect(rec!.error!.name).toBe("Error");
      expect(rec!.error!.message).toBe("boom");
      expect(typeof rec!.error!.stack).toBe("string");
    } finally {
      await app.stop();
    }
  });

  it("fatal(err, msg) produces a record with level=fatal and the same error normalization", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      const cause = new Error("boom");
      host.logger.fatal(cause, "context message");

      const rec = RecordingTransport.records.find((r) => r.message === "context message");
      expect(rec).toBeDefined();
      expect(rec!.level).toBe("fatal");
      expect(rec!.message).toBe("context message");
      expect(rec!.error).toBeDefined();
      expect(rec!.error!.name).toBe("Error");
      expect(rec!.error!.message).toBe("boom");
      expect(typeof rec!.error!.stack).toBe("string");
    } finally {
      await app.stop();
    }
  });

  it("renders the pretty-mode error block with the error name in the title and the error message in the first row", async () => {
    // Pretty-mode rendering goes through ConsoleTransport via console.error.
    // Intercept the console output and assert on the rendered string.
    const adapter = makeAdapter({
      host: {
        // 'development' env triggers pretty format by default.
        env: "development",
      },
      log: { level: "info" },
    }, { keepDefaultTransports: true });
    const host = newTestHost(adapter);
    const app = await host.build().test();
    try {
      const captured: string[] = [];
      const originalError = console.error;
      console.error = (line?: unknown) => {
        captured.push(String(line));
      };
      try {
        host.logger.error(new TypeError("pretty boom"), "while rendering");
      } finally {
        console.error = originalError;
      }

      // Find the rendered block produced by ConsoleTransport for this call.
      const block = captured.find((line) => line.includes("while rendering")) ?? "";
      const plain = stripAnsi(block);
      expect(plain).toContain("while rendering");
      // Title row contains the error name.
      expect(plain).toContain("TypeError");
      // The first row of the framed block contains the error message.
      // ConsoleTransport renders that row as:  "│  <error.message>"
      expect(plain).toMatch(/│\s+pretty boom/);
      // Sanity: ConsoleTransport must be one of the registered transports.
      expect(host.logger).toBeDefined();
      expect(ConsoleTransport.transportName).toBe("console");
    } finally {
      await app.stop();
    }
  });
});

// Edge Cases

describe("Edge Cases", () => {
  afterEach(() => {
    resetRecords();
  });

  it("error(new TypeError('x'), 'msg') carries error.name === 'TypeError' through to the transport", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      host.logger.error(new TypeError("x"), "msg");

      const rec = RecordingTransport.records.find((r) => r.message === "msg");
      expect(rec).toBeDefined();
      expect(rec!.error).toBeDefined();
      expect(rec!.error!.name).toBe("TypeError");
      expect(rec!.error!.message).toBe("x");
    } finally {
      await app.stop();
    }
  });

  it("error(err) with no message defaults to 'Error'; fatal(err) defaults to 'Fatal error'", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      const errCause = new Error("e-cause");
      const fatalCause = new Error("f-cause");
      // No-message overloads — the second arg is omitted entirely so the
      // implementation's default-message branch (lines 125 / 140 of logger.ts)
      // is exercised. The public overloads require a message arg, so we cast
      // through the single-arg shape to reach the runtime path that fills in
      // the default ("Error" / "Fatal error").
      (host.logger.error as (e: unknown) => void)(errCause);
      (host.logger.fatal as (e: unknown) => void)(fatalCause);

      const errRec = RecordingTransport.records.find((r) => r.level === "error" && r.error?.message === "e-cause");
      const fatalRec = RecordingTransport.records.find((r) => r.level === "fatal" && r.error?.message === "f-cause");

      expect(errRec).toBeDefined();
      expect(errRec!.message).toBe("Error");
      expect(fatalRec).toBeDefined();
      expect(fatalRec!.message).toBe("Fatal error");
    } finally {
      await app.stop();
    }
  });

  it("error(undefined, 'msg') produces error: { message: 'undefined' }", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      (host.logger.error as (e: unknown, m: string) => void)(undefined, "msg");

      const rec = RecordingTransport.records.find((r) => r.message === "msg" && r.error?.message === "undefined");
      expect(rec).toBeDefined();
      expect(rec!.error).toEqual({ message: "undefined" });
    } finally {
      await app.stop();
    }
  });

  it("error({ foo: 1 }, 'msg') for a non-Error object produces error: { message: '[object Object]' }", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      (host.logger.error as (e: unknown, m: string) => void)({ foo: 1 }, "msg");

      const rec = RecordingTransport.records.find(
        (r) => r.message === "msg" && r.error?.message === "[object Object]",
      );
      expect(rec).toBeDefined();
      expect(rec!.error).toEqual({ message: "[object Object]" });
    } finally {
      await app.stop();
    }
  });
});

// Failure Modes

describe("Failure Modes", () => {
  afterEach(() => {
    resetRecords();
  });

  it("error('just a message') with the 1-arg string form routes through the message-only branch and does NOT attach an error field", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      host.logger.error("just a message");

      const rec = RecordingTransport.records.find((r) => r.message === "just a message");
      expect(rec).toBeDefined();
      expect(rec!.level).toBe("error");
      // Documented sharp edge: the typeof === "string" guard claims this call
      // for the message-only branch even though the value could ambiguously
      // have been a thrown string.
      expect(rec!.error).toBeUndefined();
      expect("error" in rec!).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it("overload disambiguation: error(someString, someString) treats the first string as the message (documented sharp edge)", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      const someStringVariable: string = "looks-like-error";
      // Two strings — the typeof check picks the message-only branch using
      // the first string as the message. The second string is then treated
      // as meta and discarded by Logger (LogMeta is an object).
      (host.logger.error as (a: unknown, b: unknown) => void)(someStringVariable, someStringVariable);

      const rec = RecordingTransport.records.find((r) => r.message === "looks-like-error");
      expect(rec).toBeDefined();
      // First arg becomes the message; no error field attached.
      expect(rec!.message).toBe("looks-like-error");
      expect(rec!.error).toBeUndefined();
    } finally {
      await app.stop();
    }
  });
});

// Cross-Feature Interactions

describe("Cross-Feature Interactions", () => {
  afterEach(() => {
    resetRecords();
  });

  it("pretty-mode ConsoleTransport renders the structured error block for an error record (logger/console-transport)", async () => {
    const adapter = makeAdapter({
      host: { env: "development" },
      log: { level: "info" },
    }, { keepDefaultTransports: true });
    const host = newTestHost(adapter);
    const app = await host.build().test();
    try {
      const captured: string[] = [];
      const originalError = console.error;
      console.error = (line?: unknown) => {
        captured.push(String(line));
      };
      try {
        host.logger.error(new Error("structured"), "wrap");
      } finally {
        console.error = originalError;
      }

      const block = captured.find((line) => line.includes("wrap")) ?? "";
      const plain = stripAnsi(block);
      // Console-transport pretty error block: top rule, message row, bottom rule.
      expect(plain).toMatch(/┌─\s+Error/);
      expect(plain).toMatch(/│\s+structured/);
      expect(plain).toMatch(/└─+/);
    } finally {
      await app.stop();
    }
  });

  it("an error record emitted inside loggerALS.run carries both context and the error field (logger/request-context)", async () => {
    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info", enableContext: true },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      const ctx: LogContext = {
        source: "flare:http",
        requestId: "rid-err-1",
        method: "POST",
        url: "/things",
      };
      loggerALS.run({ context: ctx, state: { tenantId: "t-1" } }, () => {
        host.logger.error(new Error("inside-als"), "with-ctx");
      });

      const rec = RecordingTransport.records.find((r) => r.message === "with-ctx");
      expect(rec).toBeDefined();
      expect(rec!.level).toBe("error");
      expect(rec!.context).toEqual(ctx);
      expect(rec!.state).toEqual({ tenantId: "t-1" });
      expect(rec!.error).toBeDefined();
      expect(rec!.error!.name).toBe("Error");
      expect(rec!.error!.message).toBe("inside-als");
      expect(typeof rec!.error!.stack).toBe("string");
    } finally {
      await app.stop();
    }
  });

  it("toErrorField is the same normalizer used by the host's last-resort error reporting (shape consistency)", async () => {
    // The host uses `toErrorField` directly when reporting build failures via
    // `_log("fatal", "...", { error: toErrorField(err) })` (see flare-host.ts).
    // The logger applies the same normalizer when assembling record.error.
    // Verify the exported normalizer produces an identical shape to what the
    // logger attaches to a record for the same input — this is the shared
    // fixture the spec calls for.
    const cause = new Error("shared");
    const directNormalization = toErrorField(cause);

    const adapter = makeAdapter({
      host: { env: "test" },
      log: { level: "info" },
    });
    const host = newTestHost(adapter);
    host.logging.transport(RecordingTransport);
    const app = await host.build().test();
    try {
      resetRecords();
      host.logger.error(cause, "via-logger");
      const rec = RecordingTransport.records.find((r) => r.message === "via-logger");
      expect(rec).toBeDefined();
      // Logger normalization is structurally identical to the exported function.
      expect(rec!.error).toEqual(directNormalization);
      // And specifically: name, message, and stack carry through identically.
      expect(rec!.error!.name).toBe(directNormalization.name);
      expect(rec!.error!.message).toBe(directNormalization.message);
      expect(rec!.error!.stack).toBe(directNormalization.stack);
    } finally {
      await app.stop();
    }
  });
});
