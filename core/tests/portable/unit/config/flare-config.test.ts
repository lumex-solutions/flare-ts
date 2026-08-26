/** Unit tests for flareConfig schema validation and descriptor parsing. */
import { describe, expect, it } from "vitest";
import { schema } from "@flare-ts/lib";
import { int, str } from "@flare-ts/lib/schema";
import { flareConfig, type LogConfig, HOST_CONFIG, LOG_CONFIG } from "../../../../src/lib/config/flare-config.js";

/**
 * Pulls a single descriptor entry as a runtime `(v: string) => unknown`
 * parser, asserting the entry exists. The descriptor record is typed with an
 * index signature, so under `noUncheckedIndexedAccess` each lookup is
 * `... | undefined`; this helper narrows it for direct invocation.
 */
function field(
  descriptor: Readonly<Record<string, unknown>> | undefined,
  key: string,
): (v: string) => unknown {
  expect(descriptor).toBeDefined();
  const entry = descriptor![key];
  expect(typeof entry).toBe("function");
  return entry as (v: string) => unknown;
}

describe("flareConfig", () => {
  it("returns an object whose key equals the argument and whose descriptor is the same reference passed in", () => {
    const descriptor = { url: str, port: int };
    const token = flareConfig("db", descriptor);

    expect(token.key).toBe("db");
    expect(token.descriptor).toBe(descriptor);
  });

  it("preserves a single-field descriptor on the returned token", () => {
    const token = flareConfig("solo", { name: str });

    expect(token.descriptor).toBeDefined();
    expect(token.descriptor && Object.keys(token.descriptor)).toEqual(["name"]);
    expect(token.descriptor?.name).toBe(str);
  });

  it("accepts descriptors mixing TypedPrimitive and SchemaToken values and infers both branches", () => {
    const nested = schema({ host: str, port: int });
    const token = flareConfig("mixed", { id: int, meta: nested });

    expect(token.descriptor?.id).toBe(int);
    expect(token.descriptor?.meta).toBe(nested);
  });

  it("returns { key, descriptor: {} } when an empty descriptor object is supplied (not the no-descriptor branch)", () => {
    const token = flareConfig("empty", {});

    expect(token.key).toBe("empty");
    expect(token).toHaveProperty("descriptor");
    expect(token.descriptor).toEqual({});
  });

  it("returns a plain object with no prototype methods beyond Object.prototype", () => {
    const token = flareConfig("plain", { url: str });

    expect(Object.getPrototypeOf(token)).toBe(Object.prototype);
    expect(token.toString).toBe(Object.prototype.toString);
  });
});

describe("HOST_CONFIG", () => {
  it("declares every HostConfig field that has a runtime default", () => {
    expect(HOST_CONFIG.descriptor).toBeDefined();
    const fields = Object.keys(HOST_CONFIG.descriptor!).sort();

    expect(fields).toEqual(
      [
        "env",
        "port",
        "host",
        "shutdownTimeout",
        "maxBodyBytes",
        "requestIdHeader",
        "requestTiming",
        "keepAliveTimeout",
        "headersTimeout",
        "requestTimeout",
      ].sort(),
    );
  });

  it("each descriptor field is a defaultTo-wrapped primitive that yields the documented default when fed an empty string", () => {
    // defaultTo wraps a primitive so empty-string input returns the fallback.
    // Exercising each descriptor entry with "" recovers the documented default.
    const d = HOST_CONFIG.descriptor;

    expect(field(d, "env")("")).toBe("development");
    expect(field(d, "port")("")).toBe(3000);
    expect(field(d, "host")("")).toBe("localhost");
    expect(field(d, "shutdownTimeout")("")).toBe(10000);
    expect(field(d, "maxBodyBytes")("")).toBe(2 * 1024 * 1024);
    expect(field(d, "requestIdHeader")("")).toBe(true);
    expect(field(d, "requestTiming")("")).toBe(false);
    expect(field(d, "keepAliveTimeout")("")).toBe(65000);
    expect(field(d, "headersTimeout")("")).toBe(60000);
    expect(field(d, "requestTimeout")("")).toBe(300000);
  });
});

describe("LOG_CONFIG", () => {
  it("declares the five log-config fields: level, format, enableContext, unhandledErrors, transports", () => {
    expect(LOG_CONFIG.descriptor).toBeDefined();
    const fields = Object.keys(LOG_CONFIG.descriptor!).sort();

    expect(fields).toEqual(["enableContext", "format", "level", "transports", "unhandledErrors"]);
  });

  it("yields documented defaults when each scalar descriptor entry is parsed with an empty string", () => {
    const d = LOG_CONFIG.descriptor;

    expect(field(d, "level")("")).toBe("info");
    expect(field(d, "format")("")).toBe("json");
    expect(field(d, "enableContext")("")).toBe(false);
    expect(field(d, "unhandledErrors")("")).toBe(true);
  });

  it("accepts every LogLevel value for `level` and rejects unknown levels via the enums parser", () => {
    const level = field(LOG_CONFIG.descriptor, "level");

    for (const ok of ["trace", "debug", "info", "warn", "error", "fatal"]) {
      expect(level(ok)).toBe(ok);
    }

    expect(() => level("verbose")).toThrow(
      'Expected one of [trace, debug, info, warn, error, fatal], got "verbose"',
    );
  });

  it('rejects format values other than "pretty" or "json"', () => {
    const format = field(LOG_CONFIG.descriptor, "format");

    expect(format("pretty")).toBe("pretty");
    expect(format("json")).toBe("json");
    expect(() => format("ndjson")).toThrow('Expected one of [pretty, json], got "ndjson"');
  });

  it("treats transports as optional and accepts a record of { <name>: { level } } entries", () => {
    // The transports field is a record-of-schema marked .optional(); to confirm
    // its parser-level shape we drive LOG_CONFIG through a flat schema with the
    // same descriptor so we can call safeParse on the full section.
    const sectionSchema = schema(LOG_CONFIG.descriptor!);

    const empty = sectionSchema.safeParse({});
    expect(empty.success).toBe(true);
    if (empty.success) {
      const data = empty.data as unknown as LogConfig;
      expect(data.transports).toBeUndefined();
      expect(data.level).toBe("info");
      expect(data.format).toBe("json");
      expect(data.enableContext).toBe(false);
    }

    const withTransports = sectionSchema.safeParse({
      transports: {
        console: { level: "warn" },
        file: { level: "error" },
      },
    });
    expect(withTransports.success).toBe(true);
    if (withTransports.success) {
      const data = withTransports.data as unknown as LogConfig;
      expect(data.transports?.console?.level).toBe("warn");
      expect(data.transports?.file?.level).toBe("error");
    }
  });
});
