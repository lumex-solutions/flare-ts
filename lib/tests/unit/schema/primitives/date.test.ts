/**
 * Unit tests for the date primitive: ISO parsing, custom formats, and jsonSchema emission.
 */
import { describe, expect, it } from "vitest";
import { date } from "../../../../src/schema/primitives/date.js";

describe("date (default ISO format)", () => {
  it("parses '2024-03-22' to Date at UTC midnight", () => {
    const d = date("2024-03-22");
    expect(d.getTime()).toBe(Date.UTC(2024, 2, 22, 0, 0, 0, 0));
  });

  it("parses full ISO 8601 with time + Z", () => {
    const d = date("2024-03-22T14:30:00Z");
    expect(d.getTime()).toBe(Date.UTC(2024, 2, 22, 14, 30, 0, 0));
  });

  it("parses ISO with timezone offset +02:00", () => {
    const d = date("2024-03-22T14:30:00+02:00");
    // 14:30 at +02:00 is 12:30 UTC
    expect(d.getTime()).toBe(Date.UTC(2024, 2, 22, 12, 30, 0, 0));
  });

  it("throws 'Invalid ISO date: \"<raw>\"' on malformed input", () => {
    expect(() => date("not-a-date")).toThrow('Invalid ISO date: "not-a-date"');
  });
});

describe("DMY date format parsing", () => {
  it("parses '22/03/2024', '22-03-2024', '22.03.2024'", () => {
    const dmy = date.format("DMY");
    const expected = Date.UTC(2024, 2, 22);
    expect(dmy("22/03/2024").getTime()).toBe(expected);
    expect(dmy("22-03-2024").getTime()).toBe(expected);
    expect(dmy("22.03.2024").getTime()).toBe(expected);
  });

  it("parses compact '22032024'", () => {
    const dmy = date.format("DMY");
    expect(dmy("22032024").getTime()).toBe(Date.UTC(2024, 2, 22));
  });

  it("normalizes two-digit year '22/03/24' to 2024", () => {
    const dmy = date.format("DMY");
    expect(dmy("22/03/24").getTime()).toBe(Date.UTC(2024, 2, 22));
  });

  it("throws on invalid day (32)", () => {
    const dmy = date.format("DMY");
    expect(() => dmy("32/03/2024")).toThrow('Invalid DMY date: "32/03/2024"');
  });

  it("throws on invalid month (13)", () => {
    const dmy = date.format("DMY");
    expect(() => dmy("01/13/2024")).toThrow('Invalid DMY date: "01/13/2024"');
  });

  it("throws on invalid calendar date via round-trip (31 Feb)", () => {
    const dmy = date.format("DMY");
    expect(() => dmy("31/02/2024")).toThrow('Invalid DMY date: "31/02/2024"');
  });
});

describe("MDY date format parsing", () => {
  it("parses '03/22/2024' with month first", () => {
    const mdy = date.format("MDY");
    expect(mdy("03/22/2024").getTime()).toBe(Date.UTC(2024, 2, 22));
  });

  it("throws 'Invalid MDY date' on malformed input", () => {
    const mdy = date.format("MDY");
    expect(() => mdy("not-a-date")).toThrow('Invalid MDY date: "not-a-date"');
  });

  it("throws on invalid calendar date (30 Feb)", () => {
    const mdy = date.format("MDY");
    expect(() => mdy("02/30/2024")).toThrow('Invalid MDY date: "02/30/2024"');
  });
});

describe("YMD date format parsing", () => {
  it("parses separator and compact forms", () => {
    const ymd = date.format("YMD");
    const expected = Date.UTC(2024, 2, 22);
    expect(ymd("2024/03/22").getTime()).toBe(expected);
    expect(ymd("2024-03-22").getTime()).toBe(expected);
    expect(ymd("2024.03.22").getTime()).toBe(expected);
    expect(ymd("20240322").getTime()).toBe(expected);
  });

  it("rejects out-of-range day/month via round-trip check", () => {
    const ymd = date.format("YMD");
    expect(() => ymd("2024-13-01")).toThrow('Invalid YMD date: "2024-13-01"');
    expect(() => ymd("2024-02-30")).toThrow('Invalid YMD date: "2024-02-30"');
  });
});

describe("TIMESTAMP epoch date parsing", () => {
  it("parses 10-digit (seconds), 13-digit (ms), 16-digit (microseconds)", () => {
    const ts = date.format("TIMESTAMP");
    // 2024-03-22T00:00:00Z = 1711065600 seconds
    const seconds = 1711065600;
    const millis = seconds * 1000;
    const micros = millis * 1000;
    expect(ts(String(seconds)).getTime()).toBe(millis);
    expect(ts(String(millis)).getTime()).toBe(millis);
    expect(ts(String(micros)).getTime()).toBe(millis);
  });

  it("throws on any other digit length", () => {
    const ts = date.format("TIMESTAMP");
    expect(() => ts("12345")).toThrow('Invalid TIMESTAMP date: "12345"');
    expect(() => ts("12345678901")).toThrow('Invalid TIMESTAMP date: "12345678901"');
    expect(() => ts("123456789012")).toThrow('Invalid TIMESTAMP date: "123456789012"');
  });

  it("trims surrounding whitespace before parsing", () => {
    const ts = date.format("TIMESTAMP");
    expect(ts(" 1711065600 ").getTime()).toBe(1711065600 * 1000);
  });
});

describe("date format builder metadata", () => {
  it("date.format(k) returns a new primitive without mutating date", () => {
    const originalFormat = date._format;
    const dmy = date.format("DMY");
    expect(dmy).not.toBe(date);
    expect(date._format).toBe(originalFormat);
  });

  it("_format records the active format key", () => {
    expect(date._format).toBe("ISO");
    expect(date.format("DMY")._format).toBe("DMY");
    expect(date.format("MDY")._format).toBe("MDY");
    expect(date.format("YMD")._format).toBe("YMD");
    expect(date.format("TIMESTAMP")._format).toBe("TIMESTAMP");
  });

  it("jsonSchema differs by format (ISO -> date-time, YMD -> date, others -> string)", () => {
    expect(date.jsonSchema).toEqual({ type: "string", format: "date-time" });
    expect(date.format("YMD").jsonSchema).toEqual({ type: "string", format: "date" });
    expect(date.format("DMY").jsonSchema).toEqual({ type: "string" });
    expect(date.format("MDY").jsonSchema).toEqual({ type: "string" });
    expect(date.format("TIMESTAMP").jsonSchema).toEqual({ type: "string" });
  });
});
